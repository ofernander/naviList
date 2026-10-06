'use strict';

/**
 * external_playlists.js — ListenBrainz + Last.fm playlist routes
 *
 * Browse cached LB/LFM playlists, subscribe (kept in sync by the services sync),
 * unsubscribe, or save a one-off snapshot. Mounted under /sync so the UI's URLs
 * are unchanged; the sync jobs themselves live in sync/listenbrainz.js and
 * sync/lastfm.js.
 */

const express    = require('express');
const router     = express.Router();
const db         = require('../db/index');
const navidrome  = require('../providers/navidrome');
const logger     = require('../utils/logger');
const lbSync     = require('./sync/listenbrainz');
const lfmSync    = require('./sync/lastfm');
const { runDetached }        = require('./sync/helpers');
const { getSettings }        = require('../db/settings');
const { buildMatcherWarmed } = require('./match');
const { publishPlaylist }    = require('./publish');
const { TYPES }              = require('./playlist_types');

// Local track ids for a snapshot of cached source rows. Uses the id matched at
// cache time (MBID / alias matches included) while it still exists in the
// library; rows cached before track_id was stored fall back to a text match.
async function resolveCachedRows(rows) {
  const exists  = db.prepare('SELECT 1 FROM tracks WHERE id = ?');
  const legacy  = rows.filter(r => !r.track_id);
  const matcher = legacy.length ? await buildMatcherWarmed(db, legacy) : null;
  return rows.map(r => r.track_id
    ? (exists.get(r.track_id) ? r.track_id : null)
    : matcher.match({ artist: r.artist, title: r.title })
  ).filter(Boolean);
}

// ── ListenBrainz ──────────────────────────────────────────────────────────────

router.get('/lb-playlists/:mbid/tracks', (req, res) => {
  const { mbid } = req.params;
  const rows = db.prepare('SELECT * FROM lb_playlist_tracks WHERE lb_mbid = ? ORDER BY position').all(mbid);
  if (!rows.length) return res.json({ ok: false, error: 'No cached tracks for this playlist. Run Sync All from Services first.' });
  const tracks  = rows.map(r => ({ artist: r.artist, title: r.title, matched: !!r.matched }));
  const matched = tracks.filter(t => t.matched).length;
  res.json({ ok: true, total: tracks.length, matched, tracks });
});

router.get('/lb-playlists/cached', (req, res) => {
  const playlists = db.prepare('SELECT * FROM lb_playlist_cache ORDER BY playlist_type, title').all();
  const tracks    = db.prepare('SELECT * FROM lb_playlist_tracks ORDER BY position').all();
  const subs      = db.prepare('SELECT * FROM lb_subscriptions').all();
  const subByMbid = new Map(subs.map(s => [s.lb_mbid, s]));
  const trackMap  = new Map();
  for (const t of tracks) {
    if (!trackMap.has(t.lb_mbid)) trackMap.set(t.lb_mbid, []);
    trackMap.get(t.lb_mbid).push({ artist: t.artist, title: t.title, matched: !!t.matched });
  }
  res.json({ ok: true, playlists: playlists.map(p => {
    const sub = subByMbid.get(p.lb_mbid);
    return { ...p, enabled: sub ? 1 : 0, navidrome_id: sub?.navidrome_id || null, tracks: trackMap.get(p.lb_mbid) || [] };
  })});
});

router.get('/lb-playlists', async (req, res) => {
  try {
    const playlists = await lbSync.fetchAndCacheLbPlaylists(db, getSettings(db));
    res.json({ ok: true, playlists });
  } catch (e) {
    logger.error('sync', `lb-playlists list failed: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/lb-playlists', async (req, res) => {
  try {
    await lbSync.fetchAndCacheLbPlaylists(db, getSettings(db));
    res.json({ ok: true, message: 'LB playlists synced' });
  } catch (e) {
    logger.error('sync', `lb-playlists POST failed: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/lb-playlists/:mbid/snapshot', async (req, res) => {
  const { mbid } = req.params;
  const { name }  = req.body;
  if (!name?.trim()) return res.json({ ok: false, error: 'name required' });

  const rows = db.prepare('SELECT * FROM lb_playlist_tracks WHERE lb_mbid = ? AND matched = 1 ORDER BY position').all(mbid);
  if (!rows.length) return res.json({ ok: false, error: 'No matched tracks cached for this playlist' });

  const trackIds = await resolveCachedRows(rows);
  if (!trackIds.length) return res.json({ ok: false, error: 'Could not resolve any track IDs' });

  try {
    const config = { source: 'listenbrainz', mbid };
    const result = await publishPlaylist(db, { name: name.trim(), type: TYPES.LB_SNAPSHOT, config, trackIds });
    if (!result.ok) return res.json({ ok: false, error: result.error });
    logger.info('sync', `lb-snapshot: created "${name.trim()}" with ${trackIds.length} tracks from ${mbid}`);
    res.json({ ok: true, playlist_id: result.playlistId, count: trackIds.length });
  } catch (e) {
    logger.error('sync', `lb-snapshot failed: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/lb-playlists/:mbid/import', async (req, res) => {
  const { mbid } = req.params;
  const cached = db.prepare('SELECT * FROM lb_playlist_cache WHERE lb_mbid = ?').get(mbid);
  if (!cached) return res.json({ ok: false, error: 'Playlist not found — run Sync All from Services first' });

  const alreadySub = db.prepare('SELECT id FROM lb_subscriptions WHERE lb_mbid = ?').get(mbid);
  if (alreadySub) return res.json({ ok: false, error: 'Already subscribed' });

  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO lb_subscriptions (lb_mbid, source_patch, navidrome_id, created_at) VALUES (?, ?, NULL, ?)')
    .run(mbid, cached.source_patch || null, now);

  try {
    await lbSync.syncLbPlaylists(db, getSettings(db));
    const sub = db.prepare('SELECT * FROM lb_subscriptions WHERE lb_mbid = ?').get(mbid);
    res.json({ ok: true, navidrome_id: sub?.navidrome_id || null });
  } catch (e) {
    logger.error('sync', `lb-import failed for ${mbid}: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/lb-playlists/:mbid/unsubscribe', async (req, res) => {
  const { mbid } = req.params;
  const sub = db.prepare('SELECT * FROM lb_subscriptions WHERE lb_mbid = ?').get(mbid);
  if (!sub) return res.json({ ok: false, error: 'Not subscribed' });

  try {
    if (sub.navidrome_id) await navidrome.deletePlaylist(db, sub.navidrome_id);
    db.prepare('DELETE FROM lb_subscriptions WHERE id = ?').run(sub.id);
    logger.info('sync', `lb-unsubscribe: removed subscription for ${mbid}`);
    res.json({ ok: true });
  } catch (e) {
    logger.error('sync', `lb-unsubscribe failed: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/playlists/listenbrainz', (req, res) => {
  const s = getSettings(db);
  if (!s.listenbrainz_token || !s.listenbrainz_username)
    return res.json({ ok: false, error: 'ListenBrainz credentials required' });
  runDetached('playlists/listenbrainz', () => lbSync.syncLbPlaylists(db, s));
  res.json({ ok: true, message: 'ListenBrainz playlist import started' });
});

// ── Last.fm ───────────────────────────────────────────────────────────────────

router.get('/lfm-playlists/cached', (req, res) => {
  const playlists = db.prepare('SELECT * FROM lfm_playlists ORDER BY title').all();
  const tracks    = db.prepare('SELECT * FROM lfm_playlist_tracks ORDER BY position').all();
  const trackMap  = new Map();
  for (const t of tracks) {
    if (!trackMap.has(t.lfm_id)) trackMap.set(t.lfm_id, []);
    trackMap.get(t.lfm_id).push({ artist: t.artist, title: t.title, matched: !!t.matched });
  }
  res.json({ ok: true, playlists: playlists.map(p => ({ ...p, tracks: trackMap.get(p.lfm_id) || [] })) });
});

router.post('/lfm-playlists/:lfm_id/import', async (req, res) => {
  const { lfm_id } = req.params;
  const existing   = db.prepare('SELECT * FROM lfm_playlists WHERE lfm_id = ?').get(lfm_id);
  if (!existing) return res.json({ ok: false, error: 'Playlist not found — run Sync All from Services first' });

  db.prepare('UPDATE lfm_playlists SET enabled = 1 WHERE lfm_id = ?').run(lfm_id);
  try {
    await lfmSync.syncLfmPlaylists(db, getSettings(db));
    const row = db.prepare('SELECT * FROM lfm_playlists WHERE lfm_id = ?').get(lfm_id);
    res.json({ ok: true, navidrome_id: row?.navidrome_id || null });
  } catch (e) {
    logger.error('sync', `lfm-import failed for ${lfm_id}: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/lfm-playlists/:lfm_id/unsubscribe', async (req, res) => {
  const { lfm_id } = req.params;
  const row = db.prepare('SELECT * FROM lfm_playlists WHERE lfm_id = ?').get(lfm_id);
  if (!row) return res.json({ ok: false, error: 'Playlist not found' });

  try {
    if (row.navidrome_id) {
      await navidrome.deletePlaylist(db, row.navidrome_id);
    }
    db.prepare('UPDATE lfm_playlists SET navidrome_id = NULL WHERE lfm_id = ?').run(lfm_id);
    logger.info('sync', `lfm-unsubscribe: "${row.title}" removed from ND`);
    res.json({ ok: true });
  } catch (e) {
    logger.error('sync', `lfm-unsubscribe failed for ${lfm_id}: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/lfm-playlists/:lfm_id/snapshot', async (req, res) => {
  const { lfm_id } = req.params;
  const { name }   = req.body;
  if (!name?.trim()) return res.json({ ok: false, error: 'name required' });

  const cachedRows = db.prepare('SELECT * FROM lfm_playlist_tracks WHERE lfm_id = ? AND matched = 1 ORDER BY position').all(lfm_id);
  if (!cachedRows.length) return res.json({ ok: false, error: 'No matched tracks cached for this playlist' });

  const trackIds = await resolveCachedRows(cachedRows);
  if (!trackIds.length) return res.json({ ok: false, error: 'Could not resolve any track IDs' });

  try {
    const config = { source: 'lastfm', lfm_id };
    const result = await publishPlaylist(db, { name: name.trim(), type: TYPES.LASTFM_SNAPSHOT, config, trackIds });
    if (!result.ok) return res.json({ ok: false, error: result.error });
    logger.info('sync', `lfm-snapshot: created "${name.trim()}" with ${trackIds.length} tracks from ${lfm_id}`);
    res.json({ ok: true, playlist_id: result.playlistId, count: trackIds.length });
  } catch (e) {
    logger.error('sync', `lfm-snapshot failed for ${lfm_id}: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/lfm-playlists', async (req, res) => {
  try {
    await lfmSync.syncLfmPlaylists(db, getSettings(db));
    res.json({ ok: true, message: 'Last.fm playlists synced' });
  } catch (e) {
    logger.error('sync', `lfm-playlists POST failed: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
