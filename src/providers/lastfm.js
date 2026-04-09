'use strict';

const logger = require('../utils/logger');

/**
 * lastfm.js — Last.fm API provider
 *
 * All methods return raw Last.fm JSON. Callers handle normalisation.
 * API key only required for all methods below — no secret needed for read-only.
 * Rate limit: Last.fm allows ~5 req/sec. Sync code throttles to 1/sec.
 *
 * Docs: https://www.last.fm/api
 */

const BASE_URL = 'https://ws.audioscrobbler.com/2.0/';
const TIMEOUT  = 8000;

// ── Core request ──────────────────────────────────────────────────────────────

async function request(apiKey, method, params = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  logger.debug('lastfm', `request: ${method} ${JSON.stringify(params)}`);
  try {
    const qs = new URLSearchParams({
      method,
      api_key: apiKey,
      format:  'json',
      ...params
    });

    const res = await fetch(`${BASE_URL}?${qs}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Artist methods ────────────────────────────────────────────────────────────

/**
 * Get artists similar to the given artist, ranked by similarity score.
 * Returns up to `limit` results (max 100).
 * Response: data.similarartists.artist[] — each has .name, .match (0.0–1.0), .mbid
 */
async function getSimilarArtists(apiKey, artistName, limit = 100) {
  return request(apiKey, 'artist.getSimilarArtists', {
    artist: artistName,
    limit
  });
}

/**
 * Get full artist info including biography, tags, stats.
 * Response: data.artist — has .name, .mbid, .tags.tag[], .stats.listeners, .stats.playcount
 */
async function getArtistInfo(apiKey, artistName) {
  return request(apiKey, 'artist.getInfo', {
    artist:      artistName,
    autocorrect: 1
  });
}

/**
 * Get top tracks for an artist.
 * Response: data.toptracks.track[] — each has .name, .playcount, .listeners, .mbid
 */
async function getArtistTopTracks(apiKey, artistName, limit = 50) {
  return request(apiKey, 'artist.getTopTracks', {
    artist:      artistName,
    limit,
    autocorrect: 1
  });
}

/**
 * Get top albums for an artist.
 * Response: data.topalbums.album[] — each has .name, .playcount, .mbid
 */
async function getArtistTopAlbums(apiKey, artistName, limit = 50) {
  return request(apiKey, 'artist.getTopAlbums', {
    artist:      artistName,
    limit,
    autocorrect: 1
  });
}

/**
 * Get community tags for an artist (unranked).
 * Response: data.tags.tag[] — each has .name, .url
 */
async function getArtistTags(apiKey, artistName) {
  return request(apiKey, 'artist.getTags', {
    artist:      artistName,
    autocorrect: 1
  });
}

/**
 * Get top tags for an artist, ranked by tag count (community votes).
 * Response: data.toptags.tag[] — each has .name, .count
 * This is the preferred tag source — more reliable than getTags.
 */
async function getArtistTopTags(apiKey, artistName) {
  return request(apiKey, 'artist.getTopTags', {
    artist:      artistName,
    autocorrect: 1
  });
}

// ── Tag methods ───────────────────────────────────────────────────────────────

/**
 * Get info about a tag including description.
 * Response: data.tag — has .name, .reach, .total, .wiki.summary
 */
async function getTagInfo(apiKey, tagName) {
  return request(apiKey, 'tag.getInfo', {
    tag: tagName
  });
}

/**
 * Get top artists for a tag.
 * Response: data.topartists.artist[] — each has .name, .mbid, .tagcount
 */
async function getTagTopArtists(apiKey, tagName, limit = 50) {
  return request(apiKey, 'tag.getTopArtists', {
    tag:   tagName,
    limit
  });
}

/**
 * Get top tracks for a tag.
 * Response: data.tracks.track[] — each has .name, .artist.name, .mbid
 */
async function getTagTopTracks(apiKey, tagName, limit = 50) {
  return request(apiKey, 'tag.getTopTracks', {
    tag:   tagName,
    limit
  });
}

// ── Track methods ─────────────────────────────────────────────────────────────

/**
 * Get info for a specific track.
 * Response: data.track — has .name, .artist, .album, .toptags.tag[], .wiki
 */
async function getTrackInfo(apiKey, artistName, trackName) {
  return request(apiKey, 'track.getInfo', {
    artist:      artistName,
    track:       trackName,
    autocorrect: 1
  });
}

/**
 * Get tracks similar to a given track.
 * Response: data.similartracks.track[] — each has .name, .artist.name, .match (0.0–1.0)
 */
async function getSimilarTracks(apiKey, artistName, trackName, limit = 50) {
  return request(apiKey, 'track.getSimilarTracks', {
    artist:      artistName,
    track:       trackName,
    limit,
    autocorrect: 1
  });
}

/**
 * Get top tags for a track.
 * Response: data.toptags.tag[] — each has .name, .count
 */
async function getTrackTopTags(apiKey, artistName, trackName) {
  return request(apiKey, 'track.getTopTags', {
    artist:      artistName,
    track:       trackName,
    autocorrect: 1
  });
}

// ── User methods ──────────────────────────────────────────────────────────────

/**
 * Get user profile info.
 * Response: data.user — has .name, .playcount, .registered, .country
 */
async function getUserInfo(apiKey, username) {
  return request(apiKey, 'user.getInfo', { user: username });
}

/**
 * Get user's top tracks for a period.
 * period: overall | 7day | 1month | 3month | 6month | 12month
 * Response: data.toptracks.track[] — each has .name, .artist.name, .playcount
 */
async function getTopTracks(apiKey, username, period = 'overall', limit = 50) {
  return request(apiKey, 'user.getTopTracks', { user: username, period, limit });
}

/**
 * Get user's top artists for a period.
 * Response: data.topartists.artist[] — each has .name, .playcount, .mbid
 */
async function getTopArtists(apiKey, username, period = 'overall', limit = 50) {
  return request(apiKey, 'user.getTopArtists', { user: username, period, limit });
}

/**
 * Get user's recent scrobbles.
 * Response: data.recenttracks.track[] — each has .name, .artist, .album, .date
 * Note: first track may have nowplaying=true if user is currently listening.
 */
async function getRecentTracks(apiKey, username, limit = 50) {
  return request(apiKey, 'user.getRecentTracks', { user: username, limit });
}

/**
 * Get user's loved tracks.
 * Response: data.lovedtracks.track[] — each has .name, .artist.name, .date
 */
async function getLovedTracks(apiKey, username, limit = 50) {
  return request(apiKey, 'user.getLovedTracks', { user: username, limit });
}

/**
 * Get user's top tags.
 * Response: data.toptags.tag[] — each has .name, .count
 */
async function getUserTopTags(apiKey, username, limit = 50) {
  return request(apiKey, 'user.getTopTags', { user: username, limit });
}

// ── Ingestion adapter ─────────────────────────────────────────────────────────

/**
 * Fetch all user scrobbles and return as NormalizedListen[].
 * Paginates through entire history. Stops when pages are exhausted or
 * when timestamps go below options.since.
 * credentials: { apiKey, username }
 * options.since: unix timestamp (null = fetch all)
 */
async function fetchListens(credentials, options = {}) {
  const { apiKey, username } = credentials;
  const since  = options.since || null;
  const limit  = 200; // max per page
  const result = [];
  let page     = 1;
  let total    = null;
  let done     = false;

  while (!done) {
    const params = { user: username, limit, page, extended: 0 };
    if (since) params.from = since + 1; // Last.fm 'from' is inclusive

    const data   = await request(apiKey, 'user.getRecentTracks', params);
    const tracks = data?.recenttracks?.track;
    const attr   = data?.recenttracks?.['@attr'];

    if (!tracks || !attr) break;

    if (total === null) total = parseInt(attr.totalPages) || 1;

    const arr = Array.isArray(tracks) ? tracks : [tracks];

    for (const t of arr) {
      // Skip nowplaying track
      if (t['@attr']?.nowplaying) continue;

      const played_at = parseInt(t.date?.uts);
      if (!played_at) continue;

      // Stop if we've gone below since threshold
      if (since && played_at <= since) { done = true; break; }

      result.push({
        artist:      t.artist?.['#text'] || t.artist || '',
        title:       t.name || '',
        album:       t.album?.['#text'] || null,
        played_at,
        source:      'lastfm',
        external_id: null
      });
    }

    if (page >= total) done = true;
    page++;

    // Throttle — 1 req/sec
    if (!done) await new Promise(r => setTimeout(r, 1000));
  }

  return result;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Artist
  getSimilarArtists,
  getArtistInfo,
  getArtistTopTracks,
  getArtistTopAlbums,
  getArtistTags,
  getArtistTopTags,
  // Tag
  getTagInfo,
  getTagTopArtists,
  getTagTopTracks,
  // Track
  getTrackInfo,
  getSimilarTracks,
  getTrackTopTags,
  // User
  getUserInfo,
  getTopTracks,
  getTopArtists,
  getRecentTracks,
  getLovedTracks,
  getUserTopTags,
  // Ingestion adapter
  fetchListens
};
