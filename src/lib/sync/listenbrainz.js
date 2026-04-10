'use strict';

/**
 * sync/listenbrainz.js — ListenBrainz sync jobs
 *
 * All functions receive (db, settings) and return { ok, ... }.
 * Helpers imported from index.
 */

const listenbrainz = require('../../providers/listenbrainz');
const mb           = require('../../providers/musicbrainz');
const logger       = require('../../utils/logger');
const {
  sleep,
  buildMatchCacheLocal,
  matchLocal,
  writeMissingArtists,
  resolveArtistWithAliases,
  detectSlotKey,
  buildNaviTitle
} = require('./helpers');

const LB_PERIODS = ['week', 'month', 'quarter', 'half_year', 'year', 'all_time'];

// ── Loved tracks ──────────────────────────────────────────────────────────────

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

  for (const score of [1, -1]) {
    const data     = await listenbrainz.getFeedback(token, username, score, 1000, 0);
    const feedback = data?.feedback;
    if (!feedback?.length) continue;
    total += feedback.length;
    const rows = [];
    for (const f of feedback) {
      const artist = f.track_metadata?.artist_name || '';
      const title  = f.track_metadata?.track_name  || '';
      const id     = matchLocal(artist, title, cache);
      if (!id) { unmatched++; continue; }
      rows.push({ track_id: id, score, loved_at: f.created || fetchedAt });
      matched++;
    }
    if (rows.length) db.transaction(rs => { for (const r of rs) upsert.run(r); })(rows);
  }
  logger.info('sync', `loved/listenbrainz: ${matched} matched, ${unmatched} unmatched`);
  return { ok: true, matched, unmatched, total };
}

// ── Top artists ───────────────────────────────────────────────────────────────

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
    const rows    = [];
    const missing = [];
    artists.forEach((a, i) => {
      const row = resolveArtist.get(a.artist_name);
      if (!row) { missing.push(a.artist_name); return; }
      rows.push({ artist_id: row.artist_id, period, rank: i + 1, play_count: a.listen_count || null, fetched_at: fetchedAt });
    });
    db.transaction(rs => { for (const r of rs) upsert.run(r); })(rows);
    total += rows.length;
    if (missing.length) writeMissingArtists(db, missing, 'lb_top_artists');
    await sleep(1000);
  }
  logger.info('sync', `top-artists/listenbrainz: ${total} rows written`);
  return { ok: true, total };
}

// ── Top tracks ────────────────────────────────────────────────────────────────

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
    db.transaction(rs => { for (const r of rs) upsert.run(r); })(rows);
    total += rows.length;
    await sleep(1000);
  }
  logger.info('sync', `top-tracks/listenbrainz: ${total} rows written`);
  return { ok: true, total };
}

// ── LB playlists ──────────────────────────────────────────────────────────────

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

  const getSlotRow = db.prepare('SELECT * FROM lb_playlists WHERE slot_key = ? AND lb_mbid != ? ORDER BY id DESC LIMIT 1');
  const upsertPl   = db.prepare(`
    INSERT INTO lb_playlists (lb_mbid, title, playlist_type, enabled, protected, slot_key, navidrome_id)
    VALUES (@lb_mbid, @title, @playlist_type, @enabled, @protected, @slot_key, @navidrome_id)
    ON CONFLICT(lb_mbid) DO UPDATE SET
      title         = excluded.title,
      playlist_type = excluded.playlist_type,
      slot_key      = excluded.slot_key,
      navidrome_id  = COALESCE(lb_playlists.navidrome_id, excluded.navidrome_id)
  `);
  db.transaction(rows => { for (const r of rows) upsertPl.run(r); })(remote.map(p => {
    const existing     = savedMap.get(p.lb_mbid) || {};
    const slotKey      = detectSlotKey(p.title);
    const slotRow      = slotKey ? getSlotRow.get(slotKey, p.lb_mbid) : null;
    const enabled      = existing.enabled      ?? slotRow?.enabled      ?? 0;
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

  const cache        = buildMatchCacheLocal(db);
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
        const artists    = t.extension?.['https://musicbrainz.org/doc/jspf#track']?.additional_metadata?.artists || [];
        const artistName = artists[0]?.artist_credit_name || t.creator || 'Unknown';
        const artistMbid = artists[0]?.artist_mbid || null;
        const resolved   = await resolveArtistWithAliases(artistName, artistMbid, cache);
        const id         = matchLocal(resolved, title, cache);
        logger.debug('sync', `lb track match: "${artistName}" / "${title}" → ${id ? 'matched' : 'unmatched'}`);
        trackRows.push({ lb_mbid: p.lb_mbid, position: i, artist: artistName, title, matched: id ? 1 : 0 });
      }

      db.transaction(() => {
        deleteTracks.run(p.lb_mbid);
        for (const r of trackRows) insertTrack.run(r);
      })();

      const matchedCount = trackRows.filter(r => r.matched).length;
      logger.info('sync', `lb-playlists: "${p.title}" — ${jspfTracks.length} tracks, ${matchedCount} matched`);
    } catch (e) {
      logger.warn('sync', `lb-playlists: track fetch failed for "${p.title}": ${e.message}`);
    }
    await sleep(300);
  }

  return merged;
}

async function syncLbPlaylists(db, settings) {
  const token = settings.listenbrainz_token;
  const nav   = require('../../providers/navidrome');
  const BASE  = 'https://api.listenbrainz.org/1';

  const enabled = db.prepare('SELECT * FROM lb_playlists WHERE enabled = 1').all();
  if (!enabled.length) {
    logger.info('sync', 'playlists/listenbrainz: no enabled playlists');
    return { ok: true, imported: 0 };
  }

  logger.info('sync', `playlists/listenbrainz: importing ${enabled.length} enabled playlists`);
  const cache     = buildMatchCacheLocal(db);
  let imported    = 0;
  const updateRow = db.prepare('UPDATE lb_playlists SET navidrome_id = ?, last_imported_at = ? WHERE lb_mbid = ?');

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
        const artists    = t.extension?.['https://musicbrainz.org/doc/jspf#track']?.additional_metadata?.artists || [];
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
      if (row.protected) { logger.info('sync', `"${row.title}": protected — skipping overwrite`); imported++; continue; }

      const comment      = `navilist:lb ${JSON.stringify({ source: 'listenbrainz', mbid: row.lb_mbid })}`;
      const now          = Math.floor(Date.now() / 1000);
      const displayTitle = buildNaviTitle(row.title, row.slot_key);

      let navId = row.navidrome_id;
      if (!navId && row.slot_key) {
        const slotRow = db.prepare('SELECT navidrome_id FROM lb_playlists WHERE slot_key = ? AND navidrome_id IS NOT NULL LIMIT 1').get(row.slot_key);
        navId = slotRow?.navidrome_id || null;
      }

      if (navId) {
        const replaceResult = await nav.replacePlaylistTracks(db, navId, trackIds);
        if (replaceResult.ok) {
          await nav.updatePlaylist(db, navId, { comment });
          updateRow.run(navId, now, row.lb_mbid);
          logger.info('sync', `"${row.title}": updated slot "${row.slot_key || 'none'}" (${trackIds.length} tracks)`);
        } else {
          logger.warn('sync', `"${row.title}": navId ${navId} stale, clearing and creating fresh`);
          db.prepare('UPDATE lb_playlists SET navidrome_id = NULL WHERE navidrome_id = ?').run(navId);
          const result = await nav.createPlaylist(db, displayTitle, trackIds);
          if (result.ok) {
            await nav.updatePlaylist(db, result.playlist.id, { comment });
            updateRow.run(result.playlist.id, now, row.lb_mbid);
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

module.exports = {
  syncLovedListenbrainz,
  syncTopArtistsListenbrainz,
  syncTopTracksListenbrainz,
  fetchAndCacheLbPlaylists,
  syncLbPlaylists
};
