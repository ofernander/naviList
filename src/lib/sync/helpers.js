'use strict';

/**
 * sync/helpers.js — shared utilities for all sync modules
 *
 * No imports from other sync files — exists specifically to break the
 * circular dependency between index.js and the provider sync modules.
 */

const mb     = require('../../providers/musicbrainz');
const logger = require('../../utils/logger');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Build the in-memory candidate map from the library. Cheap, no network.
function buildCandidateMap(db) {
  const rows = db.prepare('SELECT id, artist, title, album, duration, mbid, is_live FROM tracks').all();
  const map  = new Map();   // key → candidate[]
  for (const r of rows) {
    const k = `${(r.artist||'').toLowerCase().trim()}|||${(r.title||'').toLowerCase().trim()}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ id: r.id, artist: r.artist, title: r.title, album: r.album, duration: r.duration, mbid: r.mbid, is_live: r.is_live });
  }
  return map;
}

// Synchronous matcher — heuristic + cached MB only, never fetches. Used by
// cache-feed syncs (top-tracks, loved) where MB precision isn't needed.
function buildMatchCacheLocal(db) {
  return resolveCandidateMap(db, buildCandidateMap(db), { excludeLive: true });
}

// On-demand matcher for playlist builds. Looks up MB live status (by recording id)
// ONLY for the same-title collisions the given items reference — a handful,
// bounded to the playlist, never the library. items: array of { artist, title }.
async function buildMatchCacheLocalWarmed(db, items) {
  const map  = buildCandidateMap(db);
  const seen = new Set();
  for (const it of items || []) {
    const a = (it.artist || '').toLowerCase().trim();
    const t = (it.title  || '').toLowerCase().trim();
    const k = `${a}|||${t}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const cands = map.get(k);
    if (!cands || cands.length < 2) continue;
    await ensureLiveStatus(db, cands);   // MB by recording id, cached on tracks
  }
  return resolveCandidateMap(db, map, { excludeLive: true });
}

function matchLocal(artist, title, cache) {
  const k = `${(artist||'').toLowerCase().trim()}|||${(title||'').toLowerCase().trim()}`;
  return cache.get(k) || null;
}

// ── Fuzzy import matching ──────────────────────────────────────────────────────
// Last-resort matcher for file imports whose metadata won't match exactly. The
// caller layers it: exact → normalized → fuzzy. Fuzzy is targeted via a token
// index, so it scores a few dozen candidates, never the whole library. It never
// changes matchLocal (that stays exact-only for all sync paths).

const FUZZY_MIN_SCORE    = 80;   // default floor for a candidate to be offered (user-configurable)
const FUZZY_TOP_N        = 5;    // candidates shown in the review dropdown
const FUZZY_ARTIST_FLOOR = 50;   // artist must be at least this similar, or the candidate is vetoed regardless of title
const CONTAINMENT_MIN    = 0.75; // min proportion of the short title's significant tokens that must align contiguously
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'with', 'feat', 'ft']);

function normalizeForSearch(value) {
  return (value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, "")   // strip accents (NFKD combining marks)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

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

// Build a token index + normalized-key map from a resolved cache (key → id).
// Cheap, once per import. Live-excluded keys (value null) are skipped.
function buildFuzzyIndex(cache) {
  const norm   = new Map();   // normalizedKey → original key
  const tokens = new Map();   // token → Set(original key)
  for (const [key, id] of cache.entries()) {
    if (!id) continue;
    const [a, t] = key.split('|||');
    const na = normalizeForSearch(a), nt = normalizeForSearch(t);
    if (!norm.has(`${na}|||${nt}`)) norm.set(`${na}|||${nt}`, key);
    for (const tok of new Set(`${na} ${nt}`.split(' ').filter(Boolean))) {
      if (!tokens.has(tok)) tokens.set(tok, new Set());
      tokens.get(tok).add(key);
    }
  }
  return { norm, tokens };
}

// Layered match for one import row against the cache + index. Returns
// { status:'matched'|'normalized', id }, { status:'fuzzy', candidates:[{id,score}] }
// (distinct songs, studio copy chosen later), or { status:'unmatched' }.
function resolveImportMatch(artist, title, cache, index, minScore = FUZZY_MIN_SCORE) {
  const exactKey = `${(artist||'').toLowerCase().trim()}|||${(title||'').toLowerCase().trim()}`;
  if (cache.get(exactKey)) return { status: 'matched', id: cache.get(exactKey) };

  const na = normalizeForSearch(artist), nt = normalizeForSearch(title);
  const nKey = index.norm.get(`${na}|||${nt}`);
  if (nKey && cache.get(nKey)) return { status: 'normalized', id: cache.get(nKey) };

  if (!na && !nt) return { status: 'unmatched' };
  const seen = new Set();
  for (const tok of new Set(`${na} ${nt}`.split(' ').filter(Boolean))) {
    const keys = index.tokens.get(tok);
    if (keys) for (const k of keys) seen.add(k);
  }
  const scored = [];
  for (const key of seen) {
    const id = cache.get(key);
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

// Session-level alias cache: artist_mbid → resolved local artist name
const artistAliasCache = new Map();

async function resolveArtistWithAliases(artistName, artistMbid, cache) {
  const nameLower = (artistName || '').toLowerCase().trim();

  if (artistMbid && artistAliasCache.has(artistMbid)) {
    logger.debug('sync', `alias cache hit: "${artistName}" (${artistMbid}) → "${artistAliasCache.get(artistMbid)}"`);
    return artistAliasCache.get(artistMbid);
  }

  const prefix = `${nameLower}|||`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      if (artistMbid) artistAliasCache.set(artistMbid, artistName);
      return artistName;
    }
  }

  if (!artistMbid) return artistName;

  try {
    const aliases = await mb.getArtistAliases(artistMbid);
    await sleep(1000);
    for (const alias of aliases) {
      const aliasLower  = alias.toLowerCase().trim();
      const aliasPrefix = `${aliasLower}|||`;
      for (const key of cache.keys()) {
        if (key.startsWith(aliasPrefix)) {
          logger.info('sync', `alias resolved: "${artistName}" → "${alias}" via MB`);
          artistAliasCache.set(artistMbid, alias);
          return alias;
        }
      }
    }
  } catch (e) {
    logger.warn('sync', `alias lookup failed for "${artistName}" (${artistMbid}): ${e.message}`);
    return artistName;
  }

  logger.info('sync', `alias miss for "${artistName}" (${artistMbid}) — no alias matched local cache`);
  artistAliasCache.set(artistMbid, artistName);
  return artistName;
}

function buildNaviTitle(lbTitle, sourcePatch) {
  // Generated playlists (have source_patch) include a date/user suffix we strip
  // so the ND playlist name stays stable across rotations.
  // e.g. "Daily Jams for m0zer, 2026-04-18 Sat" → "Daily Jams for m0zer"
  const cleaned = sourcePatch ? lbTitle.split(', ')[0] : lbTitle;
  return `ListenBrainz — ${cleaned}`;
}

// LFM chart playlist titles in Navidrome
const LFM_CHART_TITLES = {
  weekly:      'Last.FM \u2014 Last.week',
  top_7day:    'Last.FM \u2014 Top Tracks (7 Days)',
  top_1month:  'Last.FM \u2014 Top Tracks (1 Month)',
  top_3month:  'Last.FM \u2014 Top Tracks (3 Months)',
  top_6month:  'Last.FM \u2014 Top Tracks (6 Months)',
  top_12month: 'Last.FM \u2014 Top Tracks (12 Months)',
  top_overall: 'Last.FM \u2014 Top Tracks (All Time)',
};

function buildLfmTitle(lfmId) {
  return LFM_CHART_TITLES[lfmId] || `Last.FM \u2014 ${lfmId}`;
}

function buildLfmSnapshotTitle(lfmId) {
  const base = LFM_CHART_TITLES[lfmId] || `Last.FM \u2014 ${lfmId}`;
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${base} \u2014 ${date}`;
}

const detachedRunning = new Set();
function runDetached(name, fn) {
  if (detachedRunning.has(name)) {
    logger.warn('sync', `${name} already running — skipping`);
    return;
  }
  detachedRunning.add(name);
  fn().catch(e => logger.error('sync', `${name} threw: ${e.message}`)).finally(() => detachedRunning.delete(name));
}

function writeMissingArtists(db, artistNames, source) {
  const isInLibrary = db.prepare('SELECT 1 FROM tracks WHERE LOWER(artist) = LOWER(?) LIMIT 1');
  const insert      = db.prepare(`
    INSERT OR IGNORE INTO missing_artists (artist_name, source, status, added_at)
    VALUES (?, ?, 'pending', ?)
  `);
  const now = Math.floor(Date.now() / 1000);
  let added = 0;
  db.transaction(names => {
    for (const name of names) {
      if (!name || isInLibrary.get(name)) continue;
      insert.run(name, source, now);
      added++;
    }
  })(artistNames);
  if (added > 0) logger.info('sync', `missing_artists: ${added} new entries from ${source}`);
  return added;
}

// ── Studio/live disambiguation ────────────────────────────────────────────────
// When several library copies of a song collide, prefer the studio recording.
// Free local title/album heuristic first; the authoritative signal is each copy's
// MusicBrainz recording id (tracks.mbid → live?), looked up on demand and cached
// on the track (tracks.is_live).

// Local title/album heuristic — no network. Catches the common "(Live)" cases.
const LIVE_RE = /\b(live|unplugged|bootleg|in concert)\b/i;
function looksLive(track) {
  return LIVE_RE.test(track.title || '') || LIVE_RE.test(track.album || '');
}

// Authoritative when MB has confirmed it (tracks.is_live 0/1); heuristic otherwise.
function isLiveTrack(track) {
  if (track.is_live === 1) return true;
  if (track.is_live === 0) return false;   // MB-confirmed studio overrides text
  return looksLive(track);
}

/**
 * Fill tracks.is_live for candidate copies whose status is unknown, by looking up
 * each copy's MusicBrainz recording id. Persists to the track so it's never looked
 * up again. On-demand only — call for a collision's candidates, not the library.
 */
async function ensureLiveStatus(db, candidates) {
  // Persist by recording MBID so every library copy of the same recording is
  // filled from a single lookup — multiple copies share one recording id.
  const setByMbid = db.prepare('UPDATE tracks SET is_live = ? WHERE mbid = ?');
  const seen = new Map();   // mbid → is_live resolved this call
  for (const c of candidates) {
    if (c.is_live === 0 || c.is_live === 1) continue;   // already known
    if (!c.mbid) continue;                               // no MBID → heuristic handles it
    if (seen.has(c.mbid)) { c.is_live = seen.get(c.mbid); continue; }   // same recording
    try {
      const val = (await mb.getRecordingIsLive(c.mbid)) ? 1 : 0;
      seen.set(c.mbid, val);
      c.is_live = val;
      setByMbid.run(val, c.mbid);   // fills all copies of this recording, library-wide
      logger.debug('match', `MB recording ${c.mbid} "${c.artist} - ${c.title}": ${val ? 'live' : 'studio'}`);
    } catch (e) {
      logger.warn('match', `MB recording ${c.mbid} lookup failed: ${e.message}`);
    }
  }
}

/**
 * Remove live tracks (title/album heuristic) from an array of track ids.
 * Used by the generation engine so rules/radio playlists stay studio-only.
 * Manual playlists never reach the engine, so hand-picked live cuts are kept.
 */
function filterLiveIds(db, ids) {
  if (!ids || !ids.length) return ids;
  const get = db.prepare('SELECT title, album, is_live FROM tracks WHERE id = ?');
  return ids.filter(id => { const t = get.get(id); return !t || !isLiveTrack(t); });
}

/**
 * Collapse a generated track pool to studio picks. Groups ids by artist+title,
 * and for each song picks the studio copy (heuristic + cached MB) — deduping
 * multiple library copies of the same song down to one studio release — and
 * drops all-live groups. Preserves first-seen order. This is the generation-path
 * equivalent of the match-path disambiguation, so radio/rules pick the studio
 * album when the library holds several copies of a track.
 */
async function filterStudioPool(db, ids) {
  if (!ids || !ids.length) return ids;
  const get = db.prepare('SELECT id, artist, title, album, duration, mbid, is_live FROM tracks WHERE id = ?');
  const groups = new Map();   // key → candidate[]
  const order  = [];
  for (const id of ids) {
    const t = get.get(id);
    if (!t) continue;
    const k = `${(t.artist||'').toLowerCase().trim()}|||${(t.title||'').toLowerCase().trim()}`;
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k).push(t);
  }
  // Fast path: cached is_live + heuristic only, NO fetch — keeps preview/save
  // snappy. The authoritative by-MBID lookup runs post-save in refineStudioPicks.
  const out = [];
  for (const k of order) {
    const cands    = groups.get(k);
    const chosenId = cands.length === 1 ? cands[0].id : pickStudioCandidate(db, cands);
    const chosen   = cands.find(c => c.id === chosenId);
    if (chosen && isLiveTrack(chosen)) continue;   // all-live / live pick → exclude
    out.push(chosenId);
  }
  return out;
}

/**
 * Post-save pass over a saved playlist's track ids: for any track with other
 * library copies of the same song, look up MB live status by recording id (if not
 * already known) and swap to the studio copy. Bounded to the playlist's tracks;
 * caches to tracks.is_live. Run detached after save so preview/save stay fast.
 */
async function refineStudioPicks(db, trackIds) {
  if (!trackIds || !trackIds.length) return trackIds;
  const getT = db.prepare('SELECT id, artist, title, album, duration, mbid, is_live FROM tracks WHERE id = ?');
  const sibs = db.prepare('SELECT id, artist, title, album, duration, mbid, is_live FROM tracks WHERE LOWER(artist) = LOWER(?) AND LOWER(title) = LOWER(?)');
  const out = [];
  for (const id of trackIds) {
    const t = getT.get(id);
    if (!t) { out.push(id); continue; }
    const cands = sibs.all(t.artist, t.title);
    if (cands.length <= 1) { out.push(id); continue; }
    await ensureLiveStatus(db, cands);
    out.push(pickStudioCandidate(db, cands) || id);
  }
  return out;
}

/**
 * Given >=1 candidate copies of the same song, return the id of the studio one.
 * Prefers a MB-confirmed studio copy (is_live=0), drops MB-confirmed live copies
 * (is_live=1), and falls back to the title/album heuristic for anything still
 * unknown. Never returns null when candidates exist — re-ranked, never lost.
 */
function pickStudioCandidate(db, candidates) {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0].id;

  // 1. Authoritative: a MB-confirmed studio copy wins outright.
  const knownStudio = candidates.find(c => c.is_live === 0);
  if (knownStudio) return knownStudio.id;

  // 2. Drop MB-confirmed live copies, then apply the heuristic to what's left.
  const working = candidates.filter(c => c.is_live !== 1);
  const pool    = working.length ? working : candidates;
  const nonLive = pool.filter(c => !looksLive(c));
  return (nonLive[0] || pool[0]).id;
}

/**
 * Collapse a key→candidate[] map to key→studio-preferred id. Resolves each
 * collision from cached MB data + heuristic immediately, and fires a detached,
 * rate-limited MB warm for any uncached collisions so the next build is precise.
 * Never blocks; single-candidate keys pass straight through (current behavior).
 */
// Collapse key→candidate[] to key→studio-preferred id, using ONLY the local
// heuristic + already-cached MB data (never fetches). MB is fetched on demand
// by buildMatchCacheLocalWarmed, scoped to a playlist's own tracks.
function resolveCandidateMap(db, map, opts = {}) {
  const excludeLive = opts.excludeLive || false;
  const resolved = new Map();
  for (const [k, cands] of map) {
    const chosenId = cands.length === 1 ? cands[0].id : pickStudioCandidate(db, cands);
    // App-wide live exclusion: drop the match if the chosen cut is live —
    // matchLocal returns null, so the caller treats it as unmatched/omitted.
    if (excludeLive) {
      const chosen = cands.find(c => c.id === chosenId);
      if (chosen && isLiveTrack(chosen)) { resolved.set(k, null); continue; }
    }
    resolved.set(k, chosenId);
  }
  return resolved;
}

module.exports = {
  sleep,
  buildMatchCacheLocal,
  buildMatchCacheLocalWarmed,
  matchLocal,
  normalizeForSearch,
  buildFuzzyIndex,
  resolveImportMatch,
  resolveArtistWithAliases,
  buildNaviTitle,
  buildLfmTitle,
  buildLfmSnapshotTitle,
  runDetached,
  writeMissingArtists,
  looksLive,
  pickStudioCandidate,
  resolveCandidateMap,
  filterLiveIds,
  filterStudioPool,
  refineStudioPicks,
};
