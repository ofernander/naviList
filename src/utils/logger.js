'use strict';

/**
 * logger.js — naviList logging system
 *
 * 4 levels in order: debug < info < warn < error
 * - Writes to stdout and /app/data/logs/navilist.log
 * - Rotates log file when it exceeds MAX_SIZE (5MB), keeping MAX_FILES rotations
 * - Active level read from DB every REFRESH_INTERVAL ms so UI changes take effect
 *   without restart. Falls back to LOG_LEVEL env var, then 'info'.
 * - setLevel(level) called immediately by the settings route on change.
 */

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const LOG_DIR   = '/app/data/logs';
const LOG_FILE  = path.join(LOG_DIR, 'navilist.log');
const MAX_SIZE  = 5 * 1024 * 1024; // 5MB
const MAX_FILES = 3;
const REFRESH_INTERVAL = 60 * 1000; // re-read level from DB every 60s

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

// ── State ─────────────────────────────────────────────────────────────────────

let _level      = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;
let _db         = null; // set lazily on first write to avoid circular dep
let _lastRefresh = 0;
let _stream     = null;

// ── Log directory + stream ────────────────────────────────────────────────────

function ensureStream() {
  if (_stream) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    _stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    _stream.on('error', e => console.error('[logger] stream error:', e.message));
  } catch (e) {
    // Running outside Docker or no write access — log to stdout only
    _stream = null;
  }
}

// ── Rotation ──────────────────────────────────────────────────────────────────

function rotate() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < MAX_SIZE) return;
  } catch (e) {
    return; // file doesn't exist yet
  }

  // Close current stream before rotating
  if (_stream) {
    try { _stream.end(); } catch (e) {}
    _stream = null;
  }

  // Shift: navilist.2.log → navilist.3.log, etc.
  for (let i = MAX_FILES - 1; i >= 1; i--) {
    const from = path.join(LOG_DIR, `navilist.${i}.log`);
    const to   = path.join(LOG_DIR, `navilist.${i + 1}.log`);
    try {
      if (fs.existsSync(from)) {
        if (fs.existsSync(to)) fs.unlinkSync(to);
        fs.renameSync(from, to);
      }
    } catch (e) {}
  }

  // navilist.log → navilist.1.log
  try {
    const archived = path.join(LOG_DIR, 'navilist.1.log');
    if (fs.existsSync(archived)) fs.unlinkSync(archived);
    fs.renameSync(LOG_FILE, archived);
  } catch (e) {}

  // Delete any overflow files beyond MAX_FILES
  try {
    const overflow = path.join(LOG_DIR, `navilist.${MAX_FILES + 1}.log`);
    if (fs.existsSync(overflow)) fs.unlinkSync(overflow);
  } catch (e) {}

  // Re-open stream on fresh file
  ensureStream();
}

// ── Level management ──────────────────────────────────────────────────────────

/**
 * Set active log level immediately (called by settings route on change).
 */
function setLevel(level) {
  const l = level?.toLowerCase();
  if (LEVELS[l] !== undefined) {
    _level = LEVELS[l];
  }
}

/**
 * Inject DB reference so logger can read level from settings table.
 * Called from db/index.js after DB initialisation.
 */
function setDb(db) {
  _db = db;
}

/**
 * Refresh active level from DB if interval has elapsed.
 * No-op if DB not available.
 */
function maybeRefreshLevel() {
  if (!_db) return;
  const now = Date.now();
  if (now - _lastRefresh < REFRESH_INTERVAL) return;
  _lastRefresh = now;
  try {
    const row = _db.prepare("SELECT value FROM settings WHERE key = 'log_level'").get();
    if (row?.value) setLevel(row.value);
  } catch (e) {
    // DB not ready — skip silently
  }
}

// ── Core write ────────────────────────────────────────────────────────────────

function timestamp() {
  return new Date().toISOString();
}

function write(levelName, context, message, data) {
  maybeRefreshLevel();

  const levelNum = LEVELS[levelName];
  if (levelNum < _level) return; // below active threshold — suppress

  const ts     = timestamp();
  const prefix = `[${ts}] [${levelName.toUpperCase().padEnd(5)}] [${context}]`;
  const line   = data !== undefined
    ? `${prefix} ${message} ${JSON.stringify(data)}`
    : `${prefix} ${message}`;

  // stdout
  console.log(line);

  // file
  ensureStream();
  rotate();
  if (_stream) {
    try { _stream.write(line + '\n'); } catch (e) {}
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

function debug(context, message, data) { write('debug', context, message, data); }
function info(context, message, data)  { write('info',  context, message, data); }
function warn(context, message, data)  { write('warn',  context, message, data); }
function error(context, message, data) { write('error', context, message, data); }

/**
 * Current active level name (for the UI to display).
 */
function getLevel() {
  const entry = Object.entries(LEVELS).find(([, v]) => v === _level);
  return entry ? entry[0] : 'info';
}

module.exports = { debug, info, warn, error, setLevel, setDb, getLevel };
