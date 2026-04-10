'use strict';

/**
 * sync/helpers.js — shared utilities for all sync modules
 *
 * No imports from other sync files — exists specifically to break the
 * circular dependency between index.js and the provider sync modules.
 */

const mb     = require('../../providers/musicbrainz');
const logger = require('../../utils/logger');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildMatchCacheLocal(db) {
  const rows = db.prepare('SELECT id, artist, title FROM tracks').all();
  const map  = new Map();
  for (const r of rows) {
    const k = `${(r.artist||'').toLowerCase().trim()}|||${(r.title||'').toLowerCase().trim()}`;
    map.set(k, r.id);
  }
  return map;
}

function matchLocal(artist, title, cache) {
  const k = `${(artist||'').toLowerCase().trim()}|||${(title||'').toLowerCase().trim()}`;
  return cache.get(k) || null;
}

// Session-level alias cache: artist_mbid → resolved local artist name
const artistAliasCache = new Map();

async function resolveArtistWithAliases(artistName, artistMbid, cache) {
  const nameLower = (artistName || '').toLowerCase().trim();

  if (artistMbid && artistAliasCache.has(artistMbid)) {
    logger.debug('sync', `alias cache hit: "${artistName}" (${artistMbid}) → "${artistAliasCache.get(artistMbid)}"`);
    return artistAliasCache.get(artistMbid);
  }

  const prefix = `${nameLower}|||`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      if (artistMbid) artistAliasCache.set(artistMbid, artistName);
      return artistName;
    }
  }

  if (!artistMbid) return artistName;

  try {
    const aliases = await mb.getArtistAliases(artistMbid);
    await sleep(1000);
    for (const alias of aliases) {
      const aliasLower  = alias.toLowerCase().trim();
      const aliasPrefix = `${aliasLower}|||`;
      for (const key of cache.keys()) {
        if (key.startsWith(aliasPrefix)) {
          logger.info('sync', `alias resolved: "${artistName}" → "${alias}" via MB`);
          artistAliasCache.set(artistMbid, alias);
          return alias;
        }
      }
    }
  } catch (e) {
    logger.warn('sync', `alias lookup failed for "${artistName}" (${artistMbid}): ${e.message}`);
    return artistName;
  }

  logger.info('sync', `alias miss for "${artistName}" (${artistMbid}) — no alias matched local cache`);
  artistAliasCache.set(artistMbid, artistName);
  return artistName;
}

function buildNaviTitle(lbTitle) {
  return `ListenBrainz — ${lbTitle}`;
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

function buildLfmSnapshotTitle(lfmId) {
  const base = LFM_CHART_TITLES[lfmId] || `Last.FM \u2014 ${lfmId}`;
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${base} \u2014 ${date}`;
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
  buildMatchCacheLocal,
  matchLocal,
  resolveArtistWithAliases,
  buildNaviTitle,
  buildLfmTitle,
  buildLfmSnapshotTitle,
  runDetached,
  writeMissingArtists
};
