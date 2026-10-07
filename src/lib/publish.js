'use strict';

/**
 * publish.js — single write path for every playlist naviList creates or regenerates
 *
 * publishPlaylist: Navidrome create/replace + name/comment, local registry
 * snapshot (type/config + track list), and the post-save studio tie-break.
 * Callers keep their source-specific concerns (subscriptions, cron schedules,
 * missing artists).
 */

const navidrome = require('../providers/navidrome');
const logger    = require('../utils/logger');
const { runDetached } = require('./sync/helpers');
const { refineStudioPicks } = require('./studio');
const { parseComment, buildComment, allowsLive } = require('./playlist_types');

// ── Registry snapshot ─────────────────────────────────────────────────────────

// Snapshot a playlist into the local registry. type/config are derived from the
// comment. A null name or comment keeps the existing value, so callers that only
// replace tracks never wipe the playlist type.
function snapshotPlaylist(db, id, name, comment, trackIds, duration) {
  const now = Math.floor(Date.now() / 1000);
  // If name is null, keep existing name
  const existing = db.prepare('SELECT name FROM navilist_playlists WHERE navidrome_id = ?').get(id);
  const resolvedName = name ?? existing?.name ?? '';
  const { type, config } = parseComment(comment);

  const upsert = db.prepare(`
    INSERT INTO navilist_playlists (navidrome_id, name, comment, type, config, active, track_count, duration, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(navidrome_id) DO UPDATE SET
      name        = excluded.name,
      comment     = COALESCE(excluded.comment, navilist_playlists.comment),
      type        = COALESCE(excluded.type,    navilist_playlists.type),
      config      = COALESCE(excluded.config,  navilist_playlists.config),
      track_count = excluded.track_count,
      duration    = COALESCE(excluded.duration, navilist_playlists.duration),
      active      = 1
  `);
  const delTracks = db.prepare('DELETE FROM navilist_playlist_tracks WHERE playlist_id = ?');
  const insTracks = db.prepare(
    'INSERT OR IGNORE INTO navilist_playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)'
  );
  db.transaction(() => {
    upsert.run(id, resolvedName, comment || null, type, config ? JSON.stringify(config) : null,
      trackIds.length, duration || null, now);
    delTracks.run(id);
    trackIds.forEach((tid, i) => insTracks.run(id, tid, i));
  })();
}

// Total duration (seconds) of the given tracks, from the local library.
function sumDuration(db, trackIds) {
  const get = db.prepare('SELECT duration FROM tracks WHERE id = ?');
  return trackIds.reduce((sum, id) => sum + (get.get(id)?.duration || 0), 0);
}

// ── Post-save studio tie-break ────────────────────────────────────────────────

// Runs detached so preview/save stay fast, then swaps any wrong duplicate picks
// in the saved playlist and warms the is_live cache. keepLive: the playlist's
// Studio / Live split takes live, so live picks stay.
function scheduleStudioRefine(db, playlistId, trackIds, comment, { keepLive = false } = {}) {
  runDetached(`studio-refine-${playlistId}`, async () => {
    const refined = await refineStudioPicks(db, trackIds, { keepLive });
    if (refined.length && refined.some((id, i) => id !== trackIds[i])) {
      await navidrome.replacePlaylistTracks(db, playlistId, refined);
      snapshotPlaylist(db, playlistId, null, comment, refined, null);
      logger.info('publish', `studio-refine: ${playlistId} updated after MB tie-break`);
    }
  });
}

// ── Publish ───────────────────────────────────────────────────────────────────

/**
 * Create (no id) or replace (id) a playlist in Navidrome, then snapshot it into
 * the registry and schedule the studio tie-break.
 *
 * opts:
 *   id       — existing Navidrome playlist id; omit to create a new playlist
 *   name     — required on create; on replace, renames the playlist if given
 *   type     — playlist type (lib/playlist_types.js); omit for manual playlists
 *   config   — type config (rules, subscription ids…)
 *   trackIds — final ordered track ids (callers guard against empty lists)
 *
 * Typed playlists get the studio tie-break; manual (untyped) ones are hand-picked
 * and left exactly as chosen.
 *
 * Returns { ok: true, playlistId, created } or { ok: false, error }.
 */
async function publishPlaylist(db, { id = null, name, type = null, config = null, trackIds }) {
  const comment = buildComment(type, config);
  let playlistId = id;

  if (playlistId) {
    const replaced = await navidrome.replacePlaylistTracks(db, playlistId, trackIds);
    if (!replaced.ok) return replaced;
  } else {
    const created = await navidrome.createPlaylist(db, name, trackIds);
    if (!created.ok) return created;
    playlistId = created.playlist?.id;
    if (!playlistId) return { ok: false, error: 'No playlist ID returned from Navidrome' };
  }

  const meta = {};
  if (id && name) meta.name    = name;
  if (comment)    meta.comment = comment;
  if (Object.keys(meta).length) await navidrome.updatePlaylist(db, playlistId, meta);

  snapshotPlaylist(db, playlistId, name ?? null, comment, trackIds, sumDuration(db, trackIds));
  if (type) scheduleStudioRefine(db, playlistId, trackIds, comment, { keepLive: allowsLive(config) });

  return { ok: true, playlistId, created: !id };
}

module.exports = { publishPlaylist, snapshotPlaylist };
