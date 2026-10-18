'use strict';

/**
 * musicbrainz.js — MusicBrainz API provider
 *
 * Talks to musicbrainz.org by default (no key; one request every 2 seconds), or to
 * a server of the user's own that speaks the same /ws/2 API (a mirror, or a caching
 * server such as nuLMD) — see configure(). A custom server can need an API key, sent
 * as `X-API-Key`, and sets its own delay between requests.
 * Docs: https://musicbrainz.org/doc/MusicBrainz_API
 */

const DEFAULT_BASE  = 'https://musicbrainz.org/ws/2';
const TIMEOUT       = 15000;
const USER_AGENT    = 'naviList (https://github.com/ofernander/navilist)';
const PUBLIC_DELAY_MS = 2000;   // musicbrainz.org allows ~1 req / 2s per IP
const MAX_ATTEMPTS  = 3;        // initial try + 2 retries on transient failure

// ── Which server ─────────────────────────────────────────────────────────────

// '' / blank → musicbrainz.org. Accepts http(s)://host[:port] with or without /ws/2.
// Throws on anything else.
function normalizeBase(raw) {
  const text = String(raw || '').trim();
  if (!text) return DEFAULT_BASE;
  let u;
  try { u = new URL(text); } catch (e) { throw new Error(`"${text}" is not a valid URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('the MusicBrainz server URL must start with http:// or https://');
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.origin}${/\/ws\/2$/.test(path) ? path : `${path}/ws/2`}`;
}

// The public servers keep the 2 second spacing whatever the delay setting says, and never
// receive an API key meant for a private server.
const isPublicHost = base => /(^|\.)musicbrainz\.org$/i.test(new URL(base).hostname);

// The setting values → { base, key, delayMs } (throws on a bad URL).
function resolve(settings = {}) {
  const base   = normalizeBase(settings.musicbrainz_url);
  const custom = !isPublicHost(base);
  const d      = parseInt(settings.musicbrainz_delay_ms, 10);
  return {
    base,
    custom,
    key:     custom ? String(settings.musicbrainz_api_key || '').trim() : '',
    delayMs: custom ? (Number.isFinite(d) && d >= 0 ? d : 0) : PUBLIC_DELAY_MS,
  };
}

let current = resolve();

// Apply the saved settings (at startup, and whenever they are saved). A bad URL is
// logged and musicbrainz.org is used until it's fixed.
function configure(settings) {
  const logger = require('../utils/logger');
  try { current = resolve(settings); }
  catch (e) { logger.warn('musicbrainz', `${e.message} — using musicbrainz.org`); current = resolve(); }
  logger.info('musicbrainz', `server: ${current.base}${current.custom ? ` (delay ${current.delayMs}ms${current.key ? ', API key set' : ''})` : ''}`);
}

// ms between requests right now — callers that pace their own loops use it.
const requestDelayMs = () => current.delayMs;

function requestHeaders(c = current) {
  return { 'User-Agent': USER_AGENT, ...(c.key ? { 'X-API-Key': c.key } : {}) };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Global request spacer — serializes ALL MB calls (tags, artist, recordings)
// so concurrent loops can never collectively exceed the rate limit. Each caller
// reserves the next slot (the configured delay after the previous one) and waits for it.
// A delay of 0 (your own server) skips the spacing.
let nextSlot = 0;
async function acquireSlot() {
  if (!current.delayMs) return;
  const now  = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot   = Math.max(now, nextSlot) + current.delayMs;
  if (wait) await sleep(wait);
}

// ── Core request ──────────────────────────────────────────────────────────────

async function request(path, params = {}) {
  const logger = require('../utils/logger');
  const qs  = new URLSearchParams({ fmt: 'json', ...params });
  const url = `${current.base}${path}?${qs}`;
  logger.debug('musicbrainz', `request: ${path} ${JSON.stringify(params)}`);

  for (let attempt = 1; ; attempt++) {
    await acquireSlot();                        // global spacing (2s on musicbrainz.org)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: requestHeaders() });
      if (res.status === 503) {
        throw Object.assign(new Error('HTTP 503'), { retryAfter: parseInt(res.headers.get('retry-after'), 10) || 0 });
      }
      if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status} — the MusicBrainz server refused the API key`);
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

// Settings page "Test", run against the given (unsaved) URL and key: one search for MusicBrainz's
// built-in "Various Artists" entry — present on every MusicBrainz server and tied to no artist or
// genre. A search checks the server, the key and the search index naviList depends on to find artist
// IDs. It is deliberately NOT a lookup of that entry by ID: nuLMD refuses its built-in special artists
// (404), and looking up a special artist there can start a huge background fetch.
// → { ok: true, ms } or { ok: false, error }.
const PROBE = { id: '89ad4ac3-39f7-470e-963a-56509c546377', name: 'Various Artists' };

async function ping(settings) {
  let c;
  try { c = resolve(settings); } catch (e) { return { ok: false, error: e.message }; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  const started = Date.now();
  try {
    const res = await fetch(`${c.base}/artist?${new URLSearchParams({ query: `artist:"${PROBE.name}"`, limit: 5, fmt: 'json' })}`,
      { signal: controller.signal, headers: requestHeaders(c) });
    if (res.status === 401 || res.status === 403) return { ok: false, error: `the server refused the API key (HTTP ${res.status})` };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => null);
    if (!Array.isArray(data?.artists)) return { ok: false, error: 'the server answered, but not like a MusicBrainz /ws/2 API' };
    if (!data.artists.some(a => a.id === PROBE.id))
      return { ok: false, error: 'the search ran but found nothing — the search index may be empty or still building' };
    return { ok: true, ms: Date.now() - started, server: c.base };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timed out' : `cannot reach the server (${e.message})` };
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

/**
 * One page of an artist's live releases (release-group type Live, credited to
 * the artist), with their recordings. MB caps a page at ~500 tracks.
 * Returns { recordingIds, next } — next is the offset of the following page, or
 * null when this was the last one.
 */
async function getLiveRecordingsPage(artistMbid, offset = 0) {
  // A 404 means this server has nothing to browse for the artist — nuLMD refuses MusicBrainz's special
  // artists such as Various Artists (and any artist its owner blocked). That is "no live releases",
  // not a failure to retry on every run.
  const data = await request('/release', { artist: artistMbid, type: 'live', inc: 'recordings', limit: 100, offset })
    .catch(e => { if (e.message === 'HTTP 404') return { releases: [] }; throw e; });
  const releases = data?.releases || [];
  const recordingIds = [];
  for (const rel of releases)
    for (const medium of rel.media || [])
      for (const t of medium.tracks || []) if (t.recording?.id) recordingIds.push(t.recording.id);
  const seen = offset + releases.length;
  return { recordingIds, next: releases.length && seen < (data?.['release-count'] || 0) ? seen : null };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { configure, ping, requestDelayMs, findArtistMbid, getArtistTagsByMbid, getArtistTags, getArtistAliases, getRecordingIsLive, getLiveRecordingsPage };
