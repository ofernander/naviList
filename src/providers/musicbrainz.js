'use strict';

/**
 * musicbrainz.js — MusicBrainz API provider
 *
 * No API key required. Rate limit: 1 req/sec (enforced by callers).
 * Docs: https://musicbrainz.org/doc/MusicBrainz_API
 */

const BASE_URL   = 'https://musicbrainz.org/ws/2';
const TIMEOUT    = 15000;
const USER_AGENT = 'naviList (https://github.com/ofernander/navilist)';
const RATE_LIMIT_MS = 2000;   // MusicBrainz allows ~1 req / 2s per IP
const MAX_ATTEMPTS  = 3;      // initial try + 2 retries on transient failure

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Global request spacer — serializes ALL MB calls (tags, artist, recordings)
// so concurrent loops can never collectively exceed the rate limit. Each caller
// reserves the next >=RATE_LIMIT_MS slot and waits for it.
let nextSlot = 0;
async function acquireSlot() {
  const now  = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot   = Math.max(now, nextSlot) + RATE_LIMIT_MS;
  if (wait) await sleep(wait);
}

// ── Core request ──────────────────────────────────────────────────────────────

async function request(path, params = {}) {
  const logger = require('../utils/logger');
  const qs  = new URLSearchParams({ fmt: 'json', ...params });
  const url = `${BASE_URL}${path}?${qs}`;
  logger.debug('musicbrainz', `request: ${path} ${JSON.stringify(params)}`);

  for (let attempt = 1; ; attempt++) {
    await acquireSlot();                        // global >=2s spacing
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT } });
      if (res.status === 503) {
        throw Object.assign(new Error('HTTP 503'), { retryAfter: parseInt(res.headers.get('retry-after'), 10) || 0 });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      const transient = e.name === 'AbortError' || e.name === 'TypeError' || e.message === 'HTTP 503';
      if (transient && attempt < MAX_ATTEMPTS) {
        logger.debug('musicbrainz', `${e.message || e.name} — retry ${attempt}/${MAX_ATTEMPTS - 1}`);
        await sleep((e.retryAfter || attempt) * 1000);   // honor Retry-After on 503, else linear backoff
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
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

// ── Recording live/studio ─────────────────────────────────────────────────────

// A recording is "live" if its disambiguation mentions live, or any release it
// appears on sits in a release-group tagged with the "Live" secondary type.
function isLiveRecording(rec) {
  const dis = (rec.disambiguation || '').toLowerCase();
  if (/\blive\b/.test(dis)) return true;
  for (const rel of rec.releases || []) {
    const sec = rel['release-group']?.['secondary-types'] || [];
    if (sec.some(t => String(t).toLowerCase() === 'live')) return true;
  }
  return false;
}

/**
 * Authoritative live/studio for a specific recording, looked up by MusicBrainz
 * recording id. Returns true if that recording is a live performance.
 */
async function getRecordingIsLive(mbid) {
  const data = await request(`/recording/${mbid}`, { inc: 'releases+release-groups' });
  return data ? isLiveRecording(data) : false;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { findArtistMbid, getArtistTagsByMbid, getArtistTags, getArtistAliases, getRecordingIsLive };
