'use strict';

/**
 * sync/maloja.js — Maloja sync jobs
 *
 * All functions receive (db, settings) and return { ok, ... }.
 */

const maloja = require('../../providers/maloja');
const logger = require('../../utils/logger');
const { sleep, buildMatchCacheLocal, matchLocal, writeMissingArtists } = require('./helpers');

const MALOJA_PERIODS = ['week', 'month', 'quarter', 'half_year', 'year', 'all_time'];

// ── Top artists ───────────────────────────────────────────────────────────────

async function syncTopArtistsMaloja(db, settings) {
  const { maloja_url: baseUrl, maloja_api_key: apiKey } = settings;
  if (!baseUrl || !apiKey) return { ok: false, error: 'Maloja URL and API key required' };

  const upsert = db.prepare(`
    INSERT INTO user_top_artists (artist_id, source, period, rank, play_count, fetched_at)
    VALUES (@artist_id, 'maloja', @period, @rank, @play_count, @fetched_at)
    ON CONFLICT(artist_id, source, period) DO UPDATE SET
      rank=excluded.rank, play_count=excluded.play_count, fetched_at=excluded.fetched_at
  `);
  const resolveArtist = db.prepare('SELECT DISTINCT artist_id FROM tracks WHERE LOWER(artist) = LOWER(?) LIMIT 1');
  const fetchedAt = Math.floor(Date.now() / 1000);
  let total = 0;

  for (const period of MALOJA_PERIODS) {
    const from = maloja.periodToRange(period);
    const data = await maloja.getChartArtists(baseUrl, apiKey, { from, limit: 50 });
    const list = data?.list;
    if (!list?.length) { await sleep(500); continue; }

    const rows    = [];
    const missing = [];
    list.forEach((a, i) => {
      const name = typeof a.artist === 'string' ? a.artist : (a.artist?.name || '');
      if (!name) return;
      const row = resolveArtist.get(name);
      if (!row) { missing.push(name); return; }
      rows.push({ artist_id: row.artist_id, period, rank: i + 1, play_count: a.scrobbles || null, fetched_at: fetchedAt });
    });
    db.transaction(rs => { for (const r of rs) upsert.run(r); })(rows);
    total += rows.length;
    if (missing.length) writeMissingArtists(db, missing, 'maloja_top_artists');
    await sleep(500);
  }
  logger.info('sync', `top-artists/maloja: ${total} rows written`);
  return { ok: true, total };
}

// ── Top tracks ────────────────────────────────────────────────────────────────

async function syncTopTracksMaloja(db, settings) {
  const { maloja_url: baseUrl, maloja_api_key: apiKey } = settings;
  if (!baseUrl || !apiKey) return { ok: false, error: 'Maloja URL and API key required' };

  const cache  = buildMatchCacheLocal(db);
  const upsert = db.prepare(`
    INSERT INTO user_top_tracks (track_id, source, period, rank, play_count, fetched_at)
    VALUES (@track_id, 'maloja', @period, @rank, @play_count, @fetched_at)
    ON CONFLICT(track_id, source, period) DO UPDATE SET
      rank=excluded.rank, play_count=excluded.play_count, fetched_at=excluded.fetched_at
  `);
  const fetchedAt = Math.floor(Date.now() / 1000);
  let total = 0;

  for (const period of MALOJA_PERIODS) {
    const from = maloja.periodToRange(period);
    const data = await maloja.getChartTracks(baseUrl, apiKey, { from, limit: 50 });
    const list = data?.list;
    if (!list?.length) { await sleep(500); continue; }

    const rows = [];
    list.forEach((t, i) => {
      const artists = t.track?.artists || [];
      const artist  = typeof artists[0] === 'string' ? artists[0] : (artists[0]?.name || '');
      const title   = t.track?.title || '';
      if (!artist || !title) return;
      const id = matchLocal(artist, title, cache);
      if (!id) return;
      rows.push({ track_id: id, period, rank: i + 1, play_count: t.scrobbles || null, fetched_at: fetchedAt });
    });
    db.transaction(rs => { for (const r of rs) upsert.run(r); })(rows);
    total += rows.length;
    await sleep(500);
  }
  logger.info('sync', `top-tracks/maloja: ${total} rows written`);
  return { ok: true, total };
}

module.exports = {
  syncTopArtistsMaloja,
  syncTopTracksMaloja,
};
