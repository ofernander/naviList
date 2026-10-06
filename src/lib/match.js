'use strict';

/**
 * match.js — the one matcher: external { artist, title, mbid } → local track id
 *
 * Automatic layers, in order:
 *   1. recording MBID  — tracks.mbid, the exact recording
 *   2. exact           — lowercase artist|||title
 *   3. normalized      — accents, apostrophes and punctuation folded
 *   4. artist alias    — async, via MusicBrainz, only when the source supplies an
 *                        artist MBID and the artist name isn't in the library
 * Fuzzy scoring is never automatic: matcher.review() offers ranked candidates
 * for the user to confirm (file import).
 *
 * Every layer collapses several library copies of one song to the studio copy.
 * With excludeLive (the default) a live-only result counts as no match; ingestion
 * passes excludeLive:false so scrobbles stay factual.
 */

const mb     = require('../providers/musicbrainz');
const logger = require('../utils/logger');
const { ensureLiveStatus, pickStudioCandidate, resolveCandidateMap, isLiveTrack } = require('./studio');

// ── Keys ──────────────────────────────────────────────────────────────────────

function exactKey(artist, title) {
  return `${(artist||'').toLowerCase().trim()}|||${(title||'').toLowerCase().trim()}`;
}

function normalizeForSearch(value) {
  return (value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')   // strip accents (NFKD combining marks)
    .replace(/['’‘`]/g, '')           // drop apostrophes: "Don't" → "dont"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normKey(artist, title) {
  return `${normalizeForSearch(artist)}|||${normalizeForSearch(title)}`;
}

// ── Library index ─────────────────────────────────────────────────────────────

// Group every library track by exact key, normalized key and recording MBID.
// Candidate objects are shared across the maps, so a live-status lookup on one
// is seen by all. Cheap, no network.
function buildIndex(db) {
  const rows    = db.prepare('SELECT id, artist, title, album, duration, mbid, is_live FROM tracks').all();
  const exact   = new Map();
  const norm    = new Map();
  const byMbid  = new Map();
  const artists = new Set();
  const push = (map, k, c) => { if (!map.has(k)) map.set(k, []); map.get(k).push(c); };
  for (const r of rows) {
    const cand = { id: r.id, artist: r.artist, title: r.title, album: r.album, duration: r.duration, mbid: r.mbid, is_live: r.is_live };
    push(exact, exactKey(r.artist, r.title), cand);
    push(norm,  normKey(r.artist, r.title),  cand);
    if (r.mbid)   push(byMbid, r.mbid, cand);
    if (r.artist) artists.add(r.artist.toLowerCase().trim());
  }
  return { exact, norm, byMbid, artists };
}

// Synchronous matcher — cached live status + heuristic only, never fetches.
function buildMatcher(db, opts = {}) {
  return createMatcher(db, buildIndex(db), opts);
}

// Matcher for playlist builds. Looks up MB live status (by recording id) ONLY for
// the same-song collisions the given items reference — bounded to the playlist,
// never the library. items: array of { artist, title }.
async function buildMatcherWarmed(db, items, opts = {}) {
  const index = buildIndex(db);
  const seen  = new Set();
  for (const it of items || []) {
    const k = normKey(it.artist, it.title);   // normalized group ⊇ exact group
    if (seen.has(k)) continue;
    seen.add(k);
    const cands = index.norm.get(k);
    if (cands && cands.length > 1) await ensureLiveStatus(db, cands);
  }
  return createMatcher(db, index, opts);
}

function createMatcher(db, index, { excludeLive = true } = {}) {
  const exact = resolveCandidateMap(db, index.exact, { excludeLive });
  const norm  = resolveCandidateMap(db, index.norm,  { excludeLive });
  let tokens  = null;   // fuzzy token index, built on first review()

  // A live recording referenced by MBID falls through to the title layers,
  // which pick the studio copy of the same song.
  function byMbid(mbid) {
    const cands = mbid ? index.byMbid.get(mbid) : null;
    if (!cands) return null;
    const id     = pickStudioCandidate(db, cands);
    const chosen = cands.find(c => c.id === id);
    if (excludeLive && chosen && isLiveTrack(chosen)) return null;
    return id;
  }

  function match({ artist, title, mbid } = {}) {
    return byMbid(mbid) || exact.get(exactKey(artist, title)) || norm.get(normKey(artist, title)) || null;
  }

  async function matchWithAliases(row = {}) {
    const id = match(row);
    if (id || !row.artistMbid) return id;
    const alias = await resolveArtistAlias(row.artist, row.artistMbid, index.artists);
    return alias ? match({ ...row, artist: alias }) : null;
  }

  // Layered match for user review: { status:'matched'|'normalized', id },
  // { status:'fuzzy', candidates:[{id,score}] } or { status:'unmatched' }.
  function review({ artist, title } = {}, minScore = FUZZY_MIN_SCORE) {
    const e = exact.get(exactKey(artist, title));
    if (e) return { status: 'matched', id: e };
    const n = norm.get(normKey(artist, title));
    if (n) return { status: 'normalized', id: n };
    if (!tokens) tokens = buildFuzzyTokens(exact);
    return fuzzyCandidates(artist, title, exact, tokens, minScore);
  }

  return { match, matchWithAliases, review };
}

// ── Artist aliases ────────────────────────────────────────────────────────────

// Session-level alias cache: artist_mbid → local artist name (or null if none).
const artistAliasCache = new Map();

// Name of the local artist a source artist maps to via MusicBrainz aliases, or
// null. Only consulted when the source name itself isn't in the library.
async function resolveArtistAlias(artistName, artistMbid, localArtists) {
  if (localArtists.has((artistName || '').toLowerCase().trim())) return null;
  if (artistAliasCache.has(artistMbid)) return artistAliasCache.get(artistMbid);
  try {
    const aliases = await mb.getArtistAliases(artistMbid);
    const hit = aliases.find(a => localArtists.has((a || '').toLowerCase().trim())) || null;
    if (hit) logger.info('match', `alias resolved: "${artistName}" → "${hit}" via MB`);
    else     logger.info('match', `alias miss for "${artistName}" (${artistMbid}) — no alias in library`);
    artistAliasCache.set(artistMbid, hit);
    return hit;
  } catch (e) {
    logger.warn('match', `alias lookup failed for "${artistName}" (${artistMbid}): ${e.message}`);
    return null;
  }
}

// ── Fuzzy review candidates ───────────────────────────────────────────────────
// Last-resort scoring for file imports whose metadata won't match. Targeted via
// a token index, so it scores a few dozen candidates, never the whole library.

const FUZZY_MIN_SCORE    = 80;   // default floor for a candidate to be offered (user-configurable)
const FUZZY_TOP_N        = 5;    // candidates shown in the review dropdown
const FUZZY_ARTIST_FLOOR = 50;   // artist must be at least this similar, or the candidate is vetoed regardless of title
const CONTAINMENT_MIN    = 0.75; // min proportion of the short title's significant tokens that must align contiguously
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'with', 'feat', 'ft']);

// Two-row Levenshtein — O(min(a,b)) space, no matrix allocation.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (a.length > b.length) { const t = a; a = b; b = t; }
  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    const cur = [j];
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + cost);
    }
    prev = cur;
  }
  return prev[a.length];
}

// Similarity 0-100 between two already-normalized strings (token overlap + edit).
function similarity(na, nb) {
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  const at = na.split(' ').filter(Boolean);
  const bt = nb.split(' ').filter(Boolean);
  const union  = new Set([...at, ...bt]).size;
  const shared = at.filter(x => bt.includes(x)).length;
  const tokenScore = union ? (shared / union) * 100 : 0;
  const maxLen = Math.max(na.length, nb.length);
  const editScore = maxLen ? ((maxLen - levenshtein(na, nb)) / maxLen) * 100 : 0;
  let score = Math.max(tokenScore, editScore * 0.8);
  if (na.startsWith(nb) || nb.startsWith(na)) score = Math.max(score, 82);
  return score;
}

// Significant tokens of an already-normalized string: drop stopwords and 1-char
// fillers ("i", "n", roman "i") that only add noise to containment.
function significantTokens(norm) {
  return norm.split(' ').filter(t => t.length > 1 && !STOPWORDS.has(t));
}

// Containment: does the SHORTER title appear (near-)verbatim as a contiguous run
// inside the longer one? Rescues "Rise N' Shine" ⊂ "…: I. Rise 'n Shine" that
// Jaccard under-scores, without rewarding scattered single-token coincidences.
// Slides a window (= short length) over the long token stream and takes the best
// positional overlap, so contiguity + order are required; one miss is tolerated
// only once titles are long enough that the ratio still clears CONTAINMENT_MIN.
function bestContiguousRatio(a, b) {
  let s = significantTokens(a), l = significantTokens(b);
  if (s.length > l.length) { const t = s; s = l; l = t; }   // s = shorter
  if (s.length < 2) return 0;                               // "not just one" — need ≥2 significant tokens
  let best = 0;
  for (let start = 0; start + s.length <= l.length; start++) {
    let m = 0;
    for (let i = 0; i < s.length; i++) if (s[i] === l[start + i]) m++;
    if (m > best) best = m;
  }
  return best / s.length;
}

// Title-only containment score (0 or ~76–78). Gated so wrong pairs stay at 0;
// the artist floor + weighting still decide whether a boosted title matches.
function containmentScore(a, b) {
  const ratio = bestContiguousRatio(a, b);
  if (ratio < CONTAINMENT_MIN) return 0;
  return 70 + 8 * ratio;   // 76 at ratio 0.75 → 78 at full containment
}

// Token → exact keys index over a resolved map (key → id). Live-excluded keys
// (value null) are skipped.
function buildFuzzyTokens(resolved) {
  const tokens = new Map();
  for (const [key, id] of resolved.entries()) {
    if (!id) continue;
    const [a, t] = key.split('|||');
    for (const tok of new Set(`${normalizeForSearch(a)} ${normalizeForSearch(t)}`.split(' ').filter(Boolean))) {
      if (!tokens.has(tok)) tokens.set(tok, new Set());
      tokens.get(tok).add(key);
    }
  }
  return tokens;
}

function fuzzyCandidates(artist, title, resolved, tokens, minScore) {
  const na = normalizeForSearch(artist), nt = normalizeForSearch(title);
  if (!na && !nt) return { status: 'unmatched' };
  const seen = new Set();
  for (const tok of new Set(`${na} ${nt}`.split(' ').filter(Boolean))) {
    const keys = tokens.get(tok);
    if (keys) for (const k of keys) seen.add(k);
  }
  const scored = [];
  for (const key of seen) {
    const id = resolved.get(key);
    if (!id) continue;
    const [ca, ct] = key.split('|||');
    const artistScore = similarity(na, normalizeForSearch(ca));
    if (na && artistScore < FUZZY_ARTIST_FLOOR) continue;   // veto right-title / wrong-artist
    const nCt = normalizeForSearch(ct);
    const titleScore = Math.max(similarity(nt, nCt), containmentScore(nt, nCt));
    const score = titleScore * 0.75 + artistScore * 0.25;
    if (score >= minScore) scored.push({ id, score: Math.round(score) });
  }
  if (!scored.length) return { status: 'unmatched' };
  scored.sort((x, y) => y.score - x.score);
  return { status: 'fuzzy', candidates: scored.slice(0, FUZZY_TOP_N) };
}

module.exports = {
  normalizeForSearch,
  buildMatcher,
  buildMatcherWarmed,
  FUZZY_MIN_SCORE,
};
