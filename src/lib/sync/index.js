'use strict';

const express      = require('express');
const router       = express.Router();
const db           = require('../../db/index');
const navidrome    = require('../../providers/navidrome');
const lastfm       = require('../../providers/lastfm');
const listenbrainz = require('../../providers/listenbrainz');
const lidarr       = require('../../providers/lidarr');
const mb           = require('../../providers/musicbrainz');
const { ingestListens } = require('../ingestion');
const logger       = require('../../utils/logger');

// ── Shared helpers (imported from helpers.js — no circular dep) ───────────────

const {
  sleep,
  buildMatchCacheLocal,
  matchLocal,
  resolveArtistWithAliases,
  buildNaviTitle,
  buildLfmTitle,
  buildLfmSnapshotTitle,
  runDetached,
  writeMissingArtists
} = require('./helpers');

// ── Sync state ────────────────────────────────────────────────────────────────

let syncState = {
  running:     false,
  lastStarted: null,
  lastResult:  null
};

let tagSyncState = {
  running:     false,
  lastStarted: null,
  lastResult:  null
};

function getSyncState() { return syncState; }

// ── DB-backed sync state ──────────────────────────────────────────────────────

function getSyncStateFromDb(source) {
  return db.prepare('SELECT * FROM sync_state WHERE source = ?').get(source) || null;
}

function setSyncStateInDb(source, fields) {
  db.prepare(`
    INSERT INTO sync_state (source, last_synced_at, last_run_at, status, result)
    VALUES (@source, @last_synced_at, @last_run_at, @status, @result)
    ON CONFLICT(source) DO UPDATE SET
      last_synced_at = excluded.last_synced_at,
      last_run_at    = excluded.last_run_at,
      status         = excluded.status,
      result         = excluded.result
  `).run({ source, ...fields });
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  return s;
}

// ── Missing artists (needs getSettings + lidarr, stays in index) ──────────────

async function processMissingArtists() {
  const settings = getSettings();
  if (!settings.lidarr_url || !settings.lidarr_api_key) {
    logger.info('sync', 'processMissingArtists: Lidarr not configured — skipping');
    return;
  }
  if (!settings.lidarr_root_folder || !settings.lidarr_quality_profile_id || !settings.lidarr_metadata_profile_id) {
    logger.info('sync', 'processMissingArtists: Lidarr profiles not configured — skipping');
    return;
  }

  const pending = db.prepare(`SELECT * FROM missing_artists WHERE status = 'pending' LIMIT 50`).all();
  if (!pending.length) return;

  logger.info('sync', `processMissingArtists: processing ${pending.length} pending artists`);
  const setStatus = db.prepare('UPDATE missing_artists SET status = ?, mbid = ?, sent_at = ? WHERE id = ?');

  for (const artist of pending) {
    try {
      const mbid = await mb.findArtistMbid(artist.artist_name);
      if (!mbid) {
        logger.warn('sync', `processMissingArtists: no MBID found for "${artist.artist_name}" — skipping`);
        setStatus.run('ignored', null, null, artist.id);
        await sleep(500);
        continue;
      }
      const result = await lidarr.addArtist(settings, artist.artist_name, mbid);
      const now    = Math.floor(Date.now() / 1000);
      if (result.ok) {
        setStatus.run('sent', mbid, now, artist.id);
        logger.info('sync', `processMissingArtists: sent "${artist.artist_name}" to Lidarr${result.skipped ? ' (already existed)' : ''}`);
      } else {
        logger.warn('sync', `processMissingArtists: Lidarr rejected "${artist.artist_name}": ${result.error}`);
      }
    } catch (e) {
      logger.warn('sync', `processMissingArtists: error processing "${artist.artist_name}": ${e.message}`);
    }
    await sleep(1000);
  }
}

// ── History import runner ─────────────────────────────────────────────────────

const historyRunning = { lastfm: false, listenbrainz: false };

async function runHistoryImport(source, fetchFn, credentials, force = false) {
  if (historyRunning[source]) {
    logger.warn('sync', `${source} history import already running — skipping`);
    return;
  }
  historyRunning[source] = true;
  const now = Math.floor(Date.now() / 1000);

  setSyncStateInDb(source, {
    last_synced_at: getSyncStateFromDb(source)?.last_synced_at || null,
    last_run_at:    now,
    status:         'running',
    result:         null
  });
  logger.info('sync', `${source} history import started`);

  try {
    const existing = getSyncStateFromDb(source);
    const since    = force ? null : (existing?.last_synced_at || null);
    if (force) logger.info('sync', `${source} forced full re-import (ignoring last_synced_at)`);

    const listens  = await fetchFn(credentials, { since });
    const result   = ingestListens(db, listens);
    const latestTs = listens.length > 0
      ? Math.max(...listens.map(l => l.played_at))
      : existing?.last_synced_at || null;

    setSyncStateInDb(source, {
      last_synced_at: latestTs,
      last_run_at:    now,
      status:         'ok',
      result:         JSON.stringify(result)
    });
    logger.info('sync', `${source} history import done — written: ${result.written}, matched: ${result.matched}, unmatched: ${result.unmatched}`);
  } catch (e) {
    setSyncStateInDb(source, {
      last_synced_at: getSyncStateFromDb(source)?.last_synced_at || null,
      last_run_at:    now,
      status:         'error',
      result:         JSON.stringify({ error: e.message })
    });
    logger.error('sync', `${source} history import threw: ${e.message}`);
  } finally {
    historyRunning[source] = false;
  }
}

// ── Provider sync modules (imported after helpers — no circular dep) ──────────

const lfmSync = require('./lastfm');
const lbSync  = require('./listenbrainz');
const mbSync  = require('./musicbrainz');

// ── Routes — Navidrome ────────────────────────────────────────────────────────

router.post('/library', async (req, res) => {
  if (syncState.running) return res.json({ ok: false, error: 'Sync already in progress' });
  runLibrarySync('manual');
  res.json({ ok: true, message: 'Sync started' });
});

// ── Routes — History ──────────────────────────────────────────────────────────

router.post('/history/lastfm', (req, res) => {
  const s = getSettings();
  if (!s.lastfm_api_key || !s.lastfm_username)
    return res.json({ ok: false, error: 'Last.fm API key and username required' });
  const force = req.query.force === 'true';
  runHistoryImport('lastfm', lastfm.fetchListens, { apiKey: s.lastfm_api_key, username: s.lastfm_username }, force);
  res.json({ ok: true, message: 'Last.fm history import started' });
});

router.post('/history/listenbrainz', (req, res) => {
  const s = getSettings();
  if (!s.listenbrainz_token || !s.listenbrainz_username)
    return res.json({ ok: false, error: 'ListenBrainz token and username required' });
  const force = req.query.force === 'true';
  runHistoryImport('listenbrainz', listenbrainz.fetchListens, { token: s.listenbrainz_token, username: s.listenbrainz_username }, force);
  res.json({ ok: true, message: 'ListenBrainz history import started' });
});

router.get('/history/status', (req, res) => {
  res.json({
    ok:           true,
    lastfm:       getSyncStateFromDb('lastfm'),
    listenbrainz: getSyncStateFromDb('listenbrainz')
  });
});

// ── Routes — Last.fm ──────────────────────────────────────────────────────────

router.post('/loved/lastfm', (req, res) => {
  const s = getSettings();
  if (!s.lastfm_api_key || !s.lastfm_username)
    return res.json({ ok: false, error: 'Last.fm credentials required' });
  runDetached('loved/lastfm', () => lfmSync.syncLovedLastfm(db, s));
  res.json({ ok: true, message: 'Last.fm loved tracks sync started' });
});

router.post('/top-artists/lastfm', (req, res) => {
  const s = getSettings();
  if (!s.lastfm_api_key || !s.lastfm_username)
    return res.json({ ok: false, error: 'Last.fm credentials required' });
  runDetached('top-artists/lastfm', () => lfmSync.syncTopArtistsLastfm(db, s));
  res.json({ ok: true, message: 'Last.fm top artists sync started' });
});

router.post('/top-tracks/lastfm', (req, res) => {
  const s = getSettings();
  if (!s.lastfm_api_key || !s.lastfm_username)
    return res.json({ ok: false, error: 'Last.fm credentials required' });
  runDetached('top-tracks/lastfm', () => lfmSync.syncTopTracksLastfm(db, s));
  res.json({ ok: true, message: 'Last.fm top tracks sync started' });
});

router.post('/artist-tags/lastfm', (req, res) => {
  const s = getSettings();
  if (!s.lastfm_api_key)
    return res.json({ ok: false, error: 'Last.fm API key required' });
  runDetached('artist-tags/lastfm', () => lfmSync.syncArtistTagsLastfm(db, s));
  res.json({ ok: true, message: 'Last.fm artist tags sync started' });
});

// ── Routes — MusicBrainz ──────────────────────────────────────────────────────

router.post('/artist-tags', (req, res) => {
  if (tagSyncState.running)
    return res.json({ ok: false, error: 'Artist tags sync already in progress' });
  tagSyncState.running     = true;
  tagSyncState.lastStarted = Math.floor(Date.now() / 1000);
  tagSyncState.lastResult  = null;
  logger.info('sync', 'artist tags sync triggered');
  mbSync.syncArtistTagsMusicbrainz(db).then(result => {
    tagSyncState.running    = false;
    tagSyncState.lastResult = result;
    logger.info('sync', `artist tags sync finished — ok: ${result.ok}`);
  }).catch(e => {
    tagSyncState.running    = false;
    tagSyncState.lastResult = { ok: false, error: e.message };
    logger.error('sync', `artist tags sync threw: ${e.message}`);
  });
  res.json({ ok: true, message: 'Artist tags sync started' });
});

// ── Routes — ListenBrainz ─────────────────────────────────────────────────────

router.post('/loved/listenbrainz', (req, res) => {
  const s = getSettings();
  if (!s.listenbrainz_token || !s.listenbrainz_username)
    return res.json({ ok: false, error: 'ListenBrainz credentials required' });
  runDetached('loved/listenbrainz', () => lbSync.syncLovedListenbrainz(db, s));
  res.json({ ok: true, message: 'ListenBrainz loved tracks sync started' });
});

router.post('/top-artists/listenbrainz', (req, res) => {
  const s = getSettings();
  if (!s.listenbrainz_token || !s.listenbrainz_username)
    return res.json({ ok: false, error: 'ListenBrainz credentials required' });
  runDetached('top-artists/listenbrainz', () => lbSync.syncTopArtistsListenbrainz(db, s));
  res.json({ ok: true, message: 'ListenBrainz top artists sync started' });
});

router.post('/top-tracks/listenbrainz', (req, res) => {
  const s = getSettings();
  if (!s.listenbrainz_token || !s.listenbrainz_username)
    return res.json({ ok: false, error: 'ListenBrainz credentials required' });
  runDetached('top-tracks/listenbrainz', () => lbSync.syncTopTracksListenbrainz(db, s));
  res.json({ ok: true, message: 'ListenBrainz top tracks sync started' });
});

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
  const s = getSettings();
  try {
    const playlists = await lbSync.fetchAndCacheLbPlaylists(db, s);
    res.json({ ok: true, playlists });
  } catch (e) {
    logger.error('sync', `lb-playlists list failed: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/lb-playlists', async (req, res) => {
  const s = getSettings();
  try {
    await lbSync.fetchAndCacheLbPlaylists(db, s);
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

  const cache    = buildMatchCacheLocal(db);
  const trackIds = rows.map(r => matchLocal(r.artist, r.title, cache)).filter(Boolean);
  if (!trackIds.length) return res.json({ ok: false, error: 'Could not resolve any track IDs' });

  try {
    const result = await navidrome.createPlaylist(db, name.trim(), trackIds);
    if (!result.ok) return res.json({ ok: false, error: result.error });
    await navidrome.updatePlaylist(db, result.playlist.id, {
      comment: `navilist:lb-snapshot ${JSON.stringify({ source: 'listenbrainz', mbid })}`
    });
    logger.info('sync', `lb-snapshot: created "${name.trim()}" with ${trackIds.length} tracks from ${mbid}`);
    res.json({ ok: true, playlist_id: result.playlist.id, count: trackIds.length });
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
    await lbSync.syncLbPlaylists(db, getSettings());
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

router.post('/playlists/listenbrainz', (req, res) => {
  const s = getSettings();
  if (!s.listenbrainz_token || !s.listenbrainz_username)
    return res.json({ ok: false, error: 'ListenBrainz credentials required' });
  runDetached('playlists/listenbrainz', () => lbSync.syncLbPlaylists(db, s));
  res.json({ ok: true, message: 'ListenBrainz playlist import started' });
});

// ── Routes — Last.fm playlists ───────────────────────────────────────────────────

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
    await lfmSync.syncLfmPlaylists(db, getSettings());
    const row = db.prepare('SELECT * FROM lfm_playlists WHERE lfm_id = ?').get(lfm_id);
    res.json({ ok: true, navidrome_id: row?.navidrome_id || null });
  } catch (e) {
    logger.error('sync', `lfm-import failed for ${lfm_id}: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/lfm-playlists/:lfm_id/snapshot', async (req, res) => {
  const { lfm_id } = req.params;
  const { name }   = req.body;
  if (!name?.trim()) return res.json({ ok: false, error: 'name required' });

  const cache      = buildMatchCacheLocal(db);
  const cachedRows = db.prepare('SELECT * FROM lfm_playlist_tracks WHERE lfm_id = ? AND matched = 1 ORDER BY position').all(lfm_id);
  if (!cachedRows.length) return res.json({ ok: false, error: 'No matched tracks cached for this playlist' });

  const trackIds = cachedRows.map(r => matchLocal(r.artist, r.title, cache)).filter(Boolean);
  if (!trackIds.length) return res.json({ ok: false, error: 'Could not resolve any track IDs' });

  try {
    const result = await navidrome.createPlaylist(db, name.trim(), trackIds);
    if (!result.ok) return res.json({ ok: false, error: result.error });
    await navidrome.updatePlaylist(db, result.playlist.id, {
      comment: `navilist:lastfm-snapshot ${JSON.stringify({ source: 'lastfm', lfm_id })}`
    });
    logger.info('sync', `lfm-snapshot: created "${name.trim()}" with ${trackIds.length} tracks from ${lfm_id}`);
    res.json({ ok: true, playlist_id: result.playlist.id, count: trackIds.length });
  } catch (e) {
    logger.error('sync', `lfm-snapshot failed for ${lfm_id}: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/lfm-playlists', async (req, res) => {
  const s = getSettings();
  try {
    await lfmSync.syncLfmPlaylists(db, s);
    res.json({ ok: true, message: 'Last.fm playlists synced' });
  } catch (e) {
    logger.error('sync', `lfm-playlists POST failed: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

// ── Routes — Status ───────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  const trackCount   = db.prepare('SELECT COUNT(*) as c FROM tracks').get().c;
  const lastSync     = db.prepare('SELECT MAX(synced_at) as s FROM tracks').get().s;
  const tagCount = db.prepare('SELECT COUNT(DISTINCT artist_id) as c FROM artist_tags').get().c;
  res.json({
    running:         syncState.running,
    lastStarted:     syncState.lastStarted,
    lastResult:      syncState.lastResult,
    trackCount,
    lastSync,
    artistTagsCount: tagCount,
    tagSync:         tagSyncState
  });
});

// ── Library sync runner ────────────────────────────────────────────────────────

function runLibrarySync(reason) {
  if (syncState.running) {
    logger.debug('sync', `library sync skipped — already running (triggered by: ${reason})`);
    return;
  }
  syncState.running     = true;
  syncState.lastStarted = Math.floor(Date.now() / 1000);
  syncState.lastResult  = null;
  logger.info('sync', `library sync started (triggered by: ${reason})`);
  navidrome.syncLibrary(db)
    .then(result => {
      syncState.running    = false;
      syncState.lastResult = result;
      logger.info('sync', `library sync finished (${reason}) — ok: ${result.ok}`);
    })
    .catch(e => {
      syncState.running    = false;
      syncState.lastResult = { ok: false, error: e.message };
      logger.error('sync', `library sync threw (${reason}): ${e.message}`);
    });
}

// ── Auto-refresh ──────────────────────────────────────────────────────────────

function startAutoRefresh() {
  // ── 1. Startup: full library sync immediately ────────────────────────────────
  runLibrarySync('startup');

  // ── 2. Every 5 min: lightweight track count poll ───────────────────────────
  setInterval(async () => {
    if (syncState.running) return;
    try {
      const ndCount    = await navidrome.getNdTrackCount(db);
      const localCount = db.prepare('SELECT COUNT(*) as c FROM tracks').get().c;
      if (ndCount !== null && ndCount !== localCount) {
        logger.info('sync', `nd-poll: count changed (local=${localCount}, nd=${ndCount}) — triggering sync`);
        runLibrarySync('track-count-change');
      } else {
        logger.debug('sync', `nd-poll: no change (${localCount} tracks)`);
      }
    } catch (e) {
      logger.warn('sync', `nd-poll failed: ${e.message}`);
    }
  }, 5 * 60 * 1000);

  // ── 3. Every 6 hours: full library sync regardless ──────────────────────────
  setInterval(() => {
    runLibrarySync('6-hour-interval');
  }, 6 * 60 * 60 * 1000);

  // ── 4. Every 30 min: external service syncs ───────────────────────────────
  setInterval(() => {
    const s = getSettings();

    if (s.lastfm_api_key && s.lastfm_username) {
      runHistoryImport('lastfm', lastfm.fetchListens, { apiKey: s.lastfm_api_key, username: s.lastfm_username });
      runDetached('loved/lastfm',           () => lfmSync.syncLovedLastfm(db, s));
      runDetached('top-artists/lastfm',     () => lfmSync.syncTopArtistsLastfm(db, s));
      runDetached('top-tracks/lastfm',      () => lfmSync.syncTopTracksLastfm(db, s));
      runDetached('artist-tags/lastfm',     () => lfmSync.syncArtistTagsLastfm(db, s));
      runDetached('playlists/lastfm',       () => lfmSync.syncLfmPlaylists(db, s));
    }

    if (s.listenbrainz_token && s.listenbrainz_username) {
      runHistoryImport('listenbrainz', listenbrainz.fetchListens, { token: s.listenbrainz_token, username: s.listenbrainz_username });
      runDetached('loved/listenbrainz',       () => lbSync.syncLovedListenbrainz(db, s));
      runDetached('top-artists/listenbrainz', () => lbSync.syncTopArtistsListenbrainz(db, s));
      runDetached('top-tracks/listenbrainz',  () => lbSync.syncTopTracksListenbrainz(db, s));
      runDetached('playlists/listenbrainz',   () => lbSync.syncLbPlaylists(db, s));
    }

    runDetached('process-missing-artists', () => processMissingArtists());
  }, 30 * 60 * 1000);

  logger.info('sync', 'auto-refresh scheduled: library poll every 5m, full sync every 6h, services every 30m');
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  router,
  getSyncState,
  getTagSyncState: () => tagSyncState,
  startAutoRefresh,
  sleep,
  buildMatchCacheLocal,
  matchLocal,
  resolveArtistWithAliases,
  buildNaviTitle,
  buildLfmTitle,
  buildLfmSnapshotTitle,
  writeMissingArtists,
  processMissingArtists
};
