'use strict';

const logger = require('../utils/logger');

/**
 * lidarr.js — Lidarr API provider
 *
 * Docs: https://lidarr.audio/
 * Auth: X-Api-Key header
 * Rate limit: none documented — no throttling needed for our use case
 */

const TIMEOUT = 10000;

// ── Core request ──────────────────────────────────────────────────────────────

async function request(settings, method, path, body = null) {
  const base = (settings.lidarr_url || '').replace(/\/$/, '');
  const key  = settings.lidarr_api_key || '';
  if (!base || !key) throw new Error('Lidarr URL and API key required');
  logger.debug('lidarr', `request: ${method} ${path}${body ? ' ' + JSON.stringify(body) : ''}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const opts = {
      method,
      signal:  controller.signal,
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${base}/api/v1${path}`, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Connection ────────────────────────────────────────────────────────────────

/**
 * Test connection. Returns { ok, version? }.
 */
async function ping(settings) {
  try {
    const data = await request(settings, 'GET', '/system/status');
    return { ok: true, version: data.version };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Profile / folder discovery ────────────────────────────────────────────────

/**
 * Get all root folders. Returns [{ id, path, freeSpace }].
 */
async function getRootFolders(settings) {
  const data = await request(settings, 'GET', '/rootfolder');
  return (Array.isArray(data) ? data : []).map(f => ({
    id:        f.id,
    path:      f.path,
    freeSpace: f.freeSpace
  }));
}

/**
 * Get all quality profiles. Returns [{ id, name }].
 */
async function getQualityProfiles(settings) {
  const data = await request(settings, 'GET', '/qualityprofile');
  return (Array.isArray(data) ? data : []).map(p => ({ id: p.id, name: p.name }));
}

/**
 * Get all metadata profiles. Returns [{ id, name }].
 */
async function getMetadataProfiles(settings) {
  const data = await request(settings, 'GET', '/metadataprofile');
  return (Array.isArray(data) ? data : []).map(p => ({ id: p.id, name: p.name }));
}

/**
 * Get all three in one call. Returns { rootFolders, qualityProfiles, metadataProfiles }.
 */
async function getAllProfiles(settings) {
  const [rootFolders, qualityProfiles, metadataProfiles] = await Promise.all([
    getRootFolders(settings),
    getQualityProfiles(settings),
    getMetadataProfiles(settings)
  ]);
  return { rootFolders, qualityProfiles, metadataProfiles };
}

// ── Artist ────────────────────────────────────────────────────────────────────

/**
 * Check if an artist is already monitored in Lidarr by MusicBrainz ID.
 * Returns { exists: bool, artist? }.
 */
async function artistExists(settings, foreignArtistId) {
  try {
    const data = await request(settings, 'GET', '/artist');
    const arr  = Array.isArray(data) ? data : [];
    const found = arr.find(a => a.foreignArtistId === foreignArtistId);
    return { exists: !!found, artist: found || null };
  } catch (e) {
    return { exists: false, error: e.message };
  }
}

/**
 * Add an artist to Lidarr by MusicBrainz ID.
 * Returns { ok, error? }.
 */
async function addArtist(settings, artistName, foreignArtistId) {
  const rootFolderPath      = settings.lidarr_root_folder;
  const qualityProfileId    = parseInt(settings.lidarr_quality_profile_id);
  const metadataProfileId   = parseInt(settings.lidarr_metadata_profile_id);

  if (!rootFolderPath || !qualityProfileId || !metadataProfileId) {
    return { ok: false, error: 'Lidarr root folder, quality profile, and metadata profile must be configured' };
  }

  // Check if already exists first
  const check = await artistExists(settings, foreignArtistId);
  if (check.exists) return { ok: true, skipped: true, reason: 'already in Lidarr' };

  try {
    await request(settings, 'POST', '/artist', {
      artistName,
      foreignArtistId,
      qualityProfileId,
      metadataProfileId,
      rootFolderPath,
      monitored:  true,
      addOptions: { searchForMissingAlbums: true }
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  ping,
  getRootFolders,
  getQualityProfiles,
  getMetadataProfiles,
  getAllProfiles,
  artistExists,
  addArtist
};
