'use strict';

/**
 * similar.js — similar-artist cache (Last.fm), shared by radio and the rules
 * engine's `artist` term
 *
 * Fetched on demand, once per artist, and cached forever in artist_similar
 * (a '__none__' row marks "Last.fm has nothing"). Never a whole-library job.
 */

const lastfm = require('../providers/lastfm');
const mb     = require('../providers/musicbrainz');
const logger = require('../utils/logger');
const { getSettings } = require('../db/settings');

/**
 * Make sure similar artists are cached for each { artistId, name }. Looks up the
 * artist MBID (cached in `artists`) to sharpen the Last.fm query. A failed fetch
 * is not cached, so it is retried next time. No-op without a Last.fm API key.
 */
async function ensureSimilarArtists(db, artists) {
  const apiKey = getSettings(db).lastfm_api_key;
  if (!apiKey) { logger.debug('similar', 'no Last.fm API key — similar artists not fetched'); return; }

  const fetchedAt      = Math.floor(Date.now() / 1000);
  const hasCache       = db.prepare('SELECT 1 FROM artist_similar WHERE artist_id = ? LIMIT 1');
  const getMbid        = db.prepare('SELECT mbid FROM artists WHERE artist_id = ?');
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
    VALUES (@artistId, @similarName, @similarArtistId, @score, 'lastfm', @fetchedAt)
    ON CONFLICT(artist_id, similar_name) DO UPDATE SET
      similar_artist_id = excluded.similar_artist_id,
      score             = excluded.score,
      fetched_at        = excluded.fetched_at
  `);
  const insertSentinel = db.prepare(`
    INSERT OR IGNORE INTO artist_similar (artist_id, similar_name, similar_artist_id, score, source, fetched_at)
    VALUES (?, '__none__', NULL, NULL, 'lastfm', ?)
  `);

  for (const { artistId, name } of artists) {
    if (hasCache.get(artistId)) {
      logger.debug('similar', `"${name}" similar artists already cached`);
      continue;
    }

    let mbid = getMbid.get(artistId)?.mbid || null;
    if (!mbid) {
      try { mbid = await mb.findArtistMbid(name); }
      catch (e) { logger.warn('similar', `MBID lookup failed for "${name}": ${e.message}`); }
    }
    upsertArtist.run(artistId, name, mbid || null, fetchedAt);

    try {
      const data    = await lastfm.getSimilarArtists(apiKey, { name, mbid: mbid || undefined }, 100);
      const similar = data?.similarartists?.artist;
      if (!Array.isArray(similar) || !similar.length) {
        insertSentinel.run(artistId, fetchedAt);
        logger.info('similar', `"${name}" — no similar artists from Last.fm`);
        continue;
      }
      const rows = similar.map(s => ({
        artistId,
        similarName:     s.name,
        similarArtistId: resolveLocalId.get(s.name)?.artist_id ?? null,
        score:           parseFloat(s.match) || 0,
        fetchedAt
      }));
      db.transaction(rs => { for (const r of rs) upsertSimilar.run(r); })(rows);
      logger.info('similar', `"${name}" → ${similar.length} similar artists cached`);
    } catch (e) {
      logger.warn('similar', `Last.fm similar failed for "${name}": ${e.message}`);
    }
  }
}

// Cached similar artists in the library for one artist, most similar first.
function getSimilarArtists(db, artistId) {
  return db.prepare(`
    SELECT similar_artist_id AS artistId, score FROM artist_similar
    WHERE artist_id = ?
      AND similar_artist_id IS NOT NULL
      AND similar_name != '__none__'
    ORDER BY score DESC
  `).all(artistId);
}

module.exports = { ensureSimilarArtists, getSimilarArtists };
