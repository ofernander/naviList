'use strict';

const logger = require('../utils/logger');

/**
 * listenbrainz.js — ListenBrainz API provider
 *
 * Docs: https://listenbrainz.readthedocs.io/en/latest/users/api/
 * Auth: User token passed in Authorization header.
 * Rate limit: No hard limit documented — throttle to 1 req/sec to be safe.
 *
 * All raw methods return ListenBrainz JSON directly.
 * fetchListens() is the ingestion adapter — returns NormalizedListen[].
 */

const BASE_URL = 'https://api.listenbrainz.org/1';
const TIMEOUT  = 30000;

// ── Core request ──────────────────────────────────────────────────────────────

async function request(token, endpoint, params = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  logger.debug('listenbrainz', `request: ${endpoint} ${JSON.stringify(params)}`);
  try {
    const qs  = new URLSearchParams(params);
    const url = `${BASE_URL}${endpoint}?${qs}`;
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: token ? { Authorization: `Token ${token}` } : {}
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Listen history ────────────────────────────────────────────────────────────

/**
 * Get listens for a user.
 * max_ts: fetch listens before this timestamp (for pagination)
 * count: 1–1000 per page (default 1000)
 * Response: { payload: { listens[], user_id, count, total_listen_count } }
 */
async function getListens(token, username, { count = 1000, max_ts } = {}) {
  const params = { count };
  if (max_ts) params.max_ts = max_ts;
  return request(token, `/user/${username}/listens`, params);
}

// ── User statistics ───────────────────────────────────────────────────────────

/**
 * Get top artists for a user.
 * range: week | month | quarter | half_year | year | all_time
 * Response: { payload: { artists[], user_id, range, from_ts, to_ts } }
 */
async function getTopArtists(token, username, range = 'all_time', count = 25) {
  return request(token, `/stats/user/${username}/artists`, { range, count });
}

/**
 * Get top recordings (tracks) for a user.
 * Response: { payload: { recordings[], user_id, range, from_ts, to_ts } }
 */
async function getTopRecordings(token, username, range = 'all_time', count = 25) {
  return request(token, `/stats/user/${username}/recordings`, { range, count });
}

/**
 * Get top releases (albums) for a user.
 * Response: { payload: { releases[], user_id, range } }
 */
async function getTopReleases(token, username, range = 'all_time', count = 25) {
  return request(token, `/stats/user/${username}/releases`, { range, count });
}

/**
 * Get listening activity (listen counts per time period) for a user.
 * Response: { payload: { listening_activity[], user_id, range } }
 */
async function getListeningActivity(token, username, range = 'all_time') {
  return request(token, `/stats/user/${username}/listening-activity`, { range });
}

/**
 * Get daily activity breakdown (hour of day / day of week) for a user.
 * Response: { payload: { day_of_week[], user_id, range } }
 */
async function getDailyActivity(token, username, range = 'all_time') {
  return request(token, `/stats/user/${username}/daily-activity`, { range });
}

// ── Feedback (loved / hated tracks) ──────────────────────────────────────────

/**
 * Get tracks the user has loved (score=1) or hated (score=-1).
 * Response: { feedback[], total_count, count, offset }
 */
async function getFeedback(token, username, score = 1, count = 1000, offset = 0) {
  return request(token, `/feedback/user/${username}/get-feedback`, { score, count, offset });
}

/**
 * Submit feedback for a recording (love/hate/remove).
 * score: 1 (love) | -1 (hate) | 0 (remove)
 * Requires authentication token.
 */
async function submitFeedback(token, score, recordingMbid) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(`${BASE_URL}/feedback/recording-feedback`, {
      method:  'POST',
      signal:  controller.signal,
      headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ score, recording_mbid: recordingMbid })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Recommendations ───────────────────────────────────────────────────────────

/**
 * Get raw (unfiltered) recording recommendations for a user.
 * Response: { payload: { recordings[], user_name, total_recording_count } }
 */
async function getRecommendations(token, username, count = 25, offset = 0) {
  return request(token, `/cf/recommendation/user/${username}/recording`, { count, offset });
}

// ── Artist similarity / metadata ──────────────────────────────────────────────

const LABS_URL          = 'https://labs.api.listenbrainz.org';
const SIMILAR_ALGORITHM = 'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';

/**
 * Similar artists by co-listening sessions (ListenBrainz Labs API, no auth).
 * Response: [{ artist_mbid, name, score, ... }] most similar first, up to 100;
 * [] for an unknown artist. Scores are raw co-listening counts, not 0–1.
 */
async function getSimilarArtists(artistMbid) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  const qs = new URLSearchParams({ artist_mbids: artistMbid, algorithm: SIMILAR_ALGORITHM });
  logger.debug('listenbrainz', `request: labs similar-artists ${artistMbid}`);
  try {
    const res = await fetch(`${LABS_URL}/similar-artists/json?${qs}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Artist credit of one recording (no auth).
 * Response: { [recordingMbid]: { artist: { artists: [{ artist_mbid, name }] }, recording: {…} } }
 */
async function getRecordingArtists(recordingMbid) {
  return request(null, '/metadata/recording/', { recording_mbids: recordingMbid, inc: 'artist' });
}

/**
 * Artist credits of many recordings in one POST (no auth, up to 1000 MBIDs).
 * Returns { data, remaining, resetIn } — data shaped as getRecordingArtists;
 * remaining / resetIn from the rate-limit headers (NaN when absent).
 */
async function getRecordingsArtists(recordingMbids) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  logger.debug('listenbrainz', `request: POST /metadata/recording/ (${recordingMbids.length} recordings)`);
  try {
    const res = await fetch(`${BASE_URL}/metadata/recording/`, {
      method:  'POST',
      signal:  controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ recording_mbids: recordingMbids, inc: 'artist' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {
      data:      await res.json(),
      remaining: Number(res.headers.get('X-RateLimit-Remaining') ?? NaN),
      resetIn:   Number(res.headers.get('X-RateLimit-Reset-In') ?? NaN),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Playlists ─────────────────────────────────────────────────────────────────

/**
 * Playlists generated for a user (daily jams, weekly exploration…), newest first.
 * Response: { playlists: [{ playlist: JSPF }], count, offset }
 */
async function getPlaylistsCreatedFor(token, username) {
  return request(token, `/user/${username}/playlists/createdfor`, {});
}

/**
 * The user's own playlists.
 * Response: { playlists: [{ playlist: JSPF }], count, offset }
 */
async function getUserPlaylists(token, username) {
  return request(token, `/user/${username}/playlists`, {});
}

/**
 * One playlist with its tracks.
 * Response: { playlist: JSPF } — playlist.track[] each has title, creator,
 * identifier (recording URL) and the MusicBrainz track extension (artists[]).
 */
async function getPlaylist(token, mbid) {
  return request(token, `/playlist/${mbid}`, {});
}

// ── User info ─────────────────────────────────────────────────────────────────

/**
 * Validate a user token and get basic user info.
 * Response: { code, message, valid, user_name }
 */
async function validateToken(token) {
  return request(token, '/validate-token', {});
}

// ── Ingestion adapter ─────────────────────────────────────────────────────────

/**
 * Fetch all listens for a user and return as NormalizedListen[].
 * Paginates using max_ts until no more listens or since threshold reached.
 * credentials: { token, username }
 * options.since: unix timestamp (null = fetch all)
 */
async function fetchListens(credentials, options = {}) {
  const { token, username } = credentials;
  const since  = options.since || null;
  const result = [];
  let max_ts   = null;
  let done     = false;

  while (!done) {
    const params = { count: 1000 };
    if (max_ts) params.max_ts = max_ts;

    const data    = await getListens(token, username, params);
    const listens = data?.payload?.listens;

    if (!listens?.length) break;

    for (const l of listens) {
      const played_at = l.listened_at;
      if (!played_at) continue;

      // Stop if we've gone below since threshold
      if (since && played_at <= since) { done = true; break; }

      const track = l.track_metadata || {};

      result.push({
        artist:      track.artist_name  || '',
        title:       track.track_name   || '',
        album:       track.release_name || null,
        played_at,
        source:      'listenbrainz',
        external_id: `lb_${username}_${played_at}`
      });
    }

    if (!done) {
      // Next page: use oldest timestamp from this batch minus 1
      const oldest = listens[listens.length - 1]?.listened_at;
      if (!oldest || oldest === max_ts) break;
      max_ts = oldest - 1;
      await sleep(1000);
    }
  }

  return result;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Listen history
  getListens,
  // User statistics
  getTopArtists,
  getTopRecordings,
  getTopReleases,
  getListeningActivity,
  getDailyActivity,
  // Feedback
  getFeedback,
  submitFeedback,
  // Recommendations
  getRecommendations,
  // Artist similarity / metadata
  getSimilarArtists,
  getRecordingArtists,
  getRecordingsArtists,
  // Playlists
  getPlaylistsCreatedFor,
  getUserPlaylists,
  getPlaylist,
  // User info
  validateToken,
  // Ingestion adapter
  fetchListens
};
