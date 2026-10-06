'use strict';

/**
 * finalize.js — shared post-processing for generated (rules) playlists
 *
 * Takes a source's ordered candidate pool and applies, in order:
 *   1. disliked exclusion   — tracks marked disliked on Last.fm / ListenBrainz
 *   2. studio collapse      — one studio copy per song, live-only songs dropped
 *   3. even split by artist — round-robin up to the limit: 1 artist → all tracks,
 *                             2 → half each, 3 → a third each… An artist that runs
 *                             out leaves its share to the others; with more artists
 *                             than slots, each gets at most one track.
 * Ordering (rank, preferred-rule score, shuffle) belongs to the source and is
 * preserved. Manual and imported playlists never pass through here.
 */

const logger = require('../utils/logger');
const { filterStudioPool } = require('./studio');

async function finalize(db, ids, { limit = 0, label = 'finalize' } = {}) {
  let out = ids || [];

  const disliked = new Set(
    db.prepare('SELECT DISTINCT track_id FROM loved_tracks WHERE score = -1').all().map(r => r.track_id)
  );
  if (disliked.size) {
    const before = out.length;
    out = out.filter(id => !disliked.has(id));
    if (before > out.length) logger.info(label, `excluded ${before - out.length} disliked tracks`);
  }

  const before = out.length;
  out = await filterStudioPool(db, out);
  if (before > out.length) logger.info(label, `excluded ${before - out.length} live / duplicate copies`);
  else                     logger.debug(label, 'live check: no live tracks to exclude');

  return splitByArtist(db, out, limit || Infinity);
}

// Round-robin across artists — each artist's next track in turn, artists in
// order of first appearance, each artist's tracks in pool order — until limit.
// Preserves the source's priority within every artist.
function splitByArtist(db, ids, limit) {
  const getArtist = db.prepare('SELECT artist_id FROM tracks WHERE id = ?');
  const queues    = new Map();   // artist_id → ids (insertion order = first appearance)
  for (const id of ids) {
    const artistId = getArtist.get(id)?.artist_id || id;
    if (!queues.has(artistId)) queues.set(artistId, []);
    queues.get(artistId).push(id);
  }
  const lists = [...queues.values()];
  const out   = [];
  for (let round = 0; out.length < limit; round++) {
    let added = false;
    for (const q of lists) {
      if (round >= q.length) continue;
      out.push(q[round]);
      added = true;
      if (out.length >= limit) break;
    }
    if (!added) break;
  }
  return out;
}

module.exports = { finalize };
