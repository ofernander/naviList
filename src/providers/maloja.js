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

// Returns YYYY/MM/DD (UTC) for the start of a named period, or null for all_time
function periodToRange(period) {
  const DAY = 86400 * 1000;
  const now = Date.now();
  const ranges = {
    week:      now - 7   * DAY,
    month:     now - 30  * DAY,
    quarter:   now - 90  * DAY,
    half_year: now - 180 * DAY,
    year:      now - 365 * DAY,
    all_time:  null,
  };
  const ms = ranges[period] ?? null;
  if (ms == null) return null;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

// Convert a unix timestamp (seconds) to YYYY/MM/DD (UTC) for mlj_1 time params
function tsToMljDate(ts) {
  const d = new Date(ts * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
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
  const since  = options.since || null;   // unix seconds (exact threshold), or null
  const result = [];
  const seen   = new Set();                // dedup by s.time across day-boundary overlap
  let   beforeDay = null;                  // YYYY/MM/DD cursor
  let   lastOldestDay = null;              // guard against non-advancing cursor
  let   done   = false;

  // Coarse server-side floor at day granularity; exact second-level filter is applied below.
  const sinceDay = since ? tsToMljDate(since) : null;

  while (!done) {
    const params = { max: 10000 };         // one UTC day must fit in a single page (see note)
    if (beforeDay) params.before = beforeDay;
    if (sinceDay)  params.since  = sinceDay;

    const data = await getScrobbles(baseUrl, apiKey, params);
    const list = data?.list;
    if (!list?.length) break;

    let addedThisPage = 0;
    for (const s of list) {
      const played_at = s.time;
      if (!played_at) continue;
      if (since && played_at <= since) { done = true; break; }
      if (seen.has(played_at)) continue;
      seen.add(played_at);
      addedThisPage++;

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

    if (done) break;

    const oldest = list[list.length - 1]?.time;
    if (!oldest) break;
    const oldestDay = tsToMljDate(oldest);
    // Cursor didn't advance to an earlier day and nothing new was added → stop (avoids infinite loop)
    if (oldestDay === lastOldestDay && addedThisPage === 0) break;
    lastOldestDay = oldestDay;
    beforeDay = oldestDay;                 // day-level upper bound; overlap absorbed by `seen`
    await sleep(500);
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
