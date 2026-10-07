'use strict';

/**
 * sync/helpers.js — shared utilities for the sync modules
 *
 * No imports from other sync files — exists specifically to break the
 * circular dependency between index.js and the provider sync modules.
 * Matching lives in lib/match.js, studio/live logic in lib/studio.js.
 */

const logger = require('../../utils/logger');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildNaviTitle(lbTitle, sourcePatch) {
  // Generated playlists (have source_patch) include a date/user suffix we strip
  // so the ND playlist name stays stable across rotations.
  // e.g. "Daily Jams for m0zer, 2026-04-18 Sat" → "Daily Jams for m0zer"
  const cleaned = sourcePatch ? lbTitle.split(', ')[0] : lbTitle;
  return `ListenBrainz — ${cleaned}`;
}

// LFM chart playlist titles in Navidrome
const LFM_CHART_TITLES = {
  weekly:      'Last.FM \u2014 Last.week',
  top_7day:    'Last.FM \u2014 Top Tracks (7 Days)',
  top_1month:  'Last.FM \u2014 Top Tracks (1 Month)',
  top_3month:  'Last.FM \u2014 Top Tracks (3 Months)',
  top_6month:  'Last.FM \u2014 Top Tracks (6 Months)',
  top_12month: 'Last.FM \u2014 Top Tracks (12 Months)',
  top_overall: 'Last.FM \u2014 Top Tracks (All Time)',
};

function buildLfmTitle(lfmId) {
  return LFM_CHART_TITLES[lfmId] || `Last.FM \u2014 ${lfmId}`;
}

const detachedRunning = new Set();
function runDetached(name, fn) {
  if (detachedRunning.has(name)) {
    logger.warn('sync', `${name} already running — skipping`);
    return;
  }
  detachedRunning.add(name);
  fn().catch(e => logger.error('sync', `${name} threw: ${e.message}`)).finally(() => detachedRunning.delete(name));
}

function writeMissingArtists(db, artistNames, source) {
  const isInLibrary = db.prepare('SELECT 1 FROM tracks WHERE LOWER(artist) = LOWER(?) LIMIT 1');
  const insert      = db.prepare(`
    INSERT OR IGNORE INTO missing_artists (artist_name, source, status, added_at)
    VALUES (?, ?, 'pending', ?)
  `);
  const now = Math.floor(Date.now() / 1000);
  let added = 0;
  db.transaction(names => {
    for (const name of names) {
      if (!name || isInLibrary.get(name)) continue;
      insert.run(name, source, now);
      added++;
    }
  })(artistNames);
  if (added > 0) logger.info('sync', `missing_artists: ${added} new entries from ${source}`);
  return added;
}

module.exports = {
  sleep,
  buildNaviTitle,
  buildLfmTitle,
  runDetached,
  writeMissingArtists,
};
