'use strict';

/**
 * popularity.js — how popular each library track is within its own artist
 *
 * fillPopularity runs in the background after the artist MBID fill. One request
 * per artist: ListenBrainz top-recordings-for-artist (by artist MBID, needs the
 * user's LB token), else Last.fm artist.getTopTracks (by name, needs the API key)
 * when LB has nothing. Each of the artist's tracks gets
 *   pop_plays      plays of its song
 *   pop_score      pop_plays ÷ plays of the artist's top song × 100
 *   pop_source     'lb' | 'lastfm' | 'none'   (NULL = not fetched yet)
 * Plays, not distinct listeners: a hit is the song people keep playing, and it
 * matches the sources' own rankings (Lord Huron on LB: The Night We Met has the
 * most plays but fewer listeners than Time to Run, which many hear once or twice).
 * A song's plays are the max over every recording with the same title key,
 * so remaster and compilation copies aren't penalised. A track the source
 * doesn't list keeps pop_score NULL (unrated). Last.fm tracks are scored against
 * Last.fm's own top song, so the two scales never mix.
 *
 * Refetched when an artist has unscored tracks (new ones included), after
 * STALE_DAYS for everyone, and after NONE_RETRY_DAYS for artists with no data.
 */

const listenbrainz = require('../providers/listenbrainz');
const lastfm       = require('../providers/lastfm');
const logger       = require('../utils/logger');
const { sleep }    = require('./sync/helpers');
const { getSettings } = require('../db/settings');
const { normalizeForSearch } = require('./match');

const STALE_DAYS      = 180;
const NONE_RETRY_DAYS = 30;
const PAUSE_MS        = 1000;   // between artists (LB asks for ~1 req/s)
const LASTFM_LIMIT    = 500;    // top tracks per artist from Last.fm
const MAX_FAILURES    = 5;      // consecutive errors before stopping the run (backoff 2, 4, 8, 16 s)
const LOG_EVERY       = 50;

// Version suffixes that don't make it a different song. "Live" is deliberately
// not here — a live cut only scores if the source lists that title.
const VERSION_RE = /\b(remaster(ed)?|mono|stereo|deluxe|bonus track|single version|album version|radio edit)\b/i;

// Title used to group recordings of the same song: version suffixes in brackets
// or after the last " - " dropped, then normalized like the matcher does.
function titleKey(title) {
  let t = String(title || '').replace(/[([][^)\]]*[)\]]/g, m => (VERSION_RE.test(m) ? ' ' : m));
  const dash = t.lastIndexOf(' - ');
  if (dash > 0 && VERSION_RE.test(t.slice(dash + 3))) t = t.slice(0, dash);
  return normalizeForSearch(t);
}

/**
 * Score an artist's library tracks against a source's ranked list.
 * rows:   [{ mbid, title, plays }]  (one artist, any order)
 * tracks: [{ id, title, mbid }]
 * → [{ id, plays, score }]  — plays/score null when the song isn't listed
 */
function scoreTracks(rows, tracks) {
  const byKey     = new Map();   // title key → max plays
  const keyOfMbid = new Map();   // recording MBID → title key
  let top = 0;
  for (const r of rows) {
    const key = titleKey(r.title);
    if (!key) continue;
    byKey.set(key, Math.max(byKey.get(key) || 0, r.plays));
    if (r.mbid) keyOfMbid.set(r.mbid, key);
    top = Math.max(top, r.plays);
  }
  return tracks.map(t => {
    const plays = byKey.get((t.mbid && keyOfMbid.get(t.mbid)) || titleKey(t.title));
    if (plays == null || !top) return { id: t.id, plays: null, score: null };
    return { id: t.id, plays, score: Math.round(plays / top * 1000) / 10 };
  });
}

// Last.fm's "artist not found" (error 6) means no data, not a failure. Other
// errors are labelled so the log says which service failed.
async function lastfmRows(apiKey, name) {
  let data;
  try { data = await lastfm.getArtistTopTracks(apiKey, name, LASTFM_LIMIT); }
  catch (e) {
    if (/"error":6\b/.test(e.message)) return [];
    throw new Error(`Last.fm: ${e.message}`);
  }
  const list = data?.toptracks?.track;
  const arr  = Array.isArray(list) ? list : (list ? [list] : []);
  return arr.map(t => ({ mbid: t.mbid || null, title: t.name, plays: parseInt(t.playcount, 10) || 0 }));
}

async function fillPopularity(db) {
  const { listenbrainz_token: lbToken, lastfm_api_key: lfmKey } = getSettings(db);
  if (!lbToken && !lfmKey) {
    logger.info('popularity', 'no ListenBrainz token or Last.fm API key — skipping');
    return { ok: true, skipped: true };
  }

  const now  = Math.floor(Date.now() / 1000);
  const todo = db.prepare(`
    SELECT t.artist_id, a.mbid, COALESCE(a.name, MIN(t.artist)) AS name
    FROM tracks t LEFT JOIN artists a ON a.artist_id = t.artist_id
    WHERE t.artist_id IS NOT NULL
    GROUP BY t.artist_id
    HAVING SUM(t.pop_source IS NULL) > 0
        OR MIN(t.pop_fetched_at) < ?
        OR (MAX(t.pop_source = 'none') = 1 AND MIN(t.pop_fetched_at) < ?)
  `).all(now - STALE_DAYS * 86400, now - NONE_RETRY_DAYS * 86400);
  if (!todo.length) { logger.info('popularity', 'all artists rated — nothing to do'); return { ok: true, artists: 0 }; }
  logger.info('popularity', `${todo.length} artists to rate (~${Math.ceil(todo.length * 1.5 / 60)} min)` +
    `${lbToken ? '' : ' — no ListenBrainz token, Last.fm only'}${lfmKey ? '' : ' — no Last.fm key, ListenBrainz only'}`);

  const tracksOf = db.prepare('SELECT id, title, mbid FROM tracks WHERE artist_id = ?');
  const setPop   = db.prepare('UPDATE tracks SET pop_score = ?, pop_plays = ?, pop_source = ?, pop_fetched_at = ? WHERE id = ?');

  let lbRefused = false, failures = 0, done = 0, rated = 0;
  const bySource = { lb: 0, lastfm: 0, none: 0 };
  for (const a of todo) {
    // Token refused: leave artists ListenBrainz would cover for the next run rather
    // than downgrade them to Last.fm / none.
    if (lbRefused && a.mbid) continue;
    let rows = [], source = 'none';
    try {
      if (lbToken && a.mbid) {
        const res = await listenbrainz.getArtistTopRecordings(lbToken, a.mbid);
        if (res.rows.length) {
          rows = res.rows.map(r => ({ mbid: r.recording_mbid, title: r.recording_name, plays: r.total_listen_count || 0 }));
          source = 'lb';
        }
        await sleep(res.remaining === 0 && res.resetIn > 0 ? res.resetIn * 1000 : PAUSE_MS);
      }
      if (!rows.length && lfmKey) {
        rows = await lastfmRows(lfmKey, a.name);
        if (rows.length) source = 'lastfm';
        await sleep(PAUSE_MS);
      }
      failures = 0;
    } catch (e) {
      if (e.status === 401) {
        lbRefused = true;
        logger.warn('popularity', 'ListenBrainz refused the token (401) — artists with an MBID are left for the next run');
      } else {
        logger.warn('popularity', `"${a.name}" failed: ${e.message} — retried next run`);
      }
      if (++failures >= MAX_FAILURES) {
        logger.warn('popularity', `${failures} failures in a row — stopping, the rest is retried next run`);
        break;
      }
      await sleep(PAUSE_MS * 2 ** failures);   // back off before the next artist
      continue;
    }

    const scored = scoreTracks(rows, tracksOf.all(a.artist_id));
    const at = Math.floor(Date.now() / 1000);
    db.transaction(() => { for (const s of scored) setPop.run(s.score, s.plays, source, at, s.id); })();
    bySource[source]++;
    rated += scored.filter(s => s.score != null).length;
    if (++done % LOG_EVERY === 0) logger.info('popularity', `${done}/${todo.length} artists rated`);
  }

  const summary = { ok: true, artists: done, ...bySource, tracksRated: rated };
  logger.info('popularity', `done — ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = { fillPopularity, scoreTracks, titleKey };
