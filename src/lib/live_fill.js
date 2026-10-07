'use strict';

/**
 * live_fill.js — live recordings, per artist, in the background
 *
 * fillLiveStatus runs after the artist MBID fill. For each artist with an MBID
 * (and library tracks with recording MBIDs) it pages through the artist's live
 * releases on MusicBrainz and marks the library tracks whose recording is on one
 * of them as live (tracks.is_live = 1).
 *
 * It only ever marks LIVE. A recording missing from the artist's own live
 * releases may still be live on someone else's release (festival compilations),
 * and a confirmed studio flag overrides the title/album heuristic everywhere —
 * so studio is left to the on-demand per-recording check (studio.js).
 *
 * Each artist is stored as it completes (resumable); rescanned after
 * RESCAN_DAYS for new releases.
 */

const mb     = require('../providers/musicbrainz');
const logger = require('../utils/logger');

const RESCAN_DAYS     = 180;
const MAX_FAILURES    = 5;     // consecutive MB errors before stopping
const LOG_EVERY       = 25;

async function fillLiveStatus(db) {
  const now = Math.floor(Date.now() / 1000);
  const todo = db.prepare(`
    SELECT a.artist_id, a.name, a.mbid FROM artists a
    WHERE a.mbid IS NOT NULL
      AND (a.live_checked_at IS NULL OR a.live_checked_at < ?)
      AND EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = a.artist_id AND t.mbid IS NOT NULL)
  `).all(now - RESCAN_DAYS * 86400);
  if (!todo.length) { logger.info('live-fill', 'all artists scanned — nothing to do'); return { ok: true, artists: 0, marked: 0 }; }
  logger.info('live-fill', `${todo.length} artists to scan for live releases`);

  const libRecs  = db.prepare('SELECT DISTINCT mbid FROM tracks WHERE artist_id = ? AND mbid IS NOT NULL');
  const markLive = db.prepare('UPDATE tracks SET is_live = 1 WHERE mbid = ? AND is_live IS NOT 1');
  const checked  = db.prepare('UPDATE artists SET live_checked_at = ? WHERE artist_id = ?');

  let scanned = 0, marked = 0, pages = 0, failures = 0;
  for (const a of todo) {
    const mine = new Set(libRecs.all(a.artist_id).map(r => r.mbid));
    const live = new Set();
    try {
      for (let offset = 0; offset !== null; ) {
        const page = await mb.getLiveRecordingsPage(a.mbid, offset);
        pages++;
        for (const id of page.recordingIds) if (mine.has(id)) live.add(id);
        offset = page.next;
      }
      failures = 0;
    } catch (e) {
      logger.warn('live-fill', `"${a.name}" failed: ${e.message} — retried next run`);
      if (++failures >= MAX_FAILURES) {
        logger.warn('live-fill', `${failures} failures in a row — stopping, the rest is retried next run`);
        break;
      }
      continue;
    }

    let n = 0;
    db.transaction(() => {
      for (const id of live) n += markLive.run(id).changes;
      checked.run(Math.floor(Date.now() / 1000), a.artist_id);
    })();
    marked += n;
    if (n) logger.info('live-fill', `"${a.name}": ${n} library tracks marked live`);
    if (++scanned % LOG_EVERY === 0) logger.info('live-fill', `${scanned}/${todo.length} artists scanned (${pages} pages)`);
  }

  const summary = { ok: true, artists: scanned, pages, marked };
  logger.info('live-fill', `done — ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = { fillLiveStatus };
