'use strict';

/**
 * studio.js — studio vs live disambiguation
 *
 * When several library copies of a song collide, prefer the studio recording.
 * Free local title/album heuristic first; the authoritative signal is each copy's
 * MusicBrainz recording id (tracks.mbid → live?), looked up on demand and cached
 * on the track (tracks.is_live). Manual playlists never pass through here.
 */

const mb     = require('../providers/musicbrainz');
const logger = require('../utils/logger');

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

// Collapse key→candidate[] to key→studio-preferred id, using ONLY the local
// heuristic + already-cached MB data (never fetches). MB is fetched on demand
// by match.buildMatcherWarmed, scoped to a playlist's own tracks.
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
  isLiveTrack,
  ensureLiveStatus,
  pickStudioCandidate,
  resolveCandidateMap,
  filterStudioPool,
  refineStudioPicks,
};
