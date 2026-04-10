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

// ── Sync state ────────────────────────────────────────────────────────────────

let syncState = {
  running:     false,
  lastStarted: null,
  lastResult:  null
};

let similarSyncState = {
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

// ── Shared helpers (exported for use by provider sync files) ──────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildMatchCacheLocal(db) {
  const rows = db.prepare('SELECT id, artist, title FROM tracks').all();
  const map  = new Map();
  for (const r of rows) {
    const k = `${(r.artist||'').toLowerCase().trim()}|||${(r.title||'').toLowerCase().trim()}`;
    map.set(k, r.id);
  }
  return map;
}

function matchLocal(artist, title, cache) {
  const k = `${(artist||'').toLowerCase().trim()}|||${(title||'').toLowerCase().trim()}`;
  return cache.get(k) || null;
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

function detectSlotKey(title) {
  if (/weekly exploration/i.test(title)) { logger.debug('sync', `slot key detected: weekly_exploration for "${title}"`); return 'weekly_exploration'; }
  if (/daily jams/i.test(title))         { logger.debug('sync', `slot key detected: daily_jams for "${title}"`);         return 'daily_jams'; }
  if (/weekly jams/i.test(title))        { logger.debug('sync', `slot key detected: weekly_jams for "${title}"`);        return 'weekly_jams'; }
  return null;
}

function buildNaviTitle(lbTitle, slotKey) {
  if (slotKey) {
    const dateMatch = lbTitle.match(/(\d{4}-\d{2}-\d{2})/);
    const slotLabel = slotKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return dateMatch
      ? `ListenBrainz - ${slotLabel} - ${dateMatch[1]}`
      : `ListenBrainz - ${slotLabel}`;
  }
  return `ListenBrainz - ${lbTitle}`;
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

// ── Provider sync modules (imported after helpers are defined) ────────────────

const lfmSync = require('./lastfm');
const lbSync  = require('./listenbrainz');
const mbSync  = require('./musicbrainz');

// ── Routes — Navidrome ────────────────────────────────────────────────────────

router.post('/library', async (req, res) => {
  if (syncState.running) return res.json({ ok: false, error: 'Sync already in progress' });

  syncState.running     = true;
  syncState.lastStarted = Math.floor(Date.now() / 1000);
  syncState.lastResult  = null;
  logger.info('sync', 'library sync triggered via UI');

  navidrome.syncLibrary(db).then(result => {
    syncState.running    = false;
    syncState.lastResult = result;
    logger.info('sync', `sync finished — ok: ${result.ok}`);
  }).catch(e => {
    syncState.running    = false;
    syncState.lastResult = { ok: false, error: e.message };
    logger.error('sync', `sync threw: ${e.message}`);
  });

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

router.post('/similar-artists', (req, res) => {
  if (similarSyncState.running)
    return res.json({ ok: false, error: 'Similar artists sync already in progress' });
  similarSyncState.running     = true;
  similarSyncState.lastStarted = Math.floor(Date.now() / 1000);
  similarSyncState.lastResult  = null;
  logger.info('sync', 'similar artists sync triggered');
  const s = getSettings();
  lfmSync.syncSimilarArtistsLastfm(db, s).then(result => {
    similarSyncState.running    = false;
    similarSyncState.lastResult = result;
    logger.info('sync', `similar artists sync finished — ok: ${result.ok}`);
  }).catch(e => {
    similarSyncState.running    = false;
    similarSyncState.lastResult = { ok: false, error: e.message };
    logger.error('sync', `similar artists sync threw: ${e.message}`);
  });
  res.json({ ok: true, message: 'Similar artists sync started' });
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
  const playlists = db.prepare('SELECT * FROM lb_playlists ORDER BY playlist_type, title').all();
  const tracks    = db.prepare('SELECT * FROM lb_playlist_tracks ORDER BY position').all();
  const trackMap  = new Map();
  for (const t of tracks) {
    if (!trackMap.has(t.lb_mbid)) trackMap.set(t.lb_mbid, []);
    trackMap.get(t.lb_mbid).push({ artist: t.artist, title: t.title, matched: !!t.matched });
  }
  res.json({ ok: true, playlists: playlists.map(p => ({ ...p, tracks: trackMap.get(p.lb_mbid) || [] })) });
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

router.post('/lb-playlists/toggle', (req, res) => {
  const { lb_mbid, title, playlist_type, field, value } = req.body;
  if (!lb_mbid || !['enabled', 'protected'].includes(field))
    return res.json({ ok: false, error: 'lb_mbid and field (enabled|protected) required' });

  const existing      = db.prepare('SELECT * FROM lb_playlists WHERE lb_mbid = ?').get(lb_mbid) || {};
  const resolvedTitle = title || existing.title || '';
  db.prepare(`
    INSERT INTO lb_playlists (lb_mbid, title, playlist_type, enabled, protected, slot_key)
    VALUES (@lb_mbid, @title, @playlist_type, @enabled, @protected, @slot_key)
    ON CONFLICT(lb_mbid) DO UPDATE SET
      title         = excluded.title,
      playlist_type = excluded.playlist_type,
      enabled       = excluded.enabled,
      protected     = excluded.protected
  `).run({
    lb_mbid,
    title:         resolvedTitle,
    playlist_type: playlist_type || existing.playlist_type || 'generated',
    slot_key:      existing.slot_key ?? detectSlotKey(resolvedTitle),
    enabled:   field === 'enabled'   ? (value ? 1 : 0) : (existing.enabled   ?? 0),
    protected: field === 'protected' ? (value ? 1 : 0) : (existing.protected ?? 0)
  });
  res.json({ ok: true });
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
  const existing = db.prepare('SELECT * FROM lb_playlists WHERE lb_mbid = ?').get(mbid);
  if (!existing) return res.json({ ok: false, error: 'Playlist not found — run Sync All from Services first' });

  db.prepare('UPDATE lb_playlists SET enabled = 1 WHERE lb_mbid = ?').run(mbid);
  const row       = db.prepare('SELECT * FROM lb_playlists WHERE lb_mbid = ?').get(mbid);
  const cache     = buildMatchCacheLocal(db);
  const cachedRows = db.prepare('SELECT * FROM lb_playlist_tracks WHERE lb_mbid = ? AND matched = 1 ORDER BY position').all(mbid);
  if (!cachedRows.length) return res.json({ ok: false, error: 'No matched tracks cached — run Sync All from Services first' });

  const trackIds = cachedRows.map(r => matchLocal(r.artist, r.title, cache)).filter(Boolean);
  if (!trackIds.length) return res.json({ ok: false, error: 'No tracks matched in your library' });

  try {
    const comment      = `navilist:lb ${JSON.stringify({ source: 'listenbrainz', mbid })}`;
    const now          = Math.floor(Date.now() / 1000);
    const displayTitle = buildNaviTitle(row.title, row.slot_key);
    const updateRow    = db.prepare('UPDATE lb_playlists SET navidrome_id = ?, last_imported_at = ? WHERE lb_mbid = ?');

    let navId = row.navidrome_id;
    if (!navId && row.slot_key) {
      const slotRow = db.prepare('SELECT navidrome_id FROM lb_playlists WHERE slot_key = ? AND navidrome_id IS NOT NULL LIMIT 1').get(row.slot_key);
      navId = slotRow?.navidrome_id || null;
    }

    if (navId) {
      const replaceResult = await navidrome.replacePlaylistTracks(db, navId, trackIds);
      if (replaceResult.ok) {
        await navidrome.updatePlaylist(db, navId, { comment });
        updateRow.run(navId, now, mbid);
      } else {
        logger.warn('sync', `lb-import: navId ${navId} stale, clearing and creating fresh`);
        db.prepare('UPDATE lb_playlists SET navidrome_id = NULL WHERE navidrome_id = ?').run(navId);
        const result = await navidrome.createPlaylist(db, displayTitle, trackIds);
        if (!result.ok) return res.json({ ok: false, error: result.error });
        await navidrome.updatePlaylist(db, result.playlist.id, { comment });
        updateRow.run(result.playlist.id, now, mbid);
      }
    } else {
      const result = await navidrome.createPlaylist(db, displayTitle, trackIds);
      if (!result.ok) return res.json({ ok: false, error: result.error });
      await navidrome.updatePlaylist(db, result.playlist.id, { comment });
      updateRow.run(result.playlist.id, now, mbid);
    }

    logger.info('sync', `lb-import: "${row.title}" → "${displayTitle}" (${trackIds.length} tracks)`);
    res.json({ ok: true, count: trackIds.length });
  } catch (e) {
    logger.error('sync', `lb-import failed for ${mbid}: ${e.message}`);
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

// ── Routes — Status ───────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  const trackCount   = db.prepare('SELECT COUNT(*) as c FROM tracks').get().c;
  const lastSync     = db.prepare('SELECT MAX(synced_at) as s FROM tracks').get().s;
  const similarCount = db.prepare('SELECT COUNT(DISTINCT artist_id) as c FROM artist_similar').get().c;
  const tagCount     = db.prepare('SELECT COUNT(DISTINCT artist_id) as c FROM artist_tags').get().c;
  res.json({
    running:     syncState.running,
    lastStarted: syncState.lastStarted,
    lastResult:  syncState.lastResult,
    trackCount,
    lastSync,
    similarArtistsCount: similarCount,
    similarSync:         similarSyncState,
    artistTagsCount:     tagCount,
    tagSync:             tagSyncState
  });
});

// ── Auto-refresh ──────────────────────────────────────────────────────────────

function startAutoRefresh() {
  setInterval(() => {
    const s = getSettings();

    if (s.lastfm_api_key && s.lastfm_username) {
      runHistoryImport('lastfm', lastfm.fetchListens, { apiKey: s.lastfm_api_key, username: s.lastfm_username });
      runDetached('loved/lastfm',            () => lfmSync.syncLovedLastfm(db, s));
      runDetached('top-artists/lastfm',      () => lfmSync.syncTopArtistsLastfm(db, s));
      runDetached('top-tracks/lastfm',       () => lfmSync.syncTopTracksLastfm(db, s));
      runDetached('artist-tags/lastfm',      () => lfmSync.syncArtistTagsLastfm(db, s));
      runDetached('similar-artists/lastfm',  () => lfmSync.syncSimilarArtistsLastfm(db, s));
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

  logger.info('sync', 'history auto-refresh scheduled every 30 minutes');
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  router,
  getSyncState,
  getSimilarSyncState: () => similarSyncState,
  getTagSyncState:     () => tagSyncState,
  startAutoRefresh,
  // Helpers exported for use by provider sync files
  sleep,
  buildMatchCacheLocal,
  matchLocal,
  resolveArtistWithAliases,
  detectSlotKey,
  buildNaviTitle,
  writeMissingArtists,
  processMissingArtists
};
