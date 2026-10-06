'use strict';

/**
 * refresh.js — regenerating naviList playlists
 *
 * refreshPlaylist(row) rebuilds one registry playlist from its stored type/config
 * (source → finalize inside the engine → publish). Cron schedules, the save
 * routes and the post-library-sync regeneration all go through it.
 */

const cron   = require('node-cron');
const db     = require('../db/index');
const engine = require('./pl_engine');
const logger = require('../utils/logger');
const navidrome = require('../providers/navidrome');
const { publishPlaylist } = require('./publish');
const { runDetached }     = require('./sync/helpers');
const { TYPES, SCHEDULED_TYPES, parseComment, buildComment, currentTypeConfig } = require('./playlist_types');

const scheduledTasks = new Map(); // navidrome_id → cron.ScheduledTask

// type/config from the registry columns (falling back to the mirrored comment),
// in the current shape — legacy radio configs come back as rules playlists.
function typeAndConfig(row) {
  let { type, config } = row.type ? { type: row.type, config: null } : parseComment(row.comment);
  if (row.type) { try { config = row.config ? JSON.parse(row.config) : null; } catch (e) {} }
  return currentTypeConfig(type, config);
}

// Rebuild one playlist's tracks from its type/config. Only rules playlists
// regenerate; everything else is skipped. Republishing writes the current
// config shape to the Navidrome comment.
async function refreshPlaylist(row, reason = 'cron-refresh') {
  const { type, config } = typeAndConfig(row);
  if (!SCHEDULED_TYPES.has(type) || !config) {
    logger.debug('refresh', `${reason}: "${row.name}" is not a regenerable playlist (type: ${type}) — skipping`);
    return;
  }
  try {
    const trackIds = await engine.generatePlaylist(db, config);
    if (!trackIds.length) { logger.warn('refresh', `${reason}: no tracks for "${row.name}" — skipping`); return; }

    const result = await publishPlaylist(db, { id: row.navidrome_id, type, config, trackIds });
    if (!result.ok) { logger.warn('refresh', `${reason}: publish failed for "${row.name}": ${result.error}`); return; }
    db.prepare('UPDATE navilist_playlists SET last_refreshed_at = ? WHERE navidrome_id = ?')
      .run(Math.floor(Date.now() / 1000), row.navidrome_id);
    logger.info('refresh', `${reason}: ${type} "${row.name}" regenerated (${trackIds.length} tracks)`);
  } catch (e) {
    logger.error('refresh', `${reason}: error refreshing "${row.name}": ${e.message}`);
  }
}

// ── Cron schedules ────────────────────────────────────────────────────────────

function schedulePlaylistRefresh(navidromeId, cronExpr) {
  // Cancel any existing task for this playlist first
  cancelPlaylistRefresh(navidromeId);

  const task = cron.schedule(cronExpr, () => {
    const row = db.prepare('SELECT * FROM navilist_playlists WHERE navidrome_id = ? AND active = 1').get(navidromeId);
    if (!row) { cancelPlaylistRefresh(navidromeId); return; }
    runDetached(`cron-refresh-${navidromeId}`, () => refreshPlaylist(row));
  });
  scheduledTasks.set(navidromeId, task);
  logger.info('refresh', `cron-refresh: scheduled "${navidromeId}" with expression: ${cronExpr}`);
}

function cancelPlaylistRefresh(navidromeId) {
  const existing = scheduledTasks.get(navidromeId);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(navidromeId);
    logger.info('refresh', `cron-refresh: cancelled schedule for "${navidromeId}"`);
  }
}

// Store + start a refresh schedule for a just-saved playlist. Invalid → skipped.
function setRefreshSchedule(navidromeId, cronExpr, label = 'save') {
  const expr = cronExpr?.trim();
  if (!expr) return;
  if (!cron.validate(expr)) {
    logger.warn('refresh', `${label}: invalid cron expression "${expr}" — skipping schedule`);
    return;
  }
  db.prepare('UPDATE navilist_playlists SET refresh_cron = ? WHERE navidrome_id = ?').run(expr, navidromeId);
  schedulePlaylistRefresh(navidromeId, expr);
}

function loadScheduledPlaylists() {
  const rows = db.prepare(
    'SELECT navidrome_id, name, refresh_cron FROM navilist_playlists WHERE refresh_cron IS NOT NULL AND active = 1'
  ).all();
  for (const row of rows) {
    schedulePlaylistRefresh(row.navidrome_id, row.refresh_cron);
  }
  logger.info('refresh', `cron-refresh: loaded ${rows.length} scheduled playlist(s) from DB`);
}

// ── Post-sync regeneration ────────────────────────────────────────────────────

// Regenerate every active rules playlist — run after a library sync brings in
// artists that were missing, so their tracks can appear.
async function regenerateRulesPlaylists(reason) {
  const rows = db.prepare(
    "SELECT * FROM navilist_playlists WHERE active = 1 AND (type = ? OR (type IS NULL AND comment LIKE 'navilist:navilist %'))"
  ).all(TYPES.NAVILIST);
  logger.info('refresh', `${reason}: regenerating ${rows.length} rules playlist(s)`);
  for (const row of rows) await refreshPlaylist(row, reason);
}

// ── Legacy comments ───────────────────────────────────────────────────────────

// The registry is converted to the current config shape by schema.js; this
// rewrites the Navidrome comment of any rules / legacy radio playlist whose
// comment is still in an older shape (radio, flat v1 rules), so the UI and
// Navidrome agree. Runs at startup; idempotent (a failed write is retried next
// start).
async function migrateLegacyComments() {
  const rows = db.prepare(
    "SELECT * FROM navilist_playlists WHERE comment LIKE 'navilist:radio %' OR comment LIKE 'navilist:navilist %'"
  ).all();
  const setComment = db.prepare('UPDATE navilist_playlists SET comment = ? WHERE navidrome_id = ?');
  let done = 0, stale = 0;
  for (const row of rows) {
    const { type, config } = typeAndConfig(row);
    const comment = buildComment(type, config);
    if (comment === row.comment) continue;
    stale++;
    if (row.active) {
      const res = await navidrome.updatePlaylist(db, row.navidrome_id, { comment });
      if (!res.ok) { logger.warn('refresh', `comment migration: "${row.name}" not updated: ${res.error}`); continue; }
    }
    setComment.run(comment, row.navidrome_id);
    done++;
  }
  if (stale) logger.info('refresh', `comment migration: ${done}/${stale} playlist comment(s) updated to the current rules format`);
}

module.exports = {
  migrateLegacyComments,
  refreshPlaylist,
  schedulePlaylistRefresh,
  cancelPlaylistRefresh,
  setRefreshSchedule,
  loadScheduledPlaylists,
  regenerateRulesPlaylists,
};
