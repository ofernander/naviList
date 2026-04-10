'use strict';

/**
 * sync/musicbrainz.js — MusicBrainz sync jobs
 */

const mb     = require('../../providers/musicbrainz');
const logger = require('../../utils/logger');
const { sleep, writeMissingArtists } = require('./index');

// ── Artist tags ───────────────────────────────────────────────────────────────

async function syncArtistTagsMusicbrainz(db) {
  const artists = db.prepare('SELECT DISTINCT artist_id, artist FROM tracks WHERE artist_id IS NOT NULL AND artist IS NOT NULL').all();
  const cached  = new Set(db.prepare("SELECT DISTINCT artist_id FROM artist_tags WHERE source = 'musicbrainz'").all().map(r => r.artist_id));
  const todo    = artists.filter(a => !cached.has(a.artist_id));

  logger.info('sync', `artist-tags/musicbrainz: ${todo.length} artists to fetch (${cached.size} already cached)`);
  if (!todo.length) return { ok: true, fetched: 0, failed: 0, total: 0 };

  const upsert = db.prepare(`
    INSERT INTO artist_tags (artist_id, tag, weight, source, fetched_at)
    VALUES (@artistId, @tag, @weight, 'musicbrainz', @fetchedAt)
    ON CONFLICT(artist_id, tag) DO UPDATE SET weight=excluded.weight, fetched_at=excluded.fetched_at
  `);
  const sentinel = db.prepare(`
    INSERT OR IGNORE INTO artist_tags (artist_id, tag, weight, source, fetched_at)
    VALUES (?, '__none__', 0, 'musicbrainz', ?)
  `);

  let fetched = 0, failed = 0;
  const fetchedAt = Math.floor(Date.now() / 1000);

  for (const { artist_id, artist } of todo) {
    try {
      const tags = await mb.getArtistTags(artist);
      if (!tags.length) { sentinel.run(artist_id, fetchedAt); fetched++; await sleep(1000); continue; }
      db.transaction(rows => { for (const r of rows) upsert.run(r); })(
        tags.map(t => ({ artistId: artist_id, tag: t.name.toLowerCase(), weight: t.count, fetchedAt }))
      );
      fetched++;
      logger.info('sync', `artist-tags/musicbrainz: "${artist}" → ${tags.length} tags`);
    } catch (e) {
      failed++;
      logger.warn('sync', `artist-tags/musicbrainz failed for "${artist}": ${e.message}`);
    }
    await sleep(1000);
  }
  logger.info('sync', `artist-tags/musicbrainz: ${fetched} fetched, ${failed} failed`);
  return { ok: true, fetched, failed, total: todo.length };
}

module.exports = { syncArtistTagsMusicbrainz };
