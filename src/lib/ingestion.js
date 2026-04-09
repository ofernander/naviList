'use strict';

/**
 * ingestion.js — Generic listen ingestion pipeline
 *
 * Source-agnostic. Takes normalized listen objects from any adapter,
 * matches them to local track_ids, deduplicates, and writes to play_history.
 *
 * Design spec: MISC/ingestion.md
 */

const logger = require('../utils/logger');

// ── Normalization helpers ─────────────────────────────────────────────────────

function normalize(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/['']/g, '')           // smart quotes
    .replace(/[^\w\s]/g, ' ')       // punctuation → space
    .replace(/\s+/g, ' ')           // collapse whitespace
    .trim();
}

// ── Match cache ───────────────────────────────────────────────────────────────

/**
 * Build two lookup maps from the local tracks table.
 * Built once per ingest run, not per listen.
 *   exact:      'artist_lower|||title_lower' → track_id
 *   normalised: 'norm_artist|||norm_title'   → track_id
 */
function buildMatchCache(db) {
  const rows = db.prepare('SELECT id, artist, title FROM tracks').all();
  const exact      = new Map();
  const normalised = new Map();

  for (const row of rows) {
    const artist = (row.artist || '').toLowerCase().trim();
    const title  = (row.title  || '').toLowerCase().trim();
    exact.set(`${artist}|||${title}`, row.id);

    const na = normalize(row.artist);
    const nt = normalize(row.title);
    normalised.set(`${na}|||${nt}`, row.id);
  }

  return { exact, normalised };
}

function matchListen(listen, cache) {
  const artist = (listen.artist || '').toLowerCase().trim();
  const title  = (listen.title  || '').toLowerCase().trim();

  // 1. Exact lowercase match
  const exactKey = `${artist}|||${title}`;
  if (cache.exact.has(exactKey)) {
    logger.debug('ingestion', `exact match: "${listen.artist}" / "${listen.title}"`);
    return cache.exact.get(exactKey);
  }

  // 2. Normalised match (strip punctuation etc.)
  const na = normalize(listen.artist);
  const nt = normalize(listen.title);
  const normKey = `${na}|||${nt}`;
  if (cache.normalised.has(normKey)) {
    logger.debug('ingestion', `normalised match: "${listen.artist}" / "${listen.title}"`);
    return cache.normalised.get(normKey);
  }

  logger.debug('ingestion', `no match: "${listen.artist}" / "${listen.title}"`);
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Match an array of normalized listens against the local library.
 * Returns listens with track_id populated. Unmatched have track_id = null.
 */
function matchListens(db, listens) {
  const cache = buildMatchCache(db);
  return listens.map(listen => ({
    ...listen,
    track_id: matchListen(listen, cache)
  }));
}

/**
 * Filter out listens already in play_history.
 * Deduplicates on (track_id, played_at) — source-agnostic.
 * Also deduplicates on external_id where present.
 */
function deduplicateListens(db, listens) {
  const checkDedup      = db.prepare('SELECT id FROM play_history WHERE track_id = ? AND played_at = ?');
  const checkExternalId = db.prepare('SELECT id FROM play_history WHERE external_id = ?');

  return listens.filter(listen => {
    // Skip if external_id already exists
    if (listen.external_id) {
      if (checkExternalId.get(listen.external_id)) return false;
    }
    // Skip if (track_id, played_at) already exists
    return !checkDedup.get(listen.track_id, listen.played_at);
  });
}

/**
 * Write matched, deduplicated listens to play_history.
 * Returns number of rows written.
 */
function writeListens(db, listens) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO play_history (track_id, played_at, source, external_id)
    VALUES (@track_id, @played_at, @source, @external_id)
  `);

  const insertMany = db.transaction(rows => {
    for (const row of rows) insert.run(row);
  });

  insertMany(listens);
  return listens.length;
}

/**
 * Full ingestion pipeline. Takes raw normalized listens from any adapter.
 * Matches, deduplicates, writes, returns result summary.
 */
function ingestListens(db, listens) {
  if (!listens.length) {
    return { total: 0, matched: 0, unmatched: 0, skipped: 0, written: 0 };
  }

  // Step 1 — match to local library
  const withIds   = matchListens(db, listens);
  const matched   = withIds.filter(l => l.track_id !== null);
  const unmatched = withIds.filter(l => l.track_id === null);

  // Step 2 — deduplicate against existing play_history
  const deduped = deduplicateListens(db, matched);
  const skipped = matched.length - deduped.length;

  // Step 3 — write
  const written = deduped.length > 0 ? writeListens(db, deduped) : 0;

  logger.info('ingestion', [
    `total: ${listens.length}`,
    `matched: ${matched.length}`,
    `unmatched: ${unmatched.length}`,
    `skipped (dupe): ${skipped}`,
    `written: ${written}`
  ].join(' | '));

  return {
    total:     listens.length,
    matched:   matched.length,
    unmatched: unmatched.length,
    skipped,
    written
  };
}

module.exports = { matchListens, deduplicateListens, writeListens, ingestListens };
