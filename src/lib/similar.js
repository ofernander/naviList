'use strict';

/**
 * similar.js — similar-artist cache, used by the rules engine's `artist` term
 * when its `similar` option is set
 *
 * Two sources: Last.fm (needs an API key) and ListenBrainz (no key; works by
 * artist MBID). Fetched on demand, once per artist per source, and cached in
 * artist_similar (a '__none__' row marks "this source has nothing"). Scores are
 * stored scaled 0–1 within each artist's list, used only for ordering — depth
 * is by rank. Never a whole-library job.
 */

const lastfm       = require('../providers/lastfm');
const listenbrainz = require('../providers/listenbrainz');
const mb           = require('../providers/musicbrainz');
const logger       = require('../utils/logger');
const { getSettings } = require('../db/settings');

const SOURCES = { LASTFM: 'lastfm', LISTENBRAINZ: 'listenbrainz' };

// Default source: ListenBrainz — no API key needed, works for everyone.
const DEFAULT_SOURCE = SOURCES.LISTENBRAINZ;

// The source a rule actually uses: the requested one, else the default; Last.fm
// needs an API key, so without one it falls back to ListenBrainz.
function effectiveSource(db, requested) {
  if (requested === SOURCES.LASTFM && !getSettings(db).lastfm_api_key) {
    logger.warn('similar', 'Last.fm similar artists requested but no Last.fm API key — using ListenBrainz');
    return SOURCES.LISTENBRAINZ;
  }
  return requested || DEFAULT_SOURCE;
}

// ── Artist MBID (seed) ────────────────────────────────────────────────────────

// MBID of a library artist: cached in `artists`, else from one of the artist's
// recording MBIDs via ListenBrainz metadata, else a MusicBrainz name search.
async function resolveArtistMbid(db, artistId, name) {
  const cached = db.prepare('SELECT mbid FROM artists WHERE artist_id = ?').get(artistId)?.mbid;
  if (cached) return cached;

  let mbid = null;
  const rec = db.prepare('SELECT mbid FROM tracks WHERE artist_id = ? AND mbid IS NOT NULL LIMIT 1').get(artistId)?.mbid;
  if (rec) {
    try {
      const data    = await listenbrainz.getRecordingArtists(rec);
      const credits = Object.values(data || {})[0]?.artist?.artists || [];
      const want    = (name || '').toLowerCase().trim();
      mbid = (credits.find(a => (a.name || '').toLowerCase().trim() === want) || credits[0])?.artist_mbid || null;
    } catch (e) { logger.warn('similar', `LB metadata lookup failed for "${name}": ${e.message}`); }
  }
  if (!mbid) {
    try { mbid = await mb.findArtistMbid(name); }
    catch (e) { logger.warn('similar', `MBID lookup failed for "${name}": ${e.message}`); }
  }
  return mbid;
}

// ── Fetch per source ──────────────────────────────────────────────────────────

// [{ name, score }] most similar first, or [] when the source has nothing.
async function fetchSimilar(source, { name, mbid, apiKey }) {
  if (source === SOURCES.LASTFM) {
    const data = await lastfm.getSimilarArtists(apiKey, { name, mbid: mbid || undefined }, 100);
    const list = data?.similarartists?.artist;
    return Array.isArray(list) ? list.map(s => ({ name: s.name, score: parseFloat(s.match) || 0 })) : [];
  }
  if (!mbid) return [];
  const list = await listenbrainz.getSimilarArtists(mbid);
  return Array.isArray(list) ? list.map(s => ({ name: s.name, score: Number(s.score) || 0 })) : [];
}

/**
 * Make sure similar artists from `source` are cached for each { artistId, name }.
 * A failed fetch is not cached, so it is retried next time.
 */
async function ensureSimilarArtists(db, artists, source) {
  const apiKey    = getSettings(db).lastfm_api_key;
  const fetchedAt = Math.floor(Date.now() / 1000);
  const hasCache       = db.prepare('SELECT 1 FROM artist_similar WHERE artist_id = ? AND source = ? LIMIT 1');
  const upsertArtist   = db.prepare(`
    INSERT INTO artists (artist_id, name, mbid, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(artist_id) DO UPDATE SET
      mbid       = COALESCE(excluded.mbid, artists.mbid),
      updated_at = excluded.updated_at
  `);
  const resolveLocalId = db.prepare('SELECT DISTINCT artist_id FROM tracks WHERE LOWER(artist) = LOWER(?) LIMIT 1');
  const upsertSimilar  = db.prepare(`
    INSERT INTO artist_similar (artist_id, similar_name, similar_artist_id, score, source, fetched_at)
    VALUES (@artistId, @similarName, @similarArtistId, @score, @source, @fetchedAt)
    ON CONFLICT(artist_id, source, similar_name) DO UPDATE SET
      similar_artist_id = excluded.similar_artist_id,
      score             = excluded.score,
      fetched_at        = excluded.fetched_at
  `);
  const insertSentinel = db.prepare(`
    INSERT OR IGNORE INTO artist_similar (artist_id, similar_name, similar_artist_id, score, source, fetched_at)
    VALUES (?, '__none__', NULL, NULL, ?, ?)
  `);

  for (const { artistId, name } of artists) {
    if (hasCache.get(artistId, source)) {
      logger.debug('similar', `"${name}" ${source} similar artists already cached`);
      continue;
    }

    const mbid = await resolveArtistMbid(db, artistId, name);
    upsertArtist.run(artistId, name, mbid || null, fetchedAt);

    try {
      const similar = await fetchSimilar(source, { name, mbid, apiKey });
      if (!similar.length) {
        insertSentinel.run(artistId, source, fetchedAt);
        logger.info('similar', `"${name}" — no similar artists from ${source}${mbid ? '' : ' (no artist MBID)'}`);
        continue;
      }
      const top  = Math.max(...similar.map(s => s.score)) || 1;
      const rows = similar.map(s => ({
        artistId,
        similarName:     s.name,
        similarArtistId: resolveLocalId.get(s.name)?.artist_id ?? null,
        score:           s.score / top,
        source,
        fetchedAt
      }));
      db.transaction(rs => { for (const r of rs) upsertSimilar.run(r); })(rows);
      logger.info('similar', `"${name}" → ${similar.length} similar artists cached from ${source}`);
    } catch (e) {
      logger.warn('similar', `${source} similar failed for "${name}": ${e.message}`);
    }
  }
}

// Cached similar artists from `source` that are in the library, most similar first.
function getSimilarArtists(db, artistId, source) {
  return db.prepare(`
    SELECT similar_artist_id AS artistId, score FROM artist_similar
    WHERE artist_id = ?
      AND source = ?
      AND similar_artist_id IS NOT NULL
      AND similar_name != '__none__'
    ORDER BY score DESC
  `).all(artistId, source);
}

/**
 * Library artists similar to one seed, most similar first: [{ artistId, score }].
 * Uses the rule's source; when that is ListenBrainz and it gave nothing usable
 * (error, no data, or nobody in the library) and a Last.fm key is set, Last.fm
 * is tried instead. ListenBrainz's similar-artists endpoint is a Labs API with
 * no stability promise, so a failure must not silently shrink the playlist.
 * Each source's results stay in their own cache rows — scores never mix.
 */
async function similarForArtist(db, artistId, name, requested) {
  const source = effectiveSource(db, requested);
  await ensureSimilarArtists(db, [{ artistId, name }], source);
  let rows = getSimilarArtists(db, artistId, source);

  if (!rows.length && source === SOURCES.LISTENBRAINZ && getSettings(db).lastfm_api_key) {
    logger.info('similar', `"${name}" — nothing usable from ListenBrainz, trying Last.fm`);
    await ensureSimilarArtists(db, [{ artistId, name }], SOURCES.LASTFM);
    rows = getSimilarArtists(db, artistId, SOURCES.LASTFM);
  }
  return rows;
}

module.exports = { SOURCES, effectiveSource, ensureSimilarArtists, getSimilarArtists, similarForArtist };
