const express = require('express');
const router = express.Router();
const db = require('../db/index');
const navidrome = require('../providers/navidrome');
const lastfm = require('../providers/lastfm');
const listenbrainz = require('../providers/listenbrainz');
const lidarr    = require('../providers/lidarr');
const mb        = require('../providers/musicbrainz');
const { ingestListens } = require('./ingestion');
const logger = require('../utils/logger');

// Sync state — in memory, single instance
let syncState = {
  running: false,
  lastStarted: null,
  lastResult: null
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

function getSyncState() {
  return syncState;
}

// ── Sync state helpers (DB-backed for history sources) ────────────────────────

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

// ── History import runner (shared across all sources) ─────────────────────────

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

    const listens = await fetchFn(credentials, { since });
    const result  = ingestListens(db, listens);

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

// POST /sync/library — kick off async sync
router.post('/library', async (req, res) => {
  if (syncState.running) {
    return res.json({ ok: false, error: 'Sync already in progress' });
  }

  syncState.running = true;
  syncState.lastStarted = Math.floor(Date.now() / 1000);
  syncState.lastResult = null;

  logger.info('sync', 'library sync triggered via UI');

  // Run async — do not await, return immediately
  navidrome.syncLibrary(db).then(result => {
    syncState.running = false;
    syncState.lastResult = result;
    logger.info('sync', `sync finished — ok: ${result.ok}`);
  }).catch(e => {
    syncState.running = false;
    syncState.lastResult = { ok: false, error: e.message };
    logger.error('sync', `sync threw: ${e.message}`);
  });

  res.json({ ok: true, message: 'Sync started' });
});

// POST /sync/similar-artists — kick off async Last.fm similar artists sync
router.post('/similar-artists', async (req, res) => {
  if (similarSyncState.running) {
    return res.json({ ok: false, error: 'Similar artists sync already in progress' });
  }

  similarSyncState.running     = true;
  similarSyncState.lastStarted = Math.floor(Date.now() / 1000);
  similarSyncState.lastResult  = null;

  logger.info('sync', 'similar artists sync triggered');

  navidrome.syncSimilarArtists(db).then(result => {
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

// POST /sync/artist-tags — kick off async MusicBrainz artist tags sync
router.post('/artist-tags', async (req, res) => {
  if (tagSyncState.running) {
    return res.json({ ok: false, error: 'Artist tags sync already in progress' });
  }

  tagSyncState.running     = true;
  tagSyncState.lastStarted = Math.floor(Date.now() / 1000);
  tagSyncState.lastResult  = null;

  logger.info('sync', 'artist tags sync triggered');

  navidrome.syncArtistTags(db).then(result => {
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

// POST /sync/history/lastfm
router.post('/history/lastfm', (req, res) => {
  const s = getSettings();
  if (!s.lastfm_api_key || !s.lastfm_username) {
    return res.json({ ok: false, error: 'Last.fm API key and username required' });
  }
  const force = req.query.force === 'true';
  runHistoryImport('lastfm', lastfm.fetchListens, {
    apiKey:   s.lastfm_api_key,
    username: s.lastfm_username
  }, force);
  res.json({ ok: true, message: 'Last.fm history import started' });
});

// POST /sync/history/listenbrainz
router.post('/history/listenbrainz', (req, res) => {
  const s = getSettings();
  if (!s.listenbrainz_token || !s.listenbrainz_username) {
    return res.json({ ok: false, error: 'ListenBrainz token and username required' });
  }
  const force = req.query.force === 'true';
  runHistoryImport('listenbrainz', listenbrainz.fetchListens, {
    token:    s.listenbrainz_token,
    username: s.listenbrainz_username
  }, force);
  res.json({ ok: true, message: 'ListenBrainz history import started' });
});

// GET /sync/history/status
router.get('/history/status', (req, res) => {
  res.json({
    ok:           true,
    lastfm:       getSyncStateFromDb('lastfm'),
    listenbrainz: getSyncStateFromDb('listenbrainz')
  });
});

// ── Loved tracks sync ────────────────────────────────────────────────────────

async function syncLovedLastfm(db, settings) {
  const { lastfm_api_key: apiKey, lastfm_username: username } = settings;
  if (!apiKey || !username) return { ok: false, error: 'Last.fm credentials required' };

  const data   = await lastfm.getLovedTracks(apiKey, username, 1000);
  const tracks = data?.lovedtracks?.track;
  if (!tracks) return { ok: false, error: 'No loved tracks returned' };
  const arr = Array.isArray(tracks) ? tracks : [tracks];

  const cache     = buildMatchCacheLocal(db);
  const fetchedAt = Math.floor(Date.now() / 1000);
  const upsert    = db.prepare(`
    INSERT INTO loved_tracks (track_id, source, score, loved_at)
    VALUES (@track_id, 'lastfm', 1, @loved_at)
    ON CONFLICT(track_id, source) DO UPDATE SET score=1, loved_at=excluded.loved_at
  `);

  let matched = 0, unmatched = 0;
  const insertMany = db.transaction(rows => { for (const r of rows) upsert.run(r); });
  const rows = [];

  for (const t of arr) {
    const artist = t.artist?.name || '';
    const title  = t.name || '';
    const id     = matchLocal(artist, title, cache);
    if (!id) { unmatched++; continue; }
    rows.push({ track_id: id, loved_at: parseInt(t.date?.uts) || fetchedAt });
    matched++;
  }
  if (rows.length) insertMany(rows);
  logger.info('sync', `loved/lastfm: ${matched} matched, ${unmatched} unmatched`);
  return { ok: true, matched, unmatched, total: arr.length };
}

async function syncLovedListenbrainz(db, settings) {
  const { listenbrainz_token: token, listenbrainz_username: username } = settings;
  if (!token || !username) return { ok: false, error: 'ListenBrainz credentials required' };

  const cache     = buildMatchCacheLocal(db);
  const fetchedAt = Math.floor(Date.now() / 1000);
  const upsert    = db.prepare(`
    INSERT INTO loved_tracks (track_id, source, score, loved_at)
    VALUES (@track_id, 'listenbrainz', @score, @loved_at)
    ON CONFLICT(track_id, source) DO UPDATE SET score=excluded.score, loved_at=excluded.loved_at
  `);

  let matched = 0, unmatched = 0, total = 0;
  const insertMany = db.transaction(rows => { for (const r of rows) upsert.run(r); });

  for (const score of [1, -1]) {
    const data     = await listenbrainz.getFeedback(token, username, score, 1000, 0);
    const feedback = data?.feedback;
    if (!feedback?.length) continue;
    total += feedback.length;
    const rows = [];
    for (const f of feedback) {
      // LB feedback has recording_name + artist_name in some responses
      const artist = f.track_metadata?.artist_name || '';
      const title  = f.track_metadata?.track_name  || '';
      const id     = matchLocal(artist, title, cache);
      if (!id) { unmatched++; continue; }
      rows.push({ track_id: id, score, loved_at: f.created || fetchedAt });
      matched++;
    }
    if (rows.length) insertMany(rows);
  }
  logger.info('sync', `loved/listenbrainz: ${matched} matched, ${unmatched} unmatched`);
  return { ok: true, matched, unmatched, total };
}

router.post('/loved/lastfm', async (req, res) => {
  const s = getSettings();
  if (!s.lastfm_api_key || !s.lastfm_username)
    return res.json({ ok: false, error: 'Last.fm credentials required' });
  runDetached('loved/lastfm', () => syncLovedLastfm(db, s));
  res.json({ ok: true, message: 'Last.fm loved tracks sync started' });
});

router.post('/loved/listenbrainz', async (req, res) => {
  const s = getSettings();
  if (!s.listenbrainz_token || !s.listenbrainz_username)
    return res.json({ ok: false, error: 'ListenBrainz credentials required' });
  runDetached('loved/listenbrainz', () => syncLovedListenbrainz(db, s));
  res.json({ ok: true, message: 'ListenBrainz loved tracks sync started' });
});

// ── Top artists sync ──────────────────────────────────────────────────────────

const LFM_PERIODS = ['7day', '1month', '3month', '6month', '12month', 'overall'];
const LB_PERIODS  = ['week', 'month', 'quarter', 'half_year', 'year', 'all_time'];

async function syncTopArtistsLastfm(db, settings) {
  const { lastfm_api_key: apiKey, lastfm_username: username } = settings;
  if (!apiKey || !username) return { ok: false, error: 'Last.fm credentials required' };

  const upsert = db.prepare(`
    INSERT INTO user_top_artists (artist_id, source, period, rank, play_count, fetched_at)
    VALUES (@artist_id, 'lastfm', @period, @rank, @play_count, @fetched_at)
    ON CONFLICT(artist_id, source, period) DO UPDATE SET
      rank=excluded.rank, play_count=excluded.play_count, fetched_at=excluded.fetched_at
  `);
  const resolveArtist = db.prepare('SELECT DISTINCT artist_id FROM tracks WHERE LOWER(artist) = LOWER(?) LIMIT 1');
  const fetchedAt = Math.floor(Date.now() / 1000);
  let total = 0;

  for (const period of LFM_PERIODS) {
    const data    = await lastfm.getTopArtists(apiKey, username, period, 50);
    const artists = data?.topartists?.artist;
    if (!artists?.length) continue;
    const arr = Array.isArray(artists) ? artists : [artists];
    const rows = [];
    const missing = [];
    arr.forEach((a, i) => {
      const row = resolveArtist.get(a.name);
      if (!row) { missing.push(a.name); return; }
      rows.push({ artist_id: row.artist_id, period, rank: i + 1, play_count: parseInt(a.playcount) || null, fetched_at: fetchedAt });
    });
    const insertMany = db.transaction(rs => { for (const r of rs) upsert.run(r); });
    insertMany(rows);
    total += rows.length;
    if (missing.length) writeMissingArtists(db, missing, 'lastfm_top_artists');
    await sleep(1000);
  }
  logger.info('sync', `top-artists/lastfm: ${total} rows written`);
  return { ok: true, total };
}

async function syncTopArtistsListenbrainz(db, settings) {
  const { listenbrainz_token: token, listenbrainz_username: username } = settings;
  if (!token || !username) return { ok: false, error: 'ListenBrainz credentials required' };

  const upsert = db.prepare(`
    INSERT INTO user_top_artists (artist_id, source, period, rank, play_count, fetched_at)
    VALUES (@artist_id, 'listenbrainz', @period, @rank, @play_count, @fetched_at)
    ON CONFLICT(artist_id, source, period) DO UPDATE SET
      rank=excluded.rank, play_count=excluded.play_count, fetched_at=excluded.fetched_at
  `);
  const resolveArtist = db.prepare('SELECT DISTINCT artist_id FROM tracks WHERE LOWER(artist) = LOWER(?) LIMIT 1');
  const fetchedAt = Math.floor(Date.now() / 1000);
  let total = 0;

  for (const period of LB_PERIODS) {
    const data    = await listenbrainz.getTopArtists(token, username, period, 50);
    const artists = data?.payload?.artists;
    if (!artists?.length) continue;
    const rows = [];
    const missing = [];
    artists.forEach((a, i) => {
      const row = resolveArtist.get(a.artist_name);
      if (!row) { missing.push(a.artist_name); return; }
      rows.push({ artist_id: row.artist_id, period, rank: i + 1, play_count: a.listen_count || null, fetched_at: fetchedAt });
    });
    const insertMany = db.transaction(rs => { for (const r of rs) upsert.run(r); });
    insertMany(rows);
    total += rows.length;
    if (missing.length) writeMissingArtists(db, missing, 'lb_top_artists');
    await sleep(1000);
  }
  logger.info('sync', `top-artists/listenbrainz: ${total} rows written`);
  return { ok: true, total };
}

router.post('/top-artists/lastfm', async (req, res) => {
  const s = getSettings();
  if (!s.lastfm_api_key || !s.lastfm_username)
    return res.json({ ok: false, error: 'Last.fm credentials required' });
  runDetached('top-artists/lastfm', () => syncTopArtistsLastfm(db, s));
  res.json({ ok: true, message: 'Last.fm top artists sync started' });
});

router.post('/top-artists/listenbrainz', async (req, res) => {
  const s = getSettings();
  if (!s.listenbrainz_token || !s.listenbrainz_username)
    return res.json({ ok: false, error: 'ListenBrainz credentials required' });
  runDetached('top-artists/listenbrainz', () => syncTopArtistsListenbrainz(db, s));
  res.json({ ok: true, message: 'ListenBrainz top artists sync started' });
});

// ── Top tracks sync ───────────────────────────────────────────────────────────

async function syncTopTracksLastfm(db, settings) {
  const { lastfm_api_key: apiKey, lastfm_username: username } = settings;
  if (!apiKey || !username) return { ok: false, error: 'Last.fm credentials required' };

  const cache  = buildMatchCacheLocal(db);
  const upsert = db.prepare(`
    INSERT INTO user_top_tracks (track_id, source, period, rank, play_count, fetched_at)
    VALUES (@track_id, 'lastfm', @period, @rank, @play_count, @fetched_at)
    ON CONFLICT(track_id, source, period) DO UPDATE SET
      rank=excluded.rank, play_count=excluded.play_count, fetched_at=excluded.fetched_at
  `);
  const fetchedAt = Math.floor(Date.now() / 1000);
  let total = 0;

  for (const period of LFM_PERIODS) {
    const data   = await lastfm.getTopTracks(apiKey, username, period, 50);
    const tracks = data?.toptracks?.track;
    if (!tracks?.length) continue;
    const arr  = Array.isArray(tracks) ? tracks : [tracks];
    const rows = [];
    arr.forEach((t, i) => {
      const id = matchLocal(t.artist?.name || '', t.name || '', cache);
      if (!id) return;
      rows.push({ track_id: id, period, rank: i + 1, play_count: parseInt(t.playcount) || null, fetched_at: fetchedAt });
    });
    const insertMany = db.transaction(rs => { for (const r of rs) upsert.run(r); });
    insertMany(rows);
    total += rows.length;
    await sleep(1000);
  }
  logger.info('sync', `top-tracks/lastfm: ${total} rows written`);
  return { ok: true, total };
}

async function syncTopTracksListenbrainz(db, settings) {
  const { listenbrainz_token: token, listenbrainz_username: username } = settings;
  if (!token || !username) return { ok: false, error: 'ListenBrainz credentials required' };

  const cache  = buildMatchCacheLocal(db);
  const upsert = db.prepare(`
    INSERT INTO user_top_tracks (track_id, source, period, rank, play_count, fetched_at)
    VALUES (@track_id, 'listenbrainz', @period, @rank, @play_count, @fetched_at)
    ON CONFLICT(track_id, source, period) DO UPDATE SET
      rank=excluded.rank, play_count=excluded.play_count, fetched_at=excluded.fetched_at
  `);
  const fetchedAt = Math.floor(Date.now() / 1000);
  let total = 0;

  for (const period of LB_PERIODS) {
    const data       = await listenbrainz.getTopRecordings(token, username, period, 50);
    const recordings = data?.payload?.recordings;
    if (!recordings?.length) continue;
    const rows = [];
    recordings.forEach((r, i) => {
      const id = matchLocal(r.artist_name || '', r.track_name || '', cache);
      if (!id) return;
      rows.push({ track_id: id, period, rank: i + 1, play_count: r.listen_count || null, fetched_at: fetchedAt });
    });
    const insertMany = db.transaction(rs => { for (const r of rs) upsert.run(r); });
    insertMany(rows);
    total += rows.length;
    await sleep(1000);
  }
  logger.info('sync', `top-tracks/listenbrainz: ${total} rows written`);
  return { ok: true, total };
}

router.post('/top-tracks/lastfm', async (req, res) => {
  const s = getSettings();
  if (!s.lastfm_api_key || !s.lastfm_username)
    return res.json({ ok: false, error: 'Last.fm credentials required' });
  runDetached('top-tracks/lastfm', () => syncTopTracksLastfm(db, s));
  res.json({ ok: true, message: 'Last.fm top tracks sync started' });
});

router.post('/top-tracks/listenbrainz', async (req, res) => {
  const s = getSettings();
  if (!s.listenbrainz_token || !s.listenbrainz_username)
    return res.json({ ok: false, error: 'ListenBrainz credentials required' });
  runDetached('top-tracks/listenbrainz', () => syncTopTracksListenbrainz(db, s));
  res.json({ ok: true, message: 'ListenBrainz top tracks sync started' });
});

// ── Last.fm artist tags sync ──────────────────────────────────────────────────

async function syncArtistTagsLastfm(db, settings) {
  const { lastfm_api_key: apiKey } = settings;
  if (!apiKey) return { ok: false, error: 'Last.fm API key required' };

  const artists = db.prepare('SELECT DISTINCT artist_id, artist FROM tracks WHERE artist_id IS NOT NULL AND artist IS NOT NULL').all();
  const cached  = new Set(db.prepare("SELECT DISTINCT artist_id FROM artist_tags WHERE source = 'lastfm'").all().map(r => r.artist_id));
  const todo    = artists.filter(a => !cached.has(a.artist_id));

  logger.info('sync', `artist-tags/lastfm: ${todo.length} artists to fetch`);
  if (!todo.length) return { ok: true, fetched: 0, failed: 0, total: 0 };

  const upsert = db.prepare(`
    INSERT INTO artist_tags (artist_id, tag, weight, source, fetched_at)
    VALUES (@artistId, @tag, @weight, 'lastfm', @fetchedAt)
    ON CONFLICT(artist_id, tag) DO UPDATE SET weight=excluded.weight, fetched_at=excluded.fetched_at
  `);
  const sentinel = db.prepare(`
    INSERT OR IGNORE INTO artist_tags (artist_id, tag, weight, source, fetched_at)
    VALUES (?, '__none__', 0, 'lastfm', ?)
  `);

  let fetched = 0, failed = 0;
  const fetchedAt = Math.floor(Date.now() / 1000);

  for (const { artist_id, artist } of todo) {
    try {
      const data = await lastfm.getArtistTopTags(apiKey, artist);
      const tags = data?.toptags?.tag;
      if (!tags?.length) { sentinel.run(artist_id, fetchedAt); fetched++; await sleep(1000); continue; }
      const arr = Array.isArray(tags) ? tags : [tags];
      const insertMany = db.transaction(rows => { for (const r of rows) upsert.run(r); });
      insertMany(arr.map(t => ({ artistId: artist_id, tag: t.name.toLowerCase(), weight: parseInt(t.count) || 0, fetchedAt })));
      fetched++;
    } catch (e) {
      failed++;
      logger.warn('sync', `artist-tags/lastfm failed for "${artist}": ${e.message}`);
    }
    await sleep(1000);
  }
  logger.info('sync', `artist-tags/lastfm: ${fetched} fetched, ${failed} failed`);
  return { ok: true, fetched, failed, total: todo.length };
}

router.post('/artist-tags/lastfm', async (req, res) => {
  const s = getSettings();
  if (!s.lastfm_api_key) return res.json({ ok: false, error: 'Last.fm API key required' });
  runDetached('artist-tags/lastfm', () => syncArtistTagsLastfm(db, s));
  res.json({ ok: true, message: 'Last.fm artist tags sync started' });
});

// ── Shared helpers ────────────────────────────────────────────────────────────

// Simple in-process match cache for sync jobs (not ingestion pipeline)
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

// Session-level alias cache: artist_mbid → resolved local artist name (or original if no alias found)
const artistAliasCache = new Map();

async function resolveArtistWithAliases(artistName, artistMbid, cache) {
  const nameLower = (artistName || '').toLowerCase().trim();

  // Check if already resolved this MBID this session
  if (artistMbid && artistAliasCache.has(artistMbid)) {
    logger.debug('sync', `alias cache hit: "${artistName}" (${artistMbid}) → "${artistAliasCache.get(artistMbid)}"`);
    return artistAliasCache.get(artistMbid);
  }

  // Check if exact name already exists in cache
  const prefix = `${nameLower}|||`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      if (artistMbid) artistAliasCache.set(artistMbid, artistName);
      return artistName;
    }
  }

  // No MBID to look up aliases with
  if (!artistMbid) return artistName;

  // Fetch aliases from MB and try each against the local cache
  try {
    const aliases = await mb.getArtistAliases(artistMbid);
    await sleep(1000); // MB rate limit
    for (const alias of aliases) {
      const aliasLower = alias.toLowerCase().trim();
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
    return artistName; // don't cache — allow retry on next sync
  }

  // MB responded but no alias matched — cache the confirmed miss
  logger.info('sync', `alias miss for "${artistName}" (${artistMbid}) — no alias matched local cache`);
  artistAliasCache.set(artistMbid, artistName);
  return artistName;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Detect rotation slot key from a playlist title
// Returns a slot key string if the playlist belongs to a known rotating series, or null
function detectSlotKey(title) {
  if (/weekly exploration/i.test(title)) { logger.debug('sync', `slot key detected: weekly_exploration for "${title}"`); return 'weekly_exploration'; }
  if (/daily jams/i.test(title))         { logger.debug('sync', `slot key detected: daily_jams for "${title}"`);         return 'daily_jams'; }
  if (/weekly jams/i.test(title))        { logger.debug('sync', `slot key detected: weekly_jams for "${title}"`);        return 'weekly_jams'; }
  return null;
}

// Build a Navidrome display title from an LB playlist title and slot key
// Slot: "Weekly Exploration for m0zer, week of 2026-03-30 Mon" → "ListenBrainz - Weekly Exploration - 2026-03-30"
// Non-slot: "LB Radio for artist Tool on hard mode" → "ListenBrainz - LB Radio for artist Tool on hard mode"
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

// Fire-and-forget runner for one-off sync jobs
const detachedRunning = new Set();
function runDetached(name, fn) {
  if (detachedRunning.has(name)) {
    logger.warn('sync', `${name} already running — skipping`);
    return;
  }
  detachedRunning.add(name);
  fn().catch(e => logger.error('sync', `${name} threw: ${e.message}`)).finally(() => detachedRunning.delete(name));
}

// ── Missing artists ──────────────────────────────────────────────────────────────

/**
 * Write a list of artist names to missing_artists if not already present.
 * Only inserts artists that genuinely aren't in the local tracks table.
 */
function writeMissingArtists(db, artistNames, source) {
  const isInLibrary = db.prepare('SELECT 1 FROM tracks WHERE LOWER(artist) = LOWER(?) LIMIT 1');
  const insert = db.prepare(`
    INSERT OR IGNORE INTO missing_artists (artist_name, source, status, added_at)
    VALUES (?, ?, 'pending', ?)
  `);
  const now = Math.floor(Date.now() / 1000);
  let added = 0;
  const insertMany = db.transaction(names => {
    for (const name of names) {
      if (!name || isInLibrary.get(name)) continue;
      insert.run(name, source, now);
      added++;
    }
  });
  insertMany(artistNames);
  if (added > 0) logger.info('sync', `missing_artists: ${added} new entries from ${source}`);
  return added;
}

/**
 * Process pending missing artists:
 * 1. Look up MBID via MusicBrainz
 * 2. Send to Lidarr
 * 3. Mark as 'sent'
 */
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

  const setStatus = db.prepare(`
    UPDATE missing_artists SET status = ?, mbid = ?, sent_at = ? WHERE id = ?
  `);

  for (const artist of pending) {
    try {
      // 1. Look up MBID
      const mbid = await mb.findArtistMbid(artist.artist_name);
      if (!mbid) {
        logger.warn('sync', `processMissingArtists: no MBID found for "${artist.artist_name}" — skipping`);
        setStatus.run('ignored', null, null, artist.id);
        await sleep(500);
        continue;
      }

      // 2. Send to Lidarr
      const result = await lidarr.addArtist(settings, artist.artist_name, mbid);
      const now    = Math.floor(Date.now() / 1000);

      if (result.ok) {
        setStatus.run(result.skipped ? 'sent' : 'sent', mbid, now, artist.id);
        logger.info('sync', `processMissingArtists: sent "${artist.artist_name}" to Lidarr${result.skipped ? ' (already existed)' : ''}`);
      } else {
        logger.warn('sync', `processMissingArtists: Lidarr rejected "${artist.artist_name}": ${result.error}`);
      }
    } catch (e) {
      logger.warn('sync', `processMissingArtists: error processing "${artist.artist_name}": ${e.message}`);
    }
    await sleep(1000); // MusicBrainz rate limit
  }
}

// GET /sync/lb-playlists/:mbid/tracks — read from DB cache, no external calls
router.get('/lb-playlists/:mbid/tracks', (req, res) => {
  const { mbid } = req.params;
  const rows = db.prepare('SELECT * FROM lb_playlist_tracks WHERE lb_mbid = ? ORDER BY position').all(mbid);
  if (!rows.length) return res.json({ ok: false, error: 'No cached tracks for this playlist. Run Sync All from Services first.' });
  const tracks = rows.map(r => ({ artist: r.artist, title: r.title, matched: !!r.matched }));
  const matched = tracks.filter(t => t.matched).length;
  res.json({ ok: true, total: tracks.length, matched, tracks });
});

// Shared fetch-and-cache logic for LB playlists
async function fetchAndCacheLbPlaylists(db, s) {
  if (!s.listenbrainz_token || !s.listenbrainz_username)
    throw new Error('ListenBrainz credentials required');

  const BASE     = 'https://api.listenbrainz.org/1';
  const username = s.listenbrainz_username;
  const token    = s.listenbrainz_token;
  const headers  = { Authorization: `Token ${token}` };

  const [cfRes, ownRes] = await Promise.all([
    fetch(`${BASE}/user/${username}/playlists/createdfor`, { headers }),
    fetch(`${BASE}/user/${username}/playlists`, { headers })
  ]);
  const cfData  = cfRes.ok  ? await cfRes.json()  : { playlists: [] };
  const ownData = ownRes.ok ? await ownRes.json() : { playlists: [] };

  const normalise = (playlists, type) => (playlists || []).map(pl => ({
    lb_mbid:       pl.playlist?.identifier?.split('/playlist/')?.[1]?.replace(/\/$/, '') || null,
    title:         pl.playlist?.title || 'Untitled',
    playlist_type: type
  })).filter(p => p.lb_mbid);

  const remote = [
    ...normalise(cfData.playlists,  'generated'),
    ...normalise(ownData.playlists, 'user')
  ];

  const saved    = db.prepare('SELECT * FROM lb_playlists').all();
  const savedMap = new Map(saved.map(r => [r.lb_mbid, r]));

  const merged = remote.map(p => {
    const row = savedMap.get(p.lb_mbid) || {};
    return {
      lb_mbid:          p.lb_mbid,
      title:            p.title,
      playlist_type:    p.playlist_type,
      enabled:          row.enabled          ?? 0,
      protected:        row.protected        ?? 0,
      navidrome_id:     row.navidrome_id     ?? null,
      last_imported_at: row.last_imported_at ?? null,
      slot_key:         row.slot_key         ?? detectSlotKey(p.title),
    };
  });

  db.prepare(`INSERT INTO settings (key, value) VALUES ('lb_playlist_count', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(remote.length));

  // For each remote playlist, detect slot key and carry forward state from previous slot row
  const getSlotRow = db.prepare('SELECT * FROM lb_playlists WHERE slot_key = ? AND lb_mbid != ? ORDER BY id DESC LIMIT 1');
  const upsertPl = db.prepare(`
    INSERT INTO lb_playlists (lb_mbid, title, playlist_type, enabled, protected, slot_key, navidrome_id)
    VALUES (@lb_mbid, @title, @playlist_type, @enabled, @protected, @slot_key, @navidrome_id)
    ON CONFLICT(lb_mbid) DO UPDATE SET
      title         = excluded.title,
      playlist_type = excluded.playlist_type,
      slot_key      = excluded.slot_key,
      navidrome_id  = COALESCE(lb_playlists.navidrome_id, excluded.navidrome_id)
  `);
  const upsertMany = db.transaction(rows => { for (const r of rows) upsertPl.run(r); });
  upsertMany(remote.map(p => {
    const existing    = savedMap.get(p.lb_mbid) || {};
    const slotKey     = detectSlotKey(p.title);
    const slotRow     = slotKey ? getSlotRow.get(slotKey, p.lb_mbid) : null;
    const enabled     = existing.enabled      ?? slotRow?.enabled      ?? 0;
    const navidrome_id = existing.navidrome_id ?? slotRow?.navidrome_id ?? null;
    return {
      lb_mbid:       p.lb_mbid,
      title:         p.title,
      playlist_type: p.playlist_type,
      enabled,
      protected:     existing.protected ?? 0,
      slot_key:      slotKey,
      navidrome_id,
    };
  }));

  logger.info('sync', `lb-playlists: fetched ${remote.length} playlists from LB`);

  // Resolve tracks for every playlist and cache in lb_playlist_tracks
  const cache = buildMatchCacheLocal(db);
  const deleteTracks = db.prepare('DELETE FROM lb_playlist_tracks WHERE lb_mbid = ?');
  const insertTrack  = db.prepare(`
    INSERT INTO lb_playlist_tracks (lb_mbid, position, artist, title, matched)
    VALUES (@lb_mbid, @position, @artist, @title, @matched)
  `);

  for (const p of remote) {
    try {
      const plRes = await fetch(`${BASE}/playlist/${p.lb_mbid}`, { headers });
      if (!plRes.ok) { logger.warn('sync', `lb-playlists: failed to fetch tracks for ${p.title}: ${plRes.status}`); continue; }
      const plData = await plRes.json();
      const jspf   = plData?.playlist;
      if (!jspf) continue;

      const jspfTracks = jspf.track || [];
      if (!jspfTracks.length) continue;

      const trackRows = [];
      for (let i = 0; i < jspfTracks.length; i++) {
        const t          = jspfTracks[i];
        const title      = t.title || 'Unknown track';
        const artists    = t.extension?.['https://musicbrainz.org/doc/jspf#track']
                           ?.additional_metadata?.artists || [];
        const artistName = artists[0]?.artist_credit_name || t.creator || 'Unknown';
        const artistMbid = artists[0]?.artist_mbid || null;
        const resolved   = await resolveArtistWithAliases(artistName, artistMbid, cache);
        const id         = matchLocal(resolved, title, cache);
        logger.debug('sync', `lb track match: "${artistName}" / "${title}" → ${id ? 'matched' : 'unmatched'}`);
        trackRows.push({ lb_mbid: p.lb_mbid, position: i, artist: artistName, title, matched: id ? 1 : 0 });
      }

      const replaceAll = db.transaction(() => {
        deleteTracks.run(p.lb_mbid);
        for (const r of trackRows) insertTrack.run(r);
      });
      replaceAll();

      const matchedCount = trackRows.filter(r => r.matched).length;
      logger.info('sync', `lb-playlists: "${p.title}" — ${jspfTracks.length} tracks, ${matchedCount} matched`);
    } catch (e) {
      logger.warn('sync', `lb-playlists: track fetch failed for "${p.title}": ${e.message}`);
    }
    await sleep(300);
  }

  return merged;
}

// GET /sync/lb-playlists/cached — read from DB only, no external calls
router.get('/lb-playlists/cached', (req, res) => {
  const playlists = db.prepare('SELECT * FROM lb_playlists ORDER BY playlist_type, title').all();
  const tracks    = db.prepare('SELECT * FROM lb_playlist_tracks ORDER BY position').all();
  const trackMap  = new Map();
  for (const t of tracks) {
    if (!trackMap.has(t.lb_mbid)) trackMap.set(t.lb_mbid, []);
    trackMap.get(t.lb_mbid).push({ artist: t.artist, title: t.title, matched: !!t.matched });
  }
  const result = playlists.map(p => ({ ...p, tracks: trackMap.get(p.lb_mbid) || [] }));
  res.json({ ok: true, playlists: result });
});

// GET /sync/lb-playlists — live fetch from LB API (used by Sync All POST)
router.get('/lb-playlists', async (req, res) => {
  const s = getSettings();
  try {
    const playlists = await fetchAndCacheLbPlaylists(db, s);
    res.json({ ok: true, playlists });
  } catch (e) {
    logger.error('sync', `lb-playlists list failed: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

// POST /sync/lb-playlists — synchronous cache refresh (used by Sync All)
router.post('/lb-playlists', async (req, res) => {
  const s = getSettings();
  try {
    await fetchAndCacheLbPlaylists(db, s);
    res.json({ ok: true, message: 'LB playlists synced' });
  } catch (e) {
    logger.error('sync', `lb-playlists POST failed: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

// POST /sync/lb-playlists/toggle — persist enabled/protected state
router.post('/lb-playlists/toggle', (req, res) => {
  const { lb_mbid, title, playlist_type, field, value } = req.body;
  if (!lb_mbid || !['enabled', 'protected'].includes(field))
    return res.json({ ok: false, error: 'lb_mbid and field (enabled|protected) required' });

  const existing = db.prepare('SELECT * FROM lb_playlists WHERE lb_mbid = ?').get(lb_mbid) || {};
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

// POST /sync/lb-playlists/:mbid/snapshot — save current tracks as a permanent Navidrome playlist
router.post('/lb-playlists/:mbid/snapshot', async (req, res) => {
  const { mbid } = req.params;
  const { name }  = req.body;
  if (!name?.trim()) return res.json({ ok: false, error: 'name required' });

  const rows = db.prepare(
    'SELECT * FROM lb_playlist_tracks WHERE lb_mbid = ? AND matched = 1 ORDER BY position'
  ).all(mbid);
  if (!rows.length) return res.json({ ok: false, error: 'No matched tracks cached for this playlist' });

  const cache    = buildMatchCacheLocal(db);
  const trackIds = [];
  for (const r of rows) {
    const id = matchLocal(r.artist, r.title, cache);
    if (id) trackIds.push(id);
  }
  if (!trackIds.length) return res.json({ ok: false, error: 'Could not resolve any track IDs' });

  try {
    const nav    = require('../providers/navidrome');
    const result = await nav.createPlaylist(db, name.trim(), trackIds);
    if (!result.ok) return res.json({ ok: false, error: result.error });

    const comment = `navilist:lb-snapshot ${JSON.stringify({ source: 'listenbrainz', mbid })}`;
    await nav.updatePlaylist(db, result.playlist.id, { comment });

    logger.info('sync', `lb-snapshot: created "${name.trim()}" with ${trackIds.length} tracks from ${mbid}`);
    res.json({ ok: true, playlist_id: result.playlist.id, count: trackIds.length });
  } catch (e) {
    logger.error('sync', `lb-snapshot failed: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

// POST /sync/lb-playlists/:mbid/import — enable and immediately push one playlist to Navidrome
router.post('/lb-playlists/:mbid/import', async (req, res) => {
  const { mbid } = req.params;

  const existing = db.prepare('SELECT * FROM lb_playlists WHERE lb_mbid = ?').get(mbid);
  if (!existing) return res.json({ ok: false, error: 'Playlist not found — run Sync All from Services first' });

  db.prepare('UPDATE lb_playlists SET enabled = 1 WHERE lb_mbid = ?').run(mbid);
  const row = db.prepare('SELECT * FROM lb_playlists WHERE lb_mbid = ?').get(mbid);

  const nav   = require('../providers/navidrome');
  const cache = buildMatchCacheLocal(db);

  try {
    // Use the cached track match results from lb_playlist_tracks — no LB fetch or MB calls needed
    const cachedRows = db.prepare(
      'SELECT * FROM lb_playlist_tracks WHERE lb_mbid = ? AND matched = 1 ORDER BY position'
    ).all(mbid);
    if (!cachedRows.length) return res.json({ ok: false, error: 'No matched tracks cached — run Sync All from Services first' });

    const trackIds = [];
    for (const r of cachedRows) {
      const id = matchLocal(r.artist, r.title, cache);
      if (id) trackIds.push(id);
    }
    if (!trackIds.length) return res.json({ ok: false, error: 'No tracks matched in your library' });

    const comment   = `navilist:lb ${JSON.stringify({ source: 'listenbrainz', mbid })}`;
    const now       = Math.floor(Date.now() / 1000);
    const updateRow = db.prepare('UPDATE lb_playlists SET navidrome_id = ?, last_imported_at = ? WHERE lb_mbid = ?');

    let navId = row.navidrome_id;
    if (!navId && row.slot_key) {
      const slotRow = db.prepare(
        'SELECT navidrome_id FROM lb_playlists WHERE slot_key = ? AND navidrome_id IS NOT NULL LIMIT 1'
      ).get(row.slot_key);
      navId = slotRow?.navidrome_id || null;
    }

    const displayTitle = buildNaviTitle(row.title, row.slot_key);

    if (navId) {
      const replaceResult = await nav.replacePlaylistTracks(db, navId, trackIds);
      if (replaceResult.ok) {
        await nav.updatePlaylist(db, navId, { comment });
        updateRow.run(navId, now, mbid);
      } else {
        logger.warn('sync', `lb-import: navId ${navId} stale (${replaceResult.error}), clearing and creating fresh`);
        db.prepare('UPDATE lb_playlists SET navidrome_id = NULL WHERE navidrome_id = ?').run(navId);
        const result = await nav.createPlaylist(db, displayTitle, trackIds);
        if (!result.ok) return res.json({ ok: false, error: result.error });
        await nav.updatePlaylist(db, result.playlist.id, { comment });
        updateRow.run(result.playlist.id, now, mbid);
      }
    } else {
      const result = await nav.createPlaylist(db, displayTitle, trackIds);
      if (!result.ok) return res.json({ ok: false, error: result.error });
      await nav.updatePlaylist(db, result.playlist.id, { comment });
      updateRow.run(result.playlist.id, now, mbid);
    }

    logger.info('sync', `lb-import: "${row.title}" → "${displayTitle}" (${trackIds.length} tracks)`);
    res.json({ ok: true, count: trackIds.length });
  } catch (e) {
    logger.error('sync', `lb-import failed for ${mbid}: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

// POST /sync/playlists/listenbrainz — run import for all enabled LB playlists
router.post('/playlists/listenbrainz', async (req, res) => {
  const s = getSettings();
  if (!s.listenbrainz_token || !s.listenbrainz_username)
    return res.json({ ok: false, error: 'ListenBrainz credentials required' });
  runDetached('playlists/listenbrainz', () => syncLbPlaylists(db, s));
  res.json({ ok: true, message: 'ListenBrainz playlist import started' });
});

async function resolveRecordingMbids(mbids, token) {
  const BASE    = 'https://api.listenbrainz.org/1';
  const results = {};
  for (let i = 0; i < mbids.length; i += 10) {
    const chunk = mbids.slice(i, i + 10);
    try {
      const qs  = chunk.map(m => `recording_mbids=${encodeURIComponent(m)}`).join('&');
      const res = await fetch(`${BASE}/metadata/recording?${qs}&inc=artist`, {
        headers: { Authorization: `Token ${token}` }
      });
      if (!res.ok) { await sleep(1000); continue; }
      const data = await res.json();
      for (const [mbid, meta] of Object.entries(data || {})) {
        const artist = meta?.artist?.artists?.[0]?.name || meta?.artist_credit_name || '';
        const title  = meta?.recording?.name || '';
        if (artist && title) results[mbid] = { artist, title };
      }
    } catch (e) {
      logger.warn('sync', `resolveRecordingMbids chunk failed: ${e.message}`);
    }
    await sleep(300);
  }
  return results;
}

async function syncLbPlaylists(db, settings) {
  const token = settings.listenbrainz_token;
  const nav   = require('../providers/navidrome');
  const BASE  = 'https://api.listenbrainz.org/1';

  const enabled = db.prepare(`SELECT * FROM lb_playlists WHERE enabled = 1`).all();
  if (!enabled.length) {
    logger.info('sync', 'playlists/listenbrainz: no enabled playlists');
    return { ok: true, imported: 0 };
  }

  logger.info('sync', `playlists/listenbrainz: importing ${enabled.length} enabled playlists`);
  const cache = buildMatchCacheLocal(db);
  let imported = 0;

  const updateRow = db.prepare(`
    UPDATE lb_playlists SET navidrome_id = ?, last_imported_at = ? WHERE lb_mbid = ?
  `);

  for (const row of enabled) {
    try {
      const res = await fetch(`${BASE}/playlist/${row.lb_mbid}`, {
        headers: { Authorization: `Token ${token}` }
      });
      if (!res.ok) { logger.warn('sync', `LB playlist ${row.lb_mbid} fetch failed: ${res.status}`); continue; }
      const data = await res.json();
      const jspf = data?.playlist;
      if (!jspf) continue;

      const jspfTracks = jspf.track || [];
      if (!jspfTracks.length) { logger.info('sync', `"${row.title}": no tracks`); continue; }

      const trackIds       = [];
      const missingArtists = new Set();
      for (const t of jspfTracks) {
        const title      = t.title || '';
        const artists    = t.extension?.['https://musicbrainz.org/doc/jspf#track']
                           ?.additional_metadata?.artists || [];
        const artistName = artists[0]?.artist_credit_name || t.creator || '';
        const artistMbid = artists[0]?.artist_mbid || null;
        if (!artistName || !title) continue;
        const resolved = await resolveArtistWithAliases(artistName, artistMbid, cache);
        const id       = matchLocal(resolved, title, cache);
        if (id) { trackIds.push(id); } else { missingArtists.add(artistName); }
      }

      logger.info('sync', `"${row.title}": ${jspfTracks.length} tracks, ${trackIds.length} matched, ${missingArtists.size} missing artists`);

      if (missingArtists.size && settings.lb_lidarr_enabled === 'true')
        writeMissingArtists(db, [...missingArtists], 'lb_playlist');
      if (!trackIds.length) continue;

      const comment = `navilist:lb ${JSON.stringify({ source: 'listenbrainz', mbid: row.lb_mbid })}`;
      const now     = Math.floor(Date.now() / 1000);

      if (row.protected) {
        logger.info('sync', `"${row.title}": protected — skipping overwrite`);
        imported++;
        continue;
      }

      // For rotating slots, find the navidrome_id from any row with the same slot_key
      let navId = row.navidrome_id;
      if (!navId && row.slot_key) {
        const slotRow = db.prepare(
          'SELECT navidrome_id FROM lb_playlists WHERE slot_key = ? AND navidrome_id IS NOT NULL LIMIT 1'
        ).get(row.slot_key);
        navId = slotRow?.navidrome_id || null;
      }

      // For rotating playlists use a clean slot label as the Navidrome playlist name
      const displayTitle = buildNaviTitle(row.title, row.slot_key);

      if (navId) {
        const replaceResult = await nav.replacePlaylistTracks(db, navId, trackIds);
        if (replaceResult.ok) {
          await nav.updatePlaylist(db, navId, { comment });
          updateRow.run(navId, now, row.lb_mbid);
          logger.info('sync', `"${row.title}": updated slot "${row.slot_key || 'none'}" (${trackIds.length} tracks)`);
        } else {
          logger.warn('sync', `"${row.title}": navId ${navId} stale (${replaceResult.error}), clearing and creating fresh`);
          db.prepare('UPDATE lb_playlists SET navidrome_id = NULL WHERE navidrome_id = ?').run(navId);
          const result = await nav.createPlaylist(db, displayTitle, trackIds);
          if (result.ok) {
            await nav.updatePlaylist(db, result.playlist.id, { comment });
            updateRow.run(result.playlist.id, now, row.lb_mbid);
            logger.info('sync', `"${row.title}": recreated as "${displayTitle}" (${trackIds.length} tracks)`);
          }
        }
      } else {
        const result = await nav.createPlaylist(db, displayTitle, trackIds);
        if (result.ok) {
          await nav.updatePlaylist(db, result.playlist.id, { comment });
          updateRow.run(result.playlist.id, now, row.lb_mbid);
          logger.info('sync', `"${row.title}": created as "${displayTitle}" (${trackIds.length} tracks)`);
        }
      }
      imported++;
    } catch (e) {
      logger.warn('sync', `playlists/listenbrainz: error on "${row.title}": ${e.message}`);
    }
    await sleep(500);
  }

  logger.info('sync', `playlists/listenbrainz: ${imported} imported`);
  return { ok: true, imported };
}

// GET /sync/status — current state + track count
router.get('/status', (req, res) => {
  const trackCount = db.prepare('SELECT COUNT(*) as c FROM tracks').get().c;
  const lastSync   = db.prepare('SELECT MAX(synced_at) as s FROM tracks').get().s;

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

// ── Auto-refresh — every 30 minutes ──────────────────────────────────────────

function startAutoRefresh() {
  setInterval(() => {
    const s = getSettings();

    if (s.lastfm_api_key && s.lastfm_username) {
      runHistoryImport('lastfm', lastfm.fetchListens, { apiKey: s.lastfm_api_key, username: s.lastfm_username });
      runDetached('loved/lastfm',       () => syncLovedLastfm(db, s));
      runDetached('top-artists/lastfm', () => syncTopArtistsLastfm(db, s));
      runDetached('top-tracks/lastfm',  () => syncTopTracksLastfm(db, s));
    }

    if (s.listenbrainz_token && s.listenbrainz_username) {
      runHistoryImport('listenbrainz', listenbrainz.fetchListens, { token: s.listenbrainz_token, username: s.listenbrainz_username });
      runDetached('loved/listenbrainz',       () => syncLovedListenbrainz(db, s));
      runDetached('top-artists/listenbrainz', () => syncTopArtistsListenbrainz(db, s));
      runDetached('top-tracks/listenbrainz',  () => syncTopTracksListenbrainz(db, s));
      runDetached('playlists/listenbrainz',    () => syncLbPlaylists(db, s));
    }

    // Process any pending missing artists — runs regardless of which sources are configured
    runDetached('process-missing-artists', () => processMissingArtists());
  }, 30 * 60 * 1000);

  logger.info('sync', 'history auto-refresh scheduled every 30 minutes');
}

module.exports = {
  router,
  getSyncState,
  getSimilarSyncState: () => similarSyncState,
  getTagSyncState:     () => tagSyncState,
  startAutoRefresh,
  writeMissingArtists,
  processMissingArtists
};
