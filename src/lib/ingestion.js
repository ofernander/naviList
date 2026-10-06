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
const { buildMatcher } = require('./match');

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Match an array of normalized listens against the local library.
 * Returns listens with track_id populated. Unmatched have track_id = null.
 */
function matchListens(db, listens) {
  // excludeLive:false — scrobbles record what was actually played, live or not.
  const matcher = buildMatcher(db, { excludeLive: false });
  return listens.map(listen => ({
    ...listen,
    track_id: matcher.match({ artist: listen.artist, title: listen.title, mbid: listen.mbid || null })
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
