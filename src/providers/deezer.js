/**
 * Deezer service — artist images only
 * No API key required. Adapted from nuLMD/server/providers/deezer.js
 * Uses native fetch instead of axios, no DB dependency.
 * Album covers come from Navidrome directly via /library/coverart/:albumId.
 */

const fs   = require('fs');
const path = require('path');
const logger  = require('../utils/logger');
const TIMEOUT = 5000;

// ── In-process cache ──────────────────────────────────────────────────────────
// artistName.toLowerCase() → { imageUrl: string|null, ts: number }
const _artistCache = new Map();
const CACHE_TTL    = 3600 * 1000; // 1 hour

async function _fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res  = await fetch(url, { signal: controller.signal });
    const json = await res.json();
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ── Artist search ─────────────────────────────────────────────────────────────

/**
 * Search Deezer for an artist. Returns best match { id, name, imageUrl } or null.
 * Not cached here — caller caches at the imageUrl level.
 */
async function _searchArtist(artistName) {
  if (!artistName) return null;

  try {
    const json    = await _fetchJson(`https://api.deezer.com/search/artist?q=${encodeURIComponent(artistName)}&limit=5`);
    const artists = json?.data;
    if (!artists?.length) return null;

    const searchLower = artistName.toLowerCase().replace(/^the\s+/i, '');
    let best = null;

    for (const a of artists) {
      if (!a?.id) continue;
      const aName = (a.name || '').toLowerCase().replace(/^the\s+/i, '');
      if (aName === searchLower || aName === artistName.toLowerCase()) {
        best = a;
        break;
      }
      if (!best && aName.includes(searchLower)) best = a;
    }

    if (!best) best = artists[0];
    if (!best?.id) return null;

    return {
      id:       best.id,
      name:     best.name,
      imageUrl: best.picture_big || best.picture_medium || best.picture || null
    };
  } catch (e) {
    logger.warn('deezer', `artist search failed for "${artistName}": ${e.message}`);
    return null;
  }
}

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * Get the best available artist image URL from Deezer.
 * @param {string} artistName
 * @returns {Promise<string|null>}
 */
async function getArtistImageUrl(artistName) {
  if (!artistName) return null;

  const key    = artistName.toLowerCase().trim();
  const cached = _artistCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.imageUrl;

  const artist = await _searchArtist(artistName);

  // Deezer returns a generic grey silhouette for artists with no image.
  // Its URL contains '/artist/0/'. Reject it.
  const imageUrl = (artist?.imageUrl && !artist.imageUrl.includes('/artist/0/'))
    ? artist.imageUrl
    : null;

  _artistCache.set(key, { imageUrl, ts: Date.now() });

  if (imageUrl) logger.info('deezer', `artist image found for "${artistName}" (id: ${artist.id})`);
  else          logger.warn('deezer', `no artist image for "${artistName}"`);

  return imageUrl;
}

// ── Public: download artist image to disk ────────────────────────────────────

/**
 * Fetch artist image from Deezer and write to destPath.
 * @param {string} artistName
 * @param {string} destPath  absolute path to write jpg to
 * @returns {Promise<boolean>} true if saved, false if no image found
 */
async function downloadArtistImage(artistName, destPath) {
  const imageUrl = await getArtistImageUrl(artistName);
  if (!imageUrl) return false;

  try {
    const res = await _fetchRaw(imageUrl);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
    logger.info('deezer', `saved artist image for "${artistName}" → ${destPath}`);
    return true;
  } catch (e) {
    logger.warn('deezer', `downloadArtistImage failed for "${artistName}": ${e.message}`);
    return false;
  }
}

async function _fetchRaw(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getArtistImageUrl, downloadArtistImage };
