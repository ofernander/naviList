'use strict';

/**
 * artist_mbid.js — MusicBrainz artist IDs for every library artist
 *
 * fillArtistMbids runs in the background after a library sync and resolves
 * artists.mbid in three stages, cheapest first:
 *   1. Navidrome getArtists (musicBrainzId from the user's tags) — one call; wins
 *      over any MBID found another way.
 *   2. ListenBrainz recording metadata — the artist credit of the artist's own
 *      recordings (tracks.mbid), batched. Only a credit whose name matches the
 *      artist, or a recording with a single credit, is accepted.
 *   3. MusicBrainz name search — whatever is left, one artist per 2s slot.
 * Each result is stored as it lands (resumable). Artists with nothing found are
 * marked mbid_source 'none' and retried after NONE_RETRY_DAYS.
 */

const navidrome    = require('../providers/navidrome');
const listenbrainz = require('../providers/listenbrainz');
const mb           = require('../providers/musicbrainz');
const logger       = require('../utils/logger');
const { sleep }    = require('./sync/helpers');
const { normalizeForSearch } = require('./match');

const NONE_RETRY_DAYS   = 30;
const LB_BATCH          = 500;   // recordings per POST (API max 1000)
const LB_RECS_PER_ARTIST = 3;    // recordings tried per artist
const LB_PAUSE_MS       = 1000;
const MB_MAX_FAILURES   = 5;     // consecutive MB errors before stopping the stage
const MB_LOG_EVERY      = 50;

// MBID from a recording's artist credit: the credited artist whose name matches,
// else the only credited artist. Collaborations with no matching name → null.
function creditMbid(credits, name) {
  const want = normalizeForSearch(name);
  const hit  = credits.find(c => c.artist_mbid && normalizeForSearch(c.name) === want);
  if (hit) return hit.artist_mbid;
  return credits.length === 1 ? (credits[0].artist_mbid || null) : null;
}

async function fillArtistMbids(db) {
  const now = Math.floor(Date.now() / 1000);
  const set = db.prepare(`
    INSERT INTO artists (artist_id, name, mbid, mbid_source, mbid_checked_at, updated_at)
    VALUES (@id, @name, @mbid, @source, @now, @now)
    ON CONFLICT(artist_id) DO UPDATE SET
      mbid = excluded.mbid, mbid_source = excluded.mbid_source,
      mbid_checked_at = excluded.mbid_checked_at, updated_at = excluded.updated_at
  `);
  const save = (id, name, mbid, source) => set.run({ id, name, mbid, source, now: Math.floor(Date.now() / 1000) });

  // Library artists: one name per artist_id (the shortest — "A" over "A feat. B").
  const names = new Map();
  for (const r of db.prepare('SELECT DISTINCT artist_id, artist FROM tracks WHERE artist_id IS NOT NULL AND artist IS NOT NULL').all()) {
    const cur = names.get(r.artist_id);
    if (!cur || r.artist.length < cur.length) names.set(r.artist_id, r.artist);
  }
  if (!names.size) return { ok: true, total: 0 };

  // ── 1. Navidrome ──
  const ndArtists = await navidrome.getArtists(db);
  const current   = db.prepare('SELECT mbid, mbid_source FROM artists WHERE artist_id = ?');
  let ndCovered = 0, ndSet = 0;
  db.transaction(() => {
    for (const a of ndArtists) {
      if (!a.musicBrainzId || !names.has(a.id)) continue;
      ndCovered++;
      const row = current.get(a.id);
      if (row?.mbid === a.musicBrainzId && row.mbid_source === 'navidrome') continue;
      save(a.id, a.name || names.get(a.id), a.musicBrainzId, 'navidrome');
      ndSet++;
    }
  })();
  logger.info('artist-mbid', `navidrome: ${ndCovered} of ${names.size} library artists have an MBID ` +
    `(${ndArtists.length} artists listed, ${ndSet} updated)`);

  // Still to resolve: no MBID, and never checked or a 'none' older than the retry window.
  const retryBefore = now - NONE_RETRY_DAYS * 86400;
  const known = new Map(db.prepare('SELECT artist_id, mbid, mbid_checked_at FROM artists').all().map(r => [r.artist_id, r]));
  const todo  = [...names.keys()].filter(id => {
    const r = known.get(id);
    return !r || (!r.mbid && (!r.mbid_checked_at || r.mbid_checked_at < retryBefore));
  });
  if (!todo.length) {
    logger.info('artist-mbid', `all ${names.size} library artists checked — nothing to do`);
    return { ok: true, total: names.size, navidrome: ndCovered, listenbrainz: 0, musicbrainz: 0, none: 0 };
  }

  // ── 2. ListenBrainz recording metadata ──
  const recsOf = db.prepare('SELECT DISTINCT mbid FROM tracks WHERE artist_id = ? AND mbid IS NOT NULL LIMIT ?');
  const recArtist = new Map();   // recording MBID → artist_id
  for (const id of todo) for (const r of recsOf.all(id, LB_RECS_PER_ARTIST)) recArtist.set(r.mbid, id);

  const resolved = new Set();
  const deferred = new Set();    // LB batch failed — retried next run, not sent to MB
  let lbFound = 0;
  const recs = [...recArtist.keys()];
  for (let i = 0; i < recs.length; i += LB_BATCH) {
    const batch = recs.slice(i, i + LB_BATCH);
    try {
      const { data, remaining, resetIn } = await listenbrainz.getRecordingsArtists(batch);
      db.transaction(() => {
        for (const rec of batch) {
          const id = recArtist.get(rec);
          if (resolved.has(id)) continue;
          const mbid = creditMbid(data?.[rec]?.artist?.artists || [], names.get(id));
          if (!mbid) continue;
          save(id, names.get(id), mbid, 'listenbrainz');
          resolved.add(id);
          lbFound++;
        }
      })();
      await sleep(remaining === 0 && resetIn > 0 ? resetIn * 1000 : LB_PAUSE_MS);
    } catch (e) {
      logger.warn('artist-mbid', `listenbrainz batch failed: ${e.message} — ${batch.length} recordings retried next run`);
      for (const rec of batch) deferred.add(recArtist.get(rec));
    }
  }
  logger.info('artist-mbid', `listenbrainz: ${lbFound} of ${todo.length} artists resolved ` +
    `(${new Set(recArtist.values()).size} had recording MBIDs)`);

  // ── 3. MusicBrainz name search ──
  const left = todo.filter(id => !resolved.has(id) && !deferred.has(id));
  logger.info('artist-mbid', `musicbrainz: ${left.length} artists to search (~${Math.ceil(left.length * 2 / 60)} min)`);
  let mbFound = 0, none = 0, failures = 0, done = 0;
  for (const id of left) {
    const name = names.get(id);
    try {
      const mbid = await mb.findArtistMbid(name);
      save(id, name, mbid || null, mbid ? 'musicbrainz' : 'none');
      mbid ? mbFound++ : none++;
      failures = 0;
    } catch (e) {
      logger.warn('artist-mbid', `musicbrainz search failed for "${name}": ${e.message}`);
      if (++failures >= MB_MAX_FAILURES) {
        logger.warn('artist-mbid', `musicbrainz: ${failures} failures in a row — stopping, the rest is retried next run`);
        break;
      }
    }
    if (++done % MB_LOG_EVERY === 0) logger.info('artist-mbid', `musicbrainz: ${done}/${left.length} searched`);
  }

  const summary = { ok: true, total: names.size, navidrome: ndCovered, listenbrainz: lbFound, musicbrainz: mbFound, none };
  logger.info('artist-mbid', `done — ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = { fillArtistMbids, creditMbid };
