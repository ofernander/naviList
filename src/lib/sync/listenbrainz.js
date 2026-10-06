'use strict';

/**
 * sync/listenbrainz.js — ListenBrainz sync jobs
 *
 * All functions receive (db, settings) and return { ok, ... }.
 * Helpers imported from index.
 */

const listenbrainz = require('../../providers/listenbrainz');
const logger       = require('../../utils/logger');
const { sleep, writeMissingArtists, buildNaviTitle } = require('./helpers');
const { buildMatcher, buildMatcherWarmed } = require('../match');
const { TYPES } = require('../playlist_types');

const LB_PERIODS = ['week', 'month', 'quarter', 'half_year', 'year', 'all_time'];

// ── JSPF helpers ──────────────────────────────────────────────────────────────

const JSPF_TRACK_EXT = 'https://musicbrainz.org/doc/jspf#track';
const JSPF_PL_EXT    = 'https://musicbrainz.org/doc/jspf#playlist';

// One JSPF track → { title, artist, artistMbid, mbid } for the matcher.
function jspfTrack(t) {
  const artists = t.extension?.[JSPF_TRACK_EXT]?.additional_metadata?.artists || [];
  const ids     = Array.isArray(t.identifier) ? t.identifier : [t.identifier];
  const recUrl  = ids.find(i => typeof i === 'string' && i.includes('/recording/'));
  return {
    title:      t.title || '',
    artist:     artists[0]?.artist_credit_name || t.creator || '',
    artistMbid: artists[0]?.artist_mbid || null,
    mbid:       recUrl ? recUrl.split('/recording/')[1].replace(/\/$/, '') : null,
  };
}

const playlistMbid = pl => pl.playlist?.identifier?.split('/playlist/')?.[1]?.replace(/\/$/, '') || null;
const sourcePatch  = pl => pl.playlist?.extension?.[JSPF_PL_EXT]?.additional_metadata?.algorithm_metadata?.source_patch || null;

// Created-for + own playlist lists; a failed list fetch counts as empty.
async function fetchPlaylistLists(token, username) {
  const safe = p => p.catch(e => { logger.warn('sync', `lb-playlists: list fetch failed: ${e.message}`); return { playlists: [] }; });
  const [cfData, ownData] = await Promise.all([
    safe(listenbrainz.getPlaylistsCreatedFor(token, username)),
    safe(listenbrainz.getUserPlaylists(token, username)),
  ]);
  return { createdFor: cfData?.playlists || [], own: ownData?.playlists || [] };
}

// ── Loved tracks ──────────────────────────────────────────────────────────────

async function syncLovedListenbrainz(db, settings) {
  const { listenbrainz_token: token, listenbrainz_username: username } = settings;
  if (!token || !username) return { ok: false, error: 'ListenBrainz credentials required' };

  const matcher   = buildMatcher(db);
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
      const id     = matcher.match({ artist, title, mbid: f.recording_mbid || null });
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

  const matcher = buildMatcher(db);
  const upsert  = db.prepare(`
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
      const id = matcher.match({ artist: r.artist_name || '', title: r.track_name || '', mbid: r.recording_mbid || null });
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

  const username = s.listenbrainz_username;
  const token    = s.listenbrainz_token;
  const { createdFor, own } = await fetchPlaylistLists(token, username);

  const normalise = (playlists, type) => (playlists || []).map(pl => ({
    lb_mbid:       playlistMbid(pl),
    title:         pl.playlist?.title || 'Untitled',
    playlist_type: type,
    source_patch:  sourcePatch(pl),
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
    ...dedupeByPatch(normalise(createdFor, 'generated')),
    ...normalise(own, 'user'),
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

  // Prune stale cache rows: for each source_patch we just synced, delete any old MBIDs
  // that are no longer the current one. Without this, old daily-jams / weekly-exploration
  // MBIDs accumulate in the table and all show up in the UI.
  const currentMbids   = new Set(remote.map(p => p.lb_mbid));
  const currentPatches = new Set(remote.filter(p => p.source_patch).map(p => p.source_patch));
  if (currentPatches.size > 0) {
    const patchPlaceholders = [...currentPatches].map(() => '?').join(',');
    const mbidPlaceholders  = [...currentMbids].map(() => '?').join(',');
    const staleRows = db.prepare(`
      SELECT lb_mbid FROM lb_playlist_cache
      WHERE source_patch IN (${patchPlaceholders})
      AND lb_mbid NOT IN (${mbidPlaceholders})
    `).all([...currentPatches, ...currentMbids]);
    if (staleRows.length) {
      const deleteCacheRow  = db.prepare('DELETE FROM lb_playlist_cache WHERE lb_mbid = ?');
      const deleteTrackRows = db.prepare('DELETE FROM lb_playlist_tracks WHERE lb_mbid = ?');
      const updateSubMbid   = db.prepare('UPDATE lb_subscriptions SET lb_mbid = ? WHERE lb_mbid = ?');
      // Build a map from stale MBID → current MBID for its source_patch
      const staleToCurrent = new Map();
      for (const row of staleRows) {
        const patch = db.prepare('SELECT source_patch FROM lb_playlist_cache WHERE lb_mbid = ?').get(row.lb_mbid)?.source_patch;
        if (patch) {
          const currentMbid = remote.find(p => p.source_patch === patch)?.lb_mbid;
          if (currentMbid) staleToCurrent.set(row.lb_mbid, currentMbid);
        }
      }
      db.transaction(() => {
        for (const row of staleRows) {
          const replacement = staleToCurrent.get(row.lb_mbid);
          if (replacement) updateSubMbid.run(replacement, row.lb_mbid);
          deleteCacheRow.run(row.lb_mbid);
          deleteTrackRows.run(row.lb_mbid);
        }
      })();
      logger.info('sync', `lb-playlists: pruned ${staleRows.length} stale cache row(s)`);
    }
  }

  // Fetch and cache tracks for all playlists (for UI display)
  const matcher      = buildMatcher(db);
  const deleteTracks = db.prepare('DELETE FROM lb_playlist_tracks WHERE lb_mbid = ?');
  const insertTrack  = db.prepare(`
    INSERT INTO lb_playlist_tracks (lb_mbid, position, artist, title, matched)
    VALUES (@lb_mbid, @position, @artist, @title, @matched)
  `);

  for (const p of remote) {
    try {
      const jspfTracks = (await listenbrainz.getPlaylist(token, p.lb_mbid))?.playlist?.track || [];
      if (!jspfTracks.length) continue;

      const trackRows = [];
      for (let i = 0; i < jspfTracks.length; i++) {
        const row = jspfTrack(jspfTracks[i]);
        const id  = await matcher.matchWithAliases(row);
        trackRows.push({ lb_mbid: p.lb_mbid, position: i, artist: row.artist || 'Unknown', title: row.title || 'Unknown track', matched: id ? 1 : 0 });
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
  const { publishPlaylist } = require('../publish');

  const subs = db.prepare('SELECT * FROM lb_subscriptions').all();
  if (!subs.length) {
    logger.info('sync', 'playlists/listenbrainz: no subscriptions');
    return { ok: true, synced: 0 };
  }

  // Fetch current playlists from LB to detect expired MBIDs and find replacements
  const { createdFor, own } = await fetchPlaylistLists(token, settings.listenbrainz_username);

  // All current MBIDs from LB
  const currentMbids = new Set([...createdFor, ...own].map(playlistMbid).filter(Boolean));

  // source_patch → newest MBID (first in createdfor list = most recent)
  const patchToNewestMbid = new Map();
  for (const pl of createdFor) {
    const mbid  = playlistMbid(pl);
    const patch = sourcePatch(pl);
    if (mbid && patch && !patchToNewestMbid.has(patch)) patchToNewestMbid.set(patch, mbid);
  }

  // mbid → LB title (for display name generation)
  const mbidToTitle = new Map();
  for (const pl of [...createdFor, ...own]) {
    const mbid = playlistMbid(pl);
    if (mbid) mbidToTitle.set(mbid, pl.playlist?.title || '');
  }

  const updateSub = db.prepare('UPDATE lb_subscriptions SET lb_mbid = ?, navidrome_id = ? WHERE id = ?');
  const deleteSub = db.prepare('DELETE FROM lb_subscriptions WHERE id = ?');
  let synced = 0;

  for (const sub of subs) {
    try {
      let mbid = sub.lb_mbid;

      // Auto-rotate: if a newer MBID exists for the same source_patch, switch to it.
      // Covers both "subscribed MBID expired" and "newer playlist published alongside old".
      if (sub.source_patch) {
        const newestMbid = patchToNewestMbid.get(sub.source_patch);
        if (newestMbid && newestMbid !== mbid) {
          logger.info('sync', `lb-sync: rotating ${mbid} → ${newestMbid} (source_patch: ${sub.source_patch})`);
          updateSub.run(newestMbid, sub.navidrome_id, sub.id);
          mbid = newestMbid;
        } else if (!currentMbids.has(mbid) && !newestMbid) {
          logger.info('sync', `lb-sync: MBID ${mbid} expired, no replacement found — unsubscribing`);
          if (sub.navidrome_id) await nav.deletePlaylist(db, sub.navidrome_id);
          deleteSub.run(sub.id);
          continue;
        }
      } else if (!currentMbids.has(mbid)) {
        // User-owned playlist (no source_patch) that has vanished from LB — unsubscribe.
        logger.info('sync', `lb-sync: user playlist MBID ${mbid} gone from LB — unsubscribing`);
        if (sub.navidrome_id) await nav.deletePlaylist(db, sub.navidrome_id);
        deleteSub.run(sub.id);
        continue;
      }

      const lbTitle      = mbidToTitle.get(mbid) || '';
      const displayTitle = buildNaviTitle(lbTitle, sub.source_patch);
      const config       = { source: 'listenbrainz', source_patch: sub.source_patch || null, mbid };

      // Fetch fresh tracks
      let jspfTracks;
      try { jspfTracks = (await listenbrainz.getPlaylist(token, mbid))?.playlist?.track || []; }
      catch (e) { logger.warn('sync', `lb-sync: fetch failed for ${mbid}: ${e.message}`); continue; }
      if (!jspfTracks.length) { logger.info('sync', `lb-sync: ${mbid} has no tracks`); continue; }

      const rows    = jspfTracks.map(jspfTrack);
      const matcher = await buildMatcherWarmed(db, rows);

      // Resolve tracks
      const trackIds       = [];
      const missingArtists = new Set();
      for (const row of rows) {
        if (!row.artist || !row.title) continue;
        const id = await matcher.matchWithAliases(row);
        if (id) trackIds.push(id); else missingArtists.add(row.artist);
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
        const result = await publishPlaylist(db, { id: sub.navidrome_id, name: displayTitle, type: TYPES.LB, config, trackIds });
        if (!result.ok) { logger.warn('sync', `lb-sync: failed to update "${displayTitle}": ${result.error}`); continue; }
        logger.info('sync', `lb-sync: "${displayTitle}" updated (${trackIds.length} tracks)`);
      } else {
        const result = await publishPlaylist(db, { name: displayTitle, type: TYPES.LB, config, trackIds });
        if (!result.ok) { logger.warn('sync', `lb-sync: failed to create "${displayTitle}": ${result.error}`); continue; }
        db.prepare('UPDATE lb_subscriptions SET navidrome_id = ? WHERE id = ?').run(result.playlistId, sub.id);
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
