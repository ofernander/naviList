'use strict';

/**
 * finalize.js — shared post-processing for generated (rules) playlists
 *
 * Per block:
 *   cleanPool       — drop disliked tracks; collapse to one studio copy per song
 *                     (live-only songs dropped)
 *   orderByArtist   — even split by artist (round-robin), optionally giving the
 *                     seed artist(s) a fixed share of the block
 * Across blocks:
 *   combineBlocks   — fill the playlist from every block in proportion to its
 *                     share, interleaved; a block that runs out leaves its slots
 *                     to the others; a track in two blocks is used once
 *
 * Every ordering is prefix-consistent: the first N tracks of an ordered block
 * are its best N, so taking any number from it keeps the even split. Manual
 * and imported playlists never pass through here.
 */

const logger = require('../utils/logger');
const { filterStudioPool } = require('./studio');

async function cleanPool(db, ids, label = 'finalize') {
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
  return out;
}

// Round-robin across artists — each artist's next track in turn, artists in
// order of first appearance, each artist's tracks in pool order.
function roundRobin(ids, artistOf) {
  const queues = new Map();   // artist_id → ids (insertion order = first appearance)
  for (const id of ids) {
    const a = artistOf(id);
    if (!queues.has(a)) queues.set(a, []);
    queues.get(a).push(id);
  }
  const lists = [...queues.values()];
  const out   = [];
  for (let round = 0; ; round++) {
    let added = false;
    for (const q of lists) if (round < q.length) { out.push(q[round]); added = true; }
    if (!added) return out;
  }
}

/**
 * Order a block's pool for an even split by artist. With seedShare (0–100) and
 * seedArtistIds, the seed artist(s) take that share of every prefix of the
 * block and the other artists split the rest evenly; without it the seed is
 * just one of the artists.
 */
function orderByArtist(db, ids, { seedArtistIds = [], seedShare } = {}) {
  const getArtist = db.prepare('SELECT artist_id FROM tracks WHERE id = ?');
  const artistOf  = id => getArtist.get(id)?.artist_id || id;
  if (typeof seedShare !== 'number' || !seedArtistIds.length) return roundRobin(ids, artistOf);

  const seeds  = new Set(seedArtistIds);
  const seed   = roundRobin(ids.filter(id => seeds.has(artistOf(id))), artistOf);
  const others = roundRobin(ids.filter(id => !seeds.has(artistOf(id))), artistOf);
  const p   = Math.max(0, Math.min(100, seedShare)) / 100;
  const out = [];
  let s = 0, o = 0;
  while (s < seed.length || o < others.length) {
    const seedDue = s < p * (out.length + 1);
    if ((seedDue && s < seed.length) || o >= others.length) out.push(seed[s++]);
    else out.push(others[o++]);
  }
  return out;
}

/**
 * Combine ordered block lists into one playlist of up to `limit` tracks.
 * shares: per block, a % or undefined — blocks without a share split whatever
 * the others leave of 100 (all undefined = even). Totals are validated before
 * this runs (playlist_types.shareProblem). Smooth weighted
 * round-robin: each pick goes to the block furthest behind its share, so the
 * blocks are interleaved; exhausted blocks drop out and the rest take their
 * slots; a track already picked (in another block) is skipped.
 */
function combineBlocks(lists, shares, limit) {
  const given  = shares.filter(s => typeof s === 'number');
  const spare  = Math.max(0, 100 - given.reduce((n, s) => n + s, 0));
  const unset  = shares.length - given.length;
  const weight = shares.map(s => typeof s === 'number' ? s : (unset ? spare / unset : 0));

  const blocks = lists.map((list, i) => ({ list, pos: 0, w: weight[i], cur: 0 }));
  const picked = new Set();
  const out    = [];
  while (out.length < limit) {
    const live = blocks.filter(b => b.pos < b.list.length);
    if (!live.length) break;
    const total = live.reduce((n, b) => n + b.w, 0);
    live.forEach(b => { b.cur += b.w; });
    const pick = live.reduce((m, b) => (b.cur > m.cur ? b : m));
    pick.cur -= total;
    while (pick.pos < pick.list.length && picked.has(pick.list[pick.pos])) pick.pos++;
    if (pick.pos >= pick.list.length) continue;
    const id = pick.list[pick.pos++];
    picked.add(id);
    out.push(id);
  }
  return out;
}

module.exports = { cleanPool, orderByArtist, combineBlocks };
