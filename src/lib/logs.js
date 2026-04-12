'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const logger  = require('../utils/logger');
const db      = require('../db/index');

const LOG_DIR  = process.env.DATA_DIR ? require('path').join(process.env.DATA_DIR, 'logs') : '/app/data/logs';
const LOG_FILE = path.join(LOG_DIR, 'navilist.log');

// GET /logs — serve the logs page
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'logs.html'));
});

// GET /logs/api/level — return current active level
router.get('/api/level', (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'log_level'").get();
  res.json({ ok: true, level: row?.value || logger.getLevel() });
});

// POST /logs/api/level — set log level, persist to DB, apply immediately
router.post('/api/level', (req, res) => {
  const { level } = req.body;
  const valid = ['debug', 'info', 'warn', 'error'];
  if (!valid.includes(level)) {
    return res.json({ ok: false, error: `Invalid level. Must be one of: ${valid.join(', ')}` });
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('log_level', ?)").run(level);
  logger.setLevel(level);
  logger.info('logs', `log level changed to ${level}`);
  res.json({ ok: true, level });
});

// GET /logs/api/tail — return last N lines from log file, optionally filtered by level
router.get('/api/tail', (req, res) => {
  const lines  = Math.min(parseInt(req.query.lines) || 200, 1000);
  const filter = req.query.level?.toLowerCase() || 'all';

  try {
    if (!fs.existsSync(LOG_FILE)) {
      return res.json({ ok: true, lines: [], total: 0 });
    }

    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const all     = content.split('\n').filter(Boolean);

    const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
    const minLevel = LEVELS[filter] ?? 0;

    const filtered = filter === 'all'
      ? all
      : all.filter(line => {
          const m = line.match(/\[(DEBUG|INFO |WARN |ERROR)\]/);
          if (!m) return false;
          const lineLevelName = m[1].trim().toLowerCase();
          const lineLevel = LEVELS[lineLevelName] ?? 0;
          return lineLevel >= minLevel;
        });

    const tail = filtered.slice(-lines);
    res.json({ ok: true, lines: tail, total: filtered.length });
  } catch (e) {
    logger.error('logs', `tail failed: ${e.message}`);
    res.json({ ok: false, error: e.message, lines: [] });
  }
});

// DELETE /logs/api/clear — truncate the active log file
router.delete('/api/clear', (req, res) => {
  try {
    if (fs.existsSync(LOG_FILE)) fs.truncateSync(LOG_FILE, 0);
    logger.info('logs', 'log file cleared');
    res.json({ ok: true });
  } catch (e) {
    logger.error('logs', `clear failed: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
