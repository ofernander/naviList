const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../db/index');
const navidrome = require('../providers/navidrome');
const mb        = require('../providers/musicbrainz');
const lastfm    = require('../providers/lastfm');
const engine    = require('./pl_engine');
const logger = require('../utils/logger');

// ── Helper: snapshot a playlist into local registry ───────────────────────────

function snapshotPlaylist(db, id, name, comment, trackIds, duration) {
  const now = Math.floor(Date.now() / 1000);
  // If name is null, keep existing name
  const existing = db.prepare('SELECT name FROM navilist_playlists WHERE navidrome_id = ?').get(id);
  const resolvedName = name ?? existing?.name ?? '';

  const upsert = db.prepare(`
    INSERT INTO navilist_playlists (navidrome_id, name, comment, active, track_count, duration, created_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(navidrome_id) DO UPDATE SET
      name        = excluded.name,
      comment     = excluded.comment,
      track_count = excluded.track_count,
      duration    = excluded.duration,
      active      = 1
  `);
  const delTracks = db.prepare('DELETE FROM navilist_playlist_tracks WHERE playlist_id = ?');
  const insTracks = db.prepare(
    'INSERT OR IGNORE INTO navilist_playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)'
  );
  db.transaction(() => {
    upsert.run(id, resolvedName, comment || null, trackIds.length, duration || null, now);
    delTracks.run(id);
    trackIds.forEach((tid, i) => insTracks.run(id, tid, i));
  })();
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'playlists.html'));
});

// GET /playlists/api/list — merge active (from ND) with inactive (from local DB)
router.get('/api/list', async (req, res) => {
  const active   = await navidrome.getPlaylists(db);
  const inactive = db.prepare(`
    SELECT navidrome_id as id, name, comment, track_count as songCount,
           duration, 0 as active
    FROM navilist_playlists WHERE active = 0
  `).all();
  const createdAt = {};
  db.prepare('SELECT navidrome_id, created_at FROM navilist_playlists').all()
    .forEach(r => { createdAt[r.navidrome_id] = r.created_at; });
  const playlists = [
    ...active.map(p => ({ ...p, active: 1, created_at: createdAt[p.id] || null })),
    ...inactive
  ];
  res.json({ ok: true, playlists });
});

// GET /playlists/api/genres — distinct genre list for filter dropdown
router.get('/api/genres', (req, res) => {
  const genres = db.prepare(`
    SELECT DISTINCT genre FROM tracks
    WHERE genre IS NOT NULL AND genre != ''
    ORDER BY genre ASC
  `).all().map(r => r.genre);
  res.json({ ok: true, genres });
});

// GET /playlists/api/artists — distinct artist list for autocomplete
router.get('/api/artists', (req, res) => {
  const artists = db.prepare(`
    SELECT DISTINCT artist FROM tracks
    WHERE artist IS NOT NULL AND artist != ''
    ORDER BY artist ASC
  `).all().map(r => r.artist);
  res.json({ ok: true, artists });
});

// GET /playlists/api/:id — JSON detail (inactive playlists served from local snapshot)
router.get('/api/:id', async (req, res) => {
  const { id } = req.params;

  // Check if this is an inactive playlist
  const local = db.prepare('SELECT * FROM navilist_playlists WHERE navidrome_id = ? AND active = 0').get(id);
  if (local) {
    const tracks = db.prepare(`
      SELECT t.id, t.title, t.artist, t.duration
      FROM navilist_playlist_tracks npt
      JOIN tracks t ON t.id = npt.track_id
      WHERE npt.playlist_id = ? ORDER BY npt.position ASC
    `).all(id);
    return res.json({ ok: true, playlist: {
      id, name: local.name, comment: local.comment,
      entry: tracks, songCount: tracks.length, duration: local.duration
    }});
  }

  const playlist = await navidrome.getPlaylist(db, id);
  if (!playlist) return res.json({ ok: false, error: 'Not found' });
  res.json({ ok: true, playlist });
});

// POST /playlists/create-radio
router.post('/create-radio', async (req, res) => {
  const { name, artists, depth, track_count, include_seed } = req.body;
  if (!name?.trim())    return res.json({ ok: false, error: 'name required' });
  if (!artists?.length) return res.json({ ok: false, error: 'at least one artist required' });

  const settings = db.prepare('SELECT key, value FROM settings').all()
    .reduce((s, r) => { s[r.key] = r.value; return s; }, {});
  const apiKey = settings.lastfm_api_key;
  if (!apiKey) return res.json({ ok: false, error: 'Last.fm API key not configured' });

  const scoreThreshold = depth      ?? 0.25;
  const limit          = track_count ?? 50;
  const includeSeed    = include_seed ?? true;
  const fetchedAt      = Math.floor(Date.now() / 1000);

  const resolveArtistId = db.prepare('SELECT DISTINCT artist_id FROM tracks WHERE LOWER(artist) = LOWER(?) LIMIT 1');
  const upsertArtist    = db.prepare(`
    INSERT INTO artists (artist_id, name, mbid, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(artist_id) DO UPDATE SET
      mbid       = excluded.mbid,
      updated_at = excluded.updated_at
  `);
  const upsertSimilar = db.prepare(`
    INSERT INTO artist_similar (artist_id, similar_name, similar_artist_id, score, source, fetched_at)
    VALUES (@artistId, @similarName, @similarArtistId, @score, 'lastfm', @fetchedAt)
    ON CONFLICT(artist_id, similar_name) DO UPDATE SET
      similar_artist_id = excluded.similar_artist_id,
      score             = excluded.score,
      fetched_at        = excluded.fetched_at
  `);
  const resolveSimilarId = db.prepare('SELECT DISTINCT artist_id FROM tracks WHERE LOWER(artist) = LOWER(?) LIMIT 1');
  const insertSentinel   = db.prepare(`
    INSERT OR IGNORE INTO artist_similar (artist_id, similar_name, similar_artist_id, score, source, fetched_at)
    VALUES (?, '__none__', NULL, NULL, 'lastfm', ?)
  `);

  const seedArtistIds = [];

  for (const artistName of artists) {
    const artistRow = resolveArtistId.get(artistName);
    if (!artistRow) {
      logger.warn('playlists', `create-radio: "${artistName}" not found in library`);
      continue;
    }
    const artistId = artistRow.artist_id;
    seedArtistIds.push(artistId);

    // Fetch MBID — use cached value if available, otherwise look up
    let mbid = db.prepare('SELECT mbid FROM artists WHERE artist_id = ?').get(artistId)?.mbid || null;
    if (!mbid) {
      try {
        mbid = await mb.findArtistMbid(artistName);
      } catch (e) {
        logger.warn('playlists', `create-radio: MBID lookup failed for "${artistName}": ${e.message}`);
      }
    }
    upsertArtist.run(artistId, artistName, mbid || null, fetchedAt);

    // Only fetch similar artists if not already cached for this artist
    const cachedCount = db.prepare(
      'SELECT COUNT(*) as c FROM artist_similar WHERE artist_id = ?'
    ).get(artistId).c;

    if (!cachedCount) {
      try {
        const data    = await lastfm.getSimilarArtists(apiKey, { name: artistName, mbid: mbid || undefined }, 100);
        const similar = data?.similarartists?.artist;
        if (!Array.isArray(similar) || !similar.length) {
          insertSentinel.run(artistId, fetchedAt);
          logger.info('playlists', `create-radio: "${artistName}" — no similar artists from Last.fm`);
        } else {
          const rows = similar.map(s => ({
            artistId,
            similarName:     s.name,
            similarArtistId: resolveSimilarId.get(s.name)?.artist_id ?? null,
            score:           parseFloat(s.match) || 0,
            fetchedAt
          }));
          db.transaction(rs => { for (const r of rs) upsertSimilar.run(r); })(rows);
          logger.info('playlists', `create-radio: "${artistName}" → ${similar.length} similar artists cached`);
        }
      } catch (e) {
        logger.warn('playlists', `create-radio: Last.fm similar failed for "${artistName}": ${e.message}`);
        insertSentinel.run(artistId, fetchedAt);
      }
    } else {
      logger.info('playlists', `create-radio: "${artistName}" similar artists already cached (${cachedCount} rows)`);
    }
  }

  if (!seedArtistIds.length)
    return res.json({ ok: false, error: 'None of the seed artists were found in your library' });

  // Resolve tracks from similar artist cache
  const trackIds = engine.resolveRadio(db, { artistIds: seedArtistIds, depth: scoreThreshold, includeSeed });
  if (!trackIds.length)
    return res.json({ ok: false, error: 'No tracks found at this depth — try a wider setting' });

  engine.fisherYates(trackIds);
  const limited = trackIds.slice(0, limit);

  const created = await navidrome.createPlaylist(db, name.trim(), limited);
  if (!created.ok) return res.json(created);

  const playlistId = created.playlist?.id;
  const config     = { artists, artistIds: seedArtistIds, depth: scoreThreshold, track_count: limit, include_seed: includeSeed, source: 'lastfm' };
  const comment    = `navilist:radio ${JSON.stringify(config)}`;
  await navidrome.updatePlaylist(db, playlistId, { comment });
  snapshotPlaylist(db, playlistId, name.trim(), comment, limited, null);

  logger.info('playlists', `radio playlist created: "${name.trim()}" (${limited.length} tracks, ${seedArtistIds.length} seed artists)`);
  res.json({ ok: true, playlistId, count: limited.length });
});

// POST /playlists/create-smart — create playlist then immediately generate tracks from rules
router.post('/create-smart', async (req, res) => {
  const { name, rules } = req.body;
  if (!name?.trim()) return res.json({ ok: false, error: 'name required' });
  if (!rules)        return res.json({ ok: false, error: 'rules required' });

  const validation = engine.validateRules(rules);
  if (!validation.ok) return res.json({ ok: false, errors: validation.errors });

  const created = await navidrome.createPlaylist(db, name.trim(), []);
  if (!created.ok) return res.json(created);

  const playlistId = created.playlist?.id;
  if (!playlistId) return res.json({ ok: false, error: 'No playlist ID returned from Navidrome' });

  const trackIds = await engine.generatePlaylist(db, rules);
  if (!trackIds.length) return res.json({ ok: false, error: 'No tracks matched rules' });

  const result = await navidrome.replacePlaylistTracks(db, playlistId, trackIds);
  if (!result.ok) return res.json(result);

  const comment = `navilist:navilist ${JSON.stringify(rules)}`;
  await navidrome.updatePlaylist(db, playlistId, { comment });
  snapshotPlaylist(db, playlistId, name.trim(), comment, trackIds, null);

  logger.info('playlists', `smart playlist created: "${name.trim()}" (${trackIds.length} tracks)`);
  res.json({ ok: true, playlistId, count: trackIds.length });
});

// POST /playlists/create — create new playlist
router.post('/create', async (req, res) => {
  const { name, trackIds } = req.body;
  if (!name?.trim()) return res.json({ ok: false, error: 'Name is required' });

  const ids = trackIds ? (Array.isArray(trackIds) ? trackIds : [trackIds]) : [];
  const result = await navidrome.createPlaylist(db, name.trim(), ids);
  if (result.ok) snapshotPlaylist(db, result.playlist.id, name.trim(), null, ids, null);
  logger.info('playlists', `create: ${name} (${ids.length} tracks)`);
  res.json(result);
});

// POST /playlists/:id/rename — rename playlist
router.post('/:id/rename', async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.json({ ok: false, error: 'Name is required' });

  const local = db.prepare('SELECT active FROM navilist_playlists WHERE navidrome_id = ?').get(req.params.id);
  // Only update ND if active
  if (!local || local.active) {
    const result = await navidrome.updatePlaylist(db, req.params.id, { name: name.trim() });
    if (!result.ok) return res.json(result);
  }
  db.prepare('UPDATE navilist_playlists SET name = ? WHERE navidrome_id = ?').run(name.trim(), req.params.id);
  res.json({ ok: true });
});

// POST /playlists/:id/tracks/add — add tracks
router.post('/:id/tracks/add', async (req, res) => {
  const { trackIds } = req.body;
  if (!trackIds) return res.json({ ok: false, error: 'trackIds required' });
  const ids = Array.isArray(trackIds) ? trackIds : [trackIds];
  const result = await navidrome.addTracksToPlaylist(db, req.params.id, ids);
  if (result.ok) {
    // Append to local snapshot
    const existing = db.prepare(
      'SELECT MAX(position) as maxPos FROM navilist_playlist_tracks WHERE playlist_id = ?'
    ).get(req.params.id);
    let pos = (existing?.maxPos ?? -1) + 1;
    const ins = db.prepare(
      'INSERT OR IGNORE INTO navilist_playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)'
    );
    const insertMany = db.transaction(trackIds => { for (const tid of trackIds) ins.run(req.params.id, tid, pos++); });
    insertMany(ids);
    db.prepare('UPDATE navilist_playlists SET track_count = track_count + ? WHERE navidrome_id = ?').run(ids.length, req.params.id);
  }
  logger.info('playlists', `add ${ids.length} tracks to ${req.params.id}`);
  res.json(result);
});

// POST /playlists/:id/tracks/remove — remove tracks by index
router.post('/:id/tracks/remove', async (req, res) => {
  const { indexes } = req.body;
  const idx = Array.isArray(indexes) ? indexes : [indexes];
  const result = await navidrome.removeTracksFromPlaylist(db, req.params.id, idx);
  res.json(result);
});

// POST /playlists/:id/rules — save updated rules + regenerate
router.post('/:id/rules', async (req, res) => {
  const { rules } = req.body;
  if (!rules) return res.json({ ok: false, error: 'rules required' });

  const validation = engine.validateRules(rules);
  if (!validation.ok) return res.json({ ok: false, errors: validation.errors });

  const comment = `navilist:navilist ${JSON.stringify(rules)}`;
  const saved = await navidrome.updatePlaylist(db, req.params.id, { comment });
  if (!saved.ok) return res.json(saved);

  const trackIds = await engine.generatePlaylist(db, rules);
  if (!trackIds.length) return res.json({ ok: false, error: 'No tracks matched rules' });

  const result = await navidrome.replacePlaylistTracks(db, req.params.id, trackIds);
  if (!result.ok) return res.json(result);

  snapshotPlaylist(db, req.params.id, null, comment, trackIds, null);

  logger.info('playlists', `rules saved + regenerated ${req.params.id}: ${trackIds.length} tracks`);
  res.json({ ok: true, count: trackIds.length });
});

// POST /playlists/:id/generate — run engine, replace playlist tracks in Navidrome
router.post('/:id/generate', async (req, res) => {
  const { rules } = req.body;
  if (!rules) return res.json({ ok: false, error: 'rules required' });

  const validation = engine.validateRules(rules);
  if (!validation.ok) return res.json({ ok: false, errors: validation.errors });

  const trackIds = await engine.generatePlaylist(db, rules);
  if (!trackIds.length) return res.json({ ok: false, error: 'No tracks matched rules' });

  const result = await navidrome.replacePlaylistTracks(db, req.params.id, trackIds);
  if (!result.ok) return res.json(result);

  snapshotPlaylist(db, req.params.id, null, null, trackIds, null);

  logger.info('playlists', `generated playlist ${req.params.id}: ${trackIds.length} tracks`);
  res.json({ ok: true, count: trackIds.length });
});

// POST /playlists/:id/preview — dry run, returns per-rule counts
router.post('/:id/preview', async (req, res) => {
  const { rules } = req.body;
  if (!rules) return res.json({ ok: false, error: 'rules required' });

  const validation = engine.validateRules(rules);
  if (!validation.ok) return res.json({ ok: false, errors: validation.errors });

  const preview = await engine.previewRules(db, rules);
  res.json({ ok: true, preview });
});

// POST /playlists/:id/deactivate — remove from ND, keep locally
router.post('/:id/deactivate', async (req, res) => {
  const { id } = req.params;

  // Ensure we have a local snapshot before deleting from ND
  const existing = db.prepare('SELECT navidrome_id FROM navilist_playlists WHERE navidrome_id = ?').get(id);
  if (!existing) {
    const detail = await navidrome.getPlaylist(db, id);
    if (detail) {
      const tracks = Array.isArray(detail.entry) ? detail.entry
        : (detail.entry ? [detail.entry] : []);
      snapshotPlaylist(db, id, detail.name, detail.comment || null,
        tracks.map(t => t.id), detail.duration || null);
    }
  }

  const result = await navidrome.deletePlaylist(db, id);
  if (!result.ok) return res.json(result);
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE navilist_playlists SET active = 0, deactivated_at = ? WHERE navidrome_id = ?').run(now, id);
  // Clear LB playlists reference
  db.prepare('UPDATE lb_playlists SET navidrome_id = NULL, enabled = 0 WHERE navidrome_id = ?').run(id);
  logger.info('playlists', `deactivated "${id}" — removed from ND, kept locally`);
  res.json({ ok: true });
});

// POST /playlists/:id/activate — restore from local snapshot to ND
router.post('/:id/activate', async (req, res) => {
  const { id } = req.params;
  const local = db.prepare('SELECT * FROM navilist_playlists WHERE navidrome_id = ?').get(id);
  if (!local) return res.json({ ok: false, error: 'Playlist not found in local registry' });

  const trackIds = db.prepare(`
    SELECT track_id FROM navilist_playlist_tracks
    WHERE playlist_id = ? ORDER BY position ASC
  `).all(id).map(r => r.track_id);

  const created = await navidrome.createPlaylist(db, local.name, trackIds);
  if (!created.ok) return res.json(created);

  const newId = created.playlist.id;

  if (local.comment) {
    await navidrome.updatePlaylist(db, newId, { comment: local.comment });
  }

  db.transaction(() => {
    // Move track snapshot to new ND id
    db.prepare('UPDATE navilist_playlist_tracks SET playlist_id = ? WHERE playlist_id = ?').run(newId, id);
    // Replace registry row
    db.prepare('DELETE FROM navilist_playlists WHERE navidrome_id = ?').run(id);
    db.prepare(`
      INSERT INTO navilist_playlists (navidrome_id, name, comment, active, track_count, duration, created_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
    `).run(newId, local.name, local.comment, local.track_count, local.duration, local.created_at);
    // Update LB playlists if it pointed to old id
    db.prepare('UPDATE lb_playlists SET navidrome_id = ? WHERE navidrome_id = ?').run(newId, id);
  })();

  logger.info('playlists', `activated "${local.name}" → new ND id ${newId} (${trackIds.length} tracks)`);
  res.json({ ok: true, newId, count: trackIds.length });
});

// POST /playlists/:id/delete — delete from NL and ND (if active)
router.post('/:id/delete', async (req, res) => {
  const { id } = req.params;
  const local = db.prepare('SELECT active FROM navilist_playlists WHERE navidrome_id = ?').get(id);

  // Only delete from ND if active (inactive ones are already gone from ND)
  if (!local || local.active) {
    const result = await navidrome.deletePlaylist(db, id);
    if (!result.ok) return res.json(result);
  }

  db.transaction(() => {
    db.prepare('DELETE FROM navilist_playlist_tracks WHERE playlist_id = ?').run(id);
    db.prepare('DELETE FROM navilist_playlists WHERE navidrome_id = ?').run(id);
    db.prepare('UPDATE lb_playlists SET navidrome_id = NULL, enabled = 0 WHERE navidrome_id = ?').run(id);
  })();

  logger.info('playlists', `deleted ${id} (was ${local?.active ? 'active' : 'inactive'})`);
  res.json({ ok: true });
});

module.exports = router;
