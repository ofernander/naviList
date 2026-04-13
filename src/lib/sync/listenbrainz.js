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

// Fetch playlist list from LB, update lb_playlist_cache, fetch + cache tracks for all playlists
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
    playlist_type: type,
    source_patch:  pl.playlist?.extension?.['https://musicbrainz.org/doc/jspf#playlist']
                     ?.additional_metadata?.algorithm_metadata?.source_patch || null,
  })).filter(p => p.lb_mbid);

  // For generated playlists, keep only the newest (first) entry per source_patch.
  // User playlists (no source_patch) all pass through.
  const dedupeByPatch = (playlists) => {
    const seen = new Set();
    return playlists.filter(p => {
      if (!p.source_patch) return true;
      if (seen.has(p.source_patch)) return false;
      seen.add(p.source_patch);
      return true;
    });
  };

  const remote     = [
    ...dedupeByPatch(normalise(cfData.playlists, 'generated')),
    ...normalise(ownData.playlists, 'user'),
  ];
  const fetched_at = Math.floor(Date.now() / 1000);

  // Update cache
  const upsertCache = db.prepare(`
    INSERT INTO lb_playlist_cache (lb_mbid, title, playlist_type, source_patch, fetched_at)
    VALUES (@lb_mbid, @title, @playlist_type, @source_patch, @fetched_at)
    ON CONFLICT(lb_mbid) DO UPDATE SET
      title         = excluded.title,
      playlist_type = excluded.playlist_type,
      source_patch  = excluded.source_patch,
      fetched_at    = excluded.fetched_at
  `);
  db.transaction(rows => { for (const r of rows) upsertCache.run(r); })(
    remote.map(p => ({ ...p, fetched_at }))
  );
  logger.info('sync', `lb-playlists: cached ${remote.length} playlists from LB`);

  // Fetch and cache tracks for all playlists (for UI display)
  const cache        = buildMatchCacheLocal(db);
  const deleteTracks = db.prepare('DELETE FROM lb_playlist_tracks WHERE lb_mbid = ?');
  const insertTrack  = db.prepare(`
    INSERT INTO lb_playlist_tracks (lb_mbid, position, artist, title, matched)
    VALUES (@lb_mbid, @position, @artist, @title, @matched)
  `);

  for (const p of remote) {
    try {
      const plRes = await fetch(`${BASE}/playlist/${p.lb_mbid}`, { headers });
      if (!plRes.ok) { logger.warn('sync', `lb-playlists: track fetch failed for "${p.title}": ${plRes.status}`); continue; }
      const jspfTracks = (await plRes.json())?.playlist?.track || [];
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
        trackRows.push({ lb_mbid: p.lb_mbid, position: i, artist: artistName, title, matched: id ? 1 : 0 });
      }
      db.transaction(() => {
        deleteTracks.run(p.lb_mbid);
        for (const r of trackRows) insertTrack.run(r);
      })();
      logger.info('sync', `lb-playlists: "${p.title}" — ${jspfTracks.length} tracks, ${trackRows.filter(r => r.matched).length} matched`);
    } catch (e) {
      logger.warn('sync', `lb-playlists: track fetch failed for "${p.title}": ${e.message}`);
    }
    await sleep(300);
  }

  // Enrich with subscription state for UI
  const subs      = db.prepare('SELECT * FROM lb_subscriptions').all();
  const subByMbid = new Map(subs.map(s => [s.lb_mbid, s]));

  return remote.map(p => {
    const sub = subByMbid.get(p.lb_mbid);
    return { ...p, enabled: sub ? 1 : 0, navidrome_id: sub?.navidrome_id || null, tracks: [] };
  });
}

// Push fresh tracks to ND for all active subscriptions
async function syncLbPlaylists(db, settings) {
  const token   = settings.listenbrainz_token;
  const nav     = require('../../providers/navidrome');
  const BASE    = 'https://api.listenbrainz.org/1';
  const headers = { Authorization: `Token ${token}` };

  const subs = db.prepare('SELECT * FROM lb_subscriptions').all();
  if (!subs.length) {
    logger.info('sync', 'playlists/listenbrainz: no subscriptions');
    return { ok: true, synced: 0 };
  }

  // Fetch current playlists from LB to detect expired MBIDs and find replacements
  const [cfRes, ownRes] = await Promise.all([
    fetch(`${BASE}/user/${settings.listenbrainz_username}/playlists/createdfor`, { headers }),
    fetch(`${BASE}/user/${settings.listenbrainz_username}/playlists`, { headers }),
  ]);
  const cfData  = cfRes.ok  ? await cfRes.json()  : { playlists: [] };
  const ownData = ownRes.ok ? await ownRes.json() : { playlists: [] };

  const extractMbid        = pl => pl.playlist?.identifier?.split('/playlist/')?.[1]?.replace(/\/$/, '') || null;
  const extractSourcePatch = pl => pl.playlist?.extension?.['https://musicbrainz.org/doc/jspf#playlist']
                                     ?.additional_metadata?.algorithm_metadata?.source_patch || null;

  // All current MBIDs from LB
  const currentMbids = new Set([
    ...(cfData.playlists  || []).map(extractMbid),
    ...(ownData.playlists || []).map(extractMbid),
  ].filter(Boolean));

  // source_patch → newest MBID (first in createdfor list = most recent)
  const patchToNewestMbid = new Map();
  for (const pl of (cfData.playlists || [])) {
    const mbid  = extractMbid(pl);
    const patch = extractSourcePatch(pl);
    if (mbid && patch && !patchToNewestMbid.has(patch)) patchToNewestMbid.set(patch, mbid);
  }

  // mbid → LB title (for display name generation)
  const mbidToTitle = new Map();
  for (const pl of [...(cfData.playlists || []), ...(ownData.playlists || [])]) {
    const mbid = extractMbid(pl);
    if (mbid) mbidToTitle.set(mbid, pl.playlist?.title || '');
  }

  const cache     = buildMatchCacheLocal(db);
  const updateSub = db.prepare('UPDATE lb_subscriptions SET lb_mbid = ?, navidrome_id = ? WHERE id = ?');
  const deleteSub = db.prepare('DELETE FROM lb_subscriptions WHERE id = ?');
  let synced = 0;

  for (const sub of subs) {
    try {
      let mbid = sub.lb_mbid;

      // If subscribed MBID has expired, auto-rotate to newest for same source_patch
      if (!currentMbids.has(mbid)) {
        const newMbid = sub.source_patch ? patchToNewestMbid.get(sub.source_patch) : null;
        if (!newMbid) {
          logger.info('sync', `lb-sync: MBID ${mbid} expired, no replacement found — unsubscribing`);
          if (sub.navidrome_id) await nav.deletePlaylist(db, sub.navidrome_id);
          deleteSub.run(sub.id);
          continue;
        }
        logger.info('sync', `lb-sync: MBID ${mbid} expired, rotating to ${newMbid}`);
        updateSub.run(newMbid, sub.navidrome_id, sub.id);
        mbid = newMbid;
      }

      const lbTitle      = mbidToTitle.get(mbid) || '';
      const displayTitle = buildNaviTitle(lbTitle);
      const comment      = `navilist:lb ${JSON.stringify({ source: 'listenbrainz', source_patch: sub.source_patch || null, mbid })}`;

      // Fetch fresh tracks
      const res = await fetch(`${BASE}/playlist/${mbid}`, { headers });
      if (!res.ok) { logger.warn('sync', `lb-sync: fetch failed for ${mbid}: ${res.status}`); continue; }
      const jspfTracks = (await res.json())?.playlist?.track || [];
      if (!jspfTracks.length) { logger.info('sync', `lb-sync: ${mbid} has no tracks`); continue; }

      // Resolve tracks
      const trackIds       = [];
      const missingArtists = new Set();
      for (const t of jspfTracks) {
        const trackTitle = t.title || '';
        const artists    = t.extension?.['https://musicbrainz.org/doc/jspf#track']?.additional_metadata?.artists || [];
        const artistName = artists[0]?.artist_credit_name || t.creator || '';
        const artistMbid = artists[0]?.artist_mbid || null;
        if (!artistName || !trackTitle) continue;
        const resolved = await resolveArtistWithAliases(artistName, artistMbid, cache);
        const id       = matchLocal(resolved, trackTitle, cache);
        if (id) trackIds.push(id); else missingArtists.add(artistName);
      }
      if (missingArtists.size)
        writeMissingArtists(db, [...missingArtists], 'lb_playlist');
      if (!trackIds.length) { logger.info('sync', `lb-sync: ${mbid} — no matched tracks`); continue; }

      // Push to ND
      if (sub.navidrome_id) {
        const ndExists = await nav.getPlaylist(db, sub.navidrome_id);
        if (!ndExists) {
          logger.info('sync', `lb-sync: "${displayTitle}" ND playlist gone — unsubscribing`);
          deleteSub.run(sub.id);
          continue;
        }
        await nav.replacePlaylistTracks(db, sub.navidrome_id, trackIds);
        await nav.updatePlaylist(db, sub.navidrome_id, { name: displayTitle, comment });
        logger.info('sync', `lb-sync: "${displayTitle}" updated (${trackIds.length} tracks)`);
      } else {
        const result = await nav.createPlaylist(db, displayTitle, trackIds);
        if (!result.ok) { logger.warn('sync', `lb-sync: failed to create "${displayTitle}": ${result.error}`); continue; }
        await nav.updatePlaylist(db, result.playlist.id, { comment });
        db.prepare('UPDATE lb_subscriptions SET navidrome_id = ? WHERE id = ?').run(result.playlist.id, sub.id);
        logger.info('sync', `lb-sync: "${displayTitle}" created (${trackIds.length} tracks)`);
      }
      synced++;
    } catch (e) {
      logger.warn('sync', `lb-sync: error on sub ${sub.id}: ${e.message}`);
    }
    await sleep(500);
  }

  logger.info('sync', `playlists/listenbrainz: ${synced} synced`);
  return { ok: true, synced };
}

module.exports = {
  syncLovedListenbrainz,
  syncTopArtistsListenbrainz,
  syncTopTracksListenbrainz,
  fetchAndCacheLbPlaylists,
  syncLbPlaylists
};
