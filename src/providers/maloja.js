'use strict';

const logger = require('../utils/logger');

/**
 * maloja.js — Maloja self-hosted scrobbler API provider
 *
 * Docs: <your-instance>/api_explorer
 * Auth: API key passed as ?key= query param.
 * Base path: /apis/mlj_1/
 *
 * All raw methods return Maloja JSON directly.
 * fetchListens() is the ingestion adapter — returns NormalizedListen[].
 */

const TIMEOUT = 15000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function request(baseUrl, apiKey, endpoint, params = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  const qs = new URLSearchParams({ key: apiKey, ...params });
  const url = `${baseUrl.replace(/\/$/, '')}/apis/mlj_1${endpoint}?${qs}`;
  logger.debug('maloja', `request: ${endpoint} ${JSON.stringify(params)}`);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Returns unix timestamp for the start of a named period, or null for all_time
function periodToRange(period) {
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  const ranges = {
    week:      now - 7   * DAY,
    month:     now - 30  * DAY,
    quarter:   now - 90  * DAY,
    half_year: now - 180 * DAY,
    year:      now - 365 * DAY,
    all_time:  null,
  };
  return ranges[period] ?? null;
}

/**
 * Get scrobbles, paginated.
 * Response: { list: [{ time, track: { title, artists[] }, album }] }
 */
async function getScrobbles(baseUrl, apiKey, { max, before, since } = {}) {
  const params = {};
  if (max)    params.max    = max;
  if (before) params.before = before;
  if (since)  params.since  = since;
  return request(baseUrl, apiKey, '/scrobbles', params);
}

/**
 * Get top artists for a time range.
 * Response: { list: [{ artist, scrobbles }] }
 */
async function getChartArtists(baseUrl, apiKey, { from, limit = 50 } = {}) {
  const params = { max: limit };
  if (from) params.from = from;
  return request(baseUrl, apiKey, '/charts/artists', params);
}

/**
 * Get top tracks for a time range.
 * Response: { list: [{ track: { title, artists[] }, scrobbles }] }
 */
async function getChartTracks(baseUrl, apiKey, { from, limit = 50 } = {}) {
  const params = { max: limit };
  if (from) params.from = from;
  return request(baseUrl, apiKey, '/charts/tracks', params);
}

/**
 * Ping — validate connection and API key.
 */
async function ping(baseUrl, apiKey) {
  try {
    await request(baseUrl, apiKey, '/serverinfo');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Fetch all scrobbles and return as NormalizedListen[].
 * Paginates using before cursor until exhausted or since threshold reached.
 * credentials: { baseUrl, apiKey }
 * options.since: unix timestamp (null = fetch all)
 */
async function fetchListens(credentials, options = {}) {
  const { baseUrl, apiKey } = credentials;
  const since  = options.since || null;
  const result = [];
  let   max_ts = null;
  let   done   = false;

  while (!done) {
    const params = { max: 1000 };
    if (max_ts) params.before = max_ts;
    if (since)  params.since  = since;

    const data = await getScrobbles(baseUrl, apiKey, params);
    const list = data?.list;
    if (!list?.length) break;

    for (const s of list) {
      const played_at = s.time;
      if (!played_at) continue;
      if (since && played_at <= since) { done = true; break; }

      const artists = s.track?.artists || [];
      result.push({
        artist:      typeof artists[0] === 'string' ? artists[0] : (artists[0]?.name || ''),
        title:       s.track?.title || '',
        album:       s.album?.name || null,
        played_at,
        source:      'maloja',
        external_id: null,
      });
    }

    if (!done) {
      const oldest = list[list.length - 1]?.time;
      if (!oldest || oldest === max_ts) break;
      max_ts = oldest - 1;
      await sleep(500);
    }
  }

  return result;
}

module.exports = {
  getScrobbles,
  getChartArtists,
  getChartTracks,
  ping,
  fetchListens,
  periodToRange,
};
