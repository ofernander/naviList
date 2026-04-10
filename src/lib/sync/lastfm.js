'use strict';

/**
 * sync/lastfm.js — Last.fm sync jobs
 *
 * All functions receive (db, settings) and return { ok, ... }.
 * Helpers imported from index.
 */

const lastfm = require('../../providers/lastfm');
const logger = require('../../utils/logger');
const { sleep, buildMatchCacheLocal, matchLocal, writeMissingArtists } = require('./helpers');

const LFM_PERIODS = ['7day', '1month', '3month', '6month', '12month', 'overall'];

// ── Loved tracks ──────────────────────────────────────────────────────────────

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
  const rows = [];
  for (const t of arr) {
    const id = matchLocal(t.artist?.name || '', t.name || '', cache);
    if (!id) { unmatched++; continue; }
    rows.push({ track_id: id, loved_at: parseInt(t.date?.uts) || fetchedAt });
    matched++;
  }
  if (rows.length) db.transaction(rs => { for (const r of rs) upsert.run(r); })(rows);
  logger.info('sync', `loved/lastfm: ${matched} matched, ${unmatched} unmatched`);
  return { ok: true, matched, unmatched, total: arr.length };
}

// ── Top artists ───────────────────────────────────────────────────────────────

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
    const arr     = Array.isArray(artists) ? artists : [artists];
    const rows    = [];
    const missing = [];
    arr.forEach((a, i) => {
      const row = resolveArtist.get(a.name);
      if (!row) { missing.push(a.name); return; }
      rows.push({ artist_id: row.artist_id, period, rank: i + 1, play_count: parseInt(a.playcount) || null, fetched_at: fetchedAt });
    });
    db.transaction(rs => { for (const r of rs) upsert.run(r); })(rows);
    total += rows.length;
    if (missing.length) writeMissingArtists(db, missing, 'lastfm_top_artists');
    await sleep(1000);
  }
  logger.info('sync', `top-artists/lastfm: ${total} rows written`);
  return { ok: true, total };
}

// ── Top tracks ────────────────────────────────────────────────────────────────

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
    db.transaction(rs => { for (const r of rs) upsert.run(r); })(rows);
    total += rows.length;
    await sleep(1000);
  }
  logger.info('sync', `top-tracks/lastfm: ${total} rows written`);
  return { ok: true, total };
}

// ── Artist tags ───────────────────────────────────────────────────────────────

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
      db.transaction(rows => { for (const r of rows) upsert.run(r); })(
        arr.map(t => ({ artistId: artist_id, tag: t.name.toLowerCase(), weight: parseInt(t.count) || 0, fetchedAt }))
      );
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

// ── Similar artists ───────────────────────────────────────────────────────────

async function syncSimilarArtistsLastfm(db, settings) {
  const { lastfm_api_key: apiKey } = settings;
  if (!apiKey) return { ok: false, error: 'Last.fm API key not configured' };

  const artists = db.prepare('SELECT DISTINCT artist_id, artist FROM tracks WHERE artist_id IS NOT NULL AND artist IS NOT NULL').all();
  const cached  = new Set(db.prepare('SELECT DISTINCT artist_id FROM artist_similar').all().map(r => r.artist_id));
  const todo    = artists.filter(a => !cached.has(a.artist_id));

  logger.info('sync', `similar-artists/lastfm: ${todo.length} artists to fetch (${cached.size} already cached)`);
  if (!todo.length) return { ok: true, fetched: 0, failed: 0, total: 0 };

  const upsert = db.prepare(`
    INSERT INTO artist_similar (artist_id, similar_name, similar_artist_id, score, source, fetched_at)
    VALUES (@artistId, @similarName, @similarArtistId, @score, 'lastfm', @fetchedAt)
    ON CONFLICT(artist_id, similar_name) DO UPDATE SET
      similar_artist_id = excluded.similar_artist_id,
      score             = excluded.score,
      fetched_at        = excluded.fetched_at
  `);
  const resolveArtistId = db.prepare('SELECT DISTINCT artist_id FROM tracks WHERE LOWER(artist) = LOWER(?) LIMIT 1');
  const insertSentinel  = db.prepare(`
    INSERT OR IGNORE INTO artist_similar (artist_id, similar_name, similar_artist_id, score, source, fetched_at)
    VALUES (?, '__none__', NULL, NULL, 'lastfm', ?)
  `);

  let fetched = 0, failed = 0;
  const fetchedAt = Math.floor(Date.now() / 1000);

  for (const { artist_id, artist } of todo) {
    try {
      const data    = await lastfm.getSimilarArtists(apiKey, { name: artist }, 100);
      const similar = data?.similarartists?.artist;
      if (!Array.isArray(similar) || !similar.length) {
        insertSentinel.run(artist_id, fetchedAt);
        fetched++;
        await sleep(1000);
        continue;
      }
      const rows = similar.map(s => ({
        artistId:        artist_id,
        similarName:     s.name,
        similarArtistId: resolveArtistId.get(s.name)?.artist_id ?? null,
        score:           parseFloat(s.match) || 0,
        fetchedAt
      }));
      db.transaction(rs => { for (const r of rs) upsert.run(r); })(rows);
      const missing = rows.filter(r => r.similarArtistId === null).map(r => r.similarName);
      if (missing.length) writeMissingArtists(db, missing, 'lastfm_similar');
      fetched++;
      logger.info('sync', `similar-artists/lastfm: "${artist}" → ${similar.length} results`);
    } catch (e) {
      if (e.message.includes('400')) {
        insertSentinel.run(artist_id, fetchedAt);
        logger.warn('sync', `similar-artists/lastfm: "${artist}" 400 — ${e.message} — sentinelled`);
      } else {
        failed++;
        logger.warn('sync', `similar-artists/lastfm failed for "${artist}": ${e.message}`);
      }
    }
    await sleep(1000);
  }
  logger.info('sync', `similar-artists/lastfm: ${fetched} fetched, ${failed} failed`);
  return { ok: true, fetched, failed, total: todo.length };
}

module.exports = {
  syncLovedLastfm,
  syncTopArtistsLastfm,
  syncTopTracksLastfm,
  syncArtistTagsLastfm,
  syncSimilarArtistsLastfm
};
