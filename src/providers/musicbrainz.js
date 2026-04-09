'use strict';

/**
 * musicbrainz.js — MusicBrainz API provider
 *
 * No API key required. Rate limit: 1 req/sec (enforced by callers).
 * Docs: https://musicbrainz.org/doc/MusicBrainz_API
 */

const BASE_URL   = 'https://musicbrainz.org/ws/2';
const TIMEOUT    = 10000;
const USER_AGENT = 'naviList/0.1 (https://github.com/navilist)';

// ── Core request ──────────────────────────────────────────────────────────────

async function request(path, params = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  const logger = require('../utils/logger');
  logger.debug('musicbrainz', `request: ${path} ${JSON.stringify(params)}`);
  try {
    const qs  = new URLSearchParams({ fmt: 'json', ...params });
    const url = `${BASE_URL}${path}?${qs}`;
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': USER_AGENT }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Artist lookup ─────────────────────────────────────────────────────────────

/**
 * Search for an artist by name, return the best match's MusicBrainz ID.
 * Returns null if no confident match found (score threshold: 70/100).
 */
async function findArtistMbid(artistName) {
  const data = await request('/artist', {
    query: `artist:"${artistName}"`,
    limit: 5
  });
  const artists = data?.artists;
  if (!artists?.length) return null;

  const best = artists[0];
  if ((best.score || 0) < 70) return null;
  return best.id;
}

/**
 * Get tags for an artist by MBID.
 * Returns array of { name, count } sorted by count desc.
 */
async function getArtistTagsByMbid(mbid) {
  const data = await request(`/artist/${mbid}`, { inc: 'tags' });
  const tags = data?.tags || [];
  return tags
    .filter(t => t.name && typeof t.count === 'number')
    .sort((a, b) => b.count - a.count);
}

/**
 * Get tags for an artist by name. Combines search + tag fetch.
 * Returns array of { name, count } or empty array if not found / low confidence.
 */
async function getArtistTags(artistName) {
  const mbid = await findArtistMbid(artistName);
  if (!mbid) return [];
  return getArtistTagsByMbid(mbid);
}

/**
 * Get all known aliases for an artist by MBID.
 * Returns array of alias name strings.
 */
async function getArtistAliases(mbid) {
  const data = await request(`/artist/${mbid}`, { inc: 'aliases' });
  const aliases = data?.aliases || [];
  const names = aliases.map(a => a.name).filter(Boolean);
  if (data?.name) names.unshift(data.name); // primary name first
  return names;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { findArtistMbid, getArtistTagsByMbid, getArtistTags, getArtistAliases };
