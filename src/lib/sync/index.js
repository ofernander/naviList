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
const { getSettings: readSettings } = require('../../db/settings');
const refresh      = require('../refresh');
const logger       = require('../../utils/logger');

// ── Shared helpers (imported from helpers.js — no circular dep) ───────────────

const { sleep, runDetached } = require('./helpers');

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

function getSettings() { return readSettings(db); }

// ── Missing artists (needs getSettings + lidarr, stays in index) ──────────────

async function processMissingArtists(force = false) {
  const settings = getSettings();
  if (!force && settings.lidarr_auto_add !== 'true') {
    logger.debug('sync', 'processMissingArtists: lidarr_auto_add not enabled — skipping');
    return;
  }

  const pending = db.prepare(`SELECT * FROM missing_artists WHERE status = 'pending'`).all();
  if (!pending.length) return;

  logger.info('sync', `processMissingArtists: processing ${pending.length} pending artists`);

  // Fetch full Lidarr artist list once — check locally instead of per-artist API calls
  let lidarrArtistIds = new Set();
  try {
    const existing = await lidarr.getArtists(settings);
    existing.forEach(a => { if (a.foreignArtistId) lidarrArtistIds.add(a.foreignArtistId); });
    logger.info('sync', `processMissingArtists: fetched ${lidarrArtistIds.size} existing Lidarr artists`);
  } catch (e) {
    logger.warn('sync', `processMissingArtists: could not fetch Lidarr artist list — will check per-artist: ${e.message}`);
  }

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
      const now = Math.floor(Date.now() / 1000);
      if (lidarrArtistIds.has(mbid)) {
        logger.info('sync', `processMissingArtists: "${artist.artist_name}" already in Lidarr — marking sent`);
        setStatus.run('sent', mbid, now, artist.id);
      } else {
        const result = await lidarr.addArtist(settings, artist.artist_name, mbid);
        if (result.ok) {
          lidarrArtistIds.add(mbid);
          setStatus.run('sent', mbid, now, artist.id);
          logger.info('sync', `processMissingArtists: added "${artist.artist_name}" to Lidarr`);
        } else {
          logger.warn('sync', `processMissingArtists: Lidarr rejected "${artist.artist_name}": ${result.error}`);
        }
      }
    } catch (e) {
      logger.warn('sync', `processMissingArtists: error processing "${artist.artist_name}": ${e.message}`);
    }
    await sleep(1000);
  }
}

// ── History import runner ─────────────────────────────────────────────────────

const historyRunning = { lastfm: false, listenbrainz: false, maloja: false };

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

const lfmSync    = require('./lastfm');
const lbSync     = require('./listenbrainz');
const mbSync     = require('./musicbrainz');
const malojaSync = require('./maloja');

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

router.post('/history/maloja', (req, res) => {
  const s = getSettings();
  if (!s.maloja_url || !s.maloja_api_key)
    return res.json({ ok: false, error: 'Maloja URL and API key required' });
  const force = req.query.force === 'true';
  const malojaProv = require('../../providers/maloja');
  runHistoryImport('maloja', malojaProv.fetchListens, { baseUrl: s.maloja_url, apiKey: s.maloja_api_key }, force);
  res.json({ ok: true, message: 'Maloja history import started' });
});

router.post('/top-artists/maloja', (req, res) => {
  const s = getSettings();
  if (!s.maloja_url || !s.maloja_api_key)
    return res.json({ ok: false, error: 'Maloja URL and API key required' });
  runDetached('top-artists/maloja', () => malojaSync.syncTopArtistsMaloja(db, s));
  res.json({ ok: true, message: 'Maloja top artists sync started' });
});

router.post('/top-tracks/maloja', (req, res) => {
  const s = getSettings();
  if (!s.maloja_url || !s.maloja_api_key)
    return res.json({ ok: false, error: 'Maloja URL and API key required' });
  runDetached('top-tracks/maloja', () => malojaSync.syncTopTracksMaloja(db, s));
  res.json({ ok: true, message: 'Maloja top tracks sync started' });
});

router.post('/process-missing-artists', async (req, res) => {
  res.json({ ok: true, message: 'Processing started' });
  await processMissingArtists(true);
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
      // Missing artists that just arrived can now appear in rules playlists.
      if (result.foundArtists > 0)
        runDetached('regenerate-rules-playlists', () => refresh.regenerateRulesPlaylists('missing-artists-found'));
    })
    .catch(e => {
      syncState.running    = false;
      syncState.lastResult = { ok: false, error: e.message };
      logger.error('sync', `library sync threw (${reason}): ${e.message}`);
    });
}

// ── External service syncs — add new services here ───────────────────────────

function runExternalServiceSyncs() {
  const s = getSettings();

  if (s.lastfm_api_key && s.lastfm_username) {
    runHistoryImport('lastfm', lastfm.fetchListens, { apiKey: s.lastfm_api_key, username: s.lastfm_username });
    runDetached('loved/lastfm',       () => lfmSync.syncLovedLastfm(db, s));
    runDetached('top-artists/lastfm', () => lfmSync.syncTopArtistsLastfm(db, s));
    runDetached('top-tracks/lastfm',  () => lfmSync.syncTopTracksLastfm(db, s));
    runDetached('artist-tags/lastfm', () => lfmSync.syncArtistTagsLastfm(db, s));
    runDetached('playlists/lastfm',   () => lfmSync.syncLfmPlaylists(db, s));
  }

  if (s.listenbrainz_token && s.listenbrainz_username) {
    runHistoryImport('listenbrainz', listenbrainz.fetchListens, { token: s.listenbrainz_token, username: s.listenbrainz_username });
    runDetached('loved/listenbrainz',       () => lbSync.syncLovedListenbrainz(db, s));
    runDetached('top-artists/listenbrainz', () => lbSync.syncTopArtistsListenbrainz(db, s));
    runDetached('top-tracks/listenbrainz',  () => lbSync.syncTopTracksListenbrainz(db, s));
    runDetached('lb-playlists-cache',       () => lbSync.fetchAndCacheLbPlaylists(db, s));
    runDetached('playlists/listenbrainz',   () => lbSync.syncLbPlaylists(db, s));
  }

  if (s.maloja_url && s.maloja_api_key) {
    const malojaProv = require('../../providers/maloja');
    runHistoryImport('maloja', malojaProv.fetchListens, { baseUrl: s.maloja_url, apiKey: s.maloja_api_key });
    runDetached('top-artists/maloja', () => malojaSync.syncTopArtistsMaloja(db, s));
    runDetached('top-tracks/maloja',  () => malojaSync.syncTopTracksMaloja(db, s));
  }

  runDetached('process-missing-artists', () => processMissingArtists());
}

// ── Auto-refresh ──────────────────────────────────────────────────────────────

function startAutoRefresh() {
  // ── 1. Startup: full library sync immediately ────────────────────────────────
  runLibrarySync('startup');

  // ── 2. Startup: external service syncs immediately ───────────────────────────
  runExternalServiceSyncs();

  // ── 3. Every 5 min: lightweight track count poll ───────────────────────────
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

  // ── 4. Every 6 hours: full library sync regardless ──────────────────────────
  setInterval(() => {
    runLibrarySync('6-hour-interval');
  }, 6 * 60 * 60 * 1000);

  // ── 5. Every 30 min: external service syncs ───────────────────────────────
  setInterval(() => {
    runExternalServiceSyncs();
  }, 30 * 60 * 1000);

  // ── 6. On startup: load cron schedules for all naviList / Radio playlists ─────
  refresh.loadScheduledPlaylists();

  logger.info('sync', 'auto-refresh scheduled: library poll every 5m, full sync every 6h, services every 30m, playlist refresh via cron');
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  router,
  getSyncState,
  startAutoRefresh,
};
