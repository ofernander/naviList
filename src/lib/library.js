const express   = require('express');
const router    = express.Router();
const path      = require('path');
const db        = require('../db/index');
const fs        = require('fs');
const navidrome = require('../providers/navidrome');

// ── Helpers ───────────────────────────────────────────────────────────────────
// getSettings and buildNaviParams delegate to navidrome.js — single source of truth
function getSettings()                      { return navidrome.getSettings(db); }
function buildNaviParams(settings, extra)   { return navidrome.buildParams(settings, extra); }

// ── GET /library — serve static HTML page ────────────────────────────────────
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'library.html'));
});

// ── GET /library/artistart/:artistId — serve cached image from disk ───────────
// Images are downloaded during sync. If not found, return 404 (placeholder shown).
router.get('/artistart/:artistId', (req, res) => {
  const imgPath = path.join(process.env.DATA_DIR || '/app/data', 'artist-images', `${req.params.artistId}.jpg`);
  if (fs.existsSync(imgPath)) {
    res.set('Cache-Control', 'public, max-age=604800');
    return res.sendFile(imgPath);
  }
  res.status(404).end();
});

// ── GET /library/coverart/:albumId — proxy album cover from Navidrome ──────
router.get('/coverart/:albumId', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  try {
    const settings = getSettings();
    const base     = settings.navidrome_url?.replace(/\/$/, '');
    if (!base) return res.status(503).end();

    const params   = buildNaviParams(settings, { id: req.params.albumId, size: 300 });
    const upstream = await fetch(`${base}/rest/getCoverArt?${params}`);
    if (!upstream.ok) return res.status(404).end();

    const ct = upstream.headers.get('content-type') || 'image/jpeg';
    res.set('Content-Type', ct);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    res.status(500).end();
  }
});

// ── GET /library/api/artists — paginated artist grid ─────────────────────────
router.get('/api/artists', (req, res) => {
  const {
    search = '',
    genre  = '',
    sort   = 'artist',
    offset = 0,
    limit  = 2000
  } = req.query;

  const validSorts = {
    artist:           'artist',
    play_count_desc:  'total_plays',
    album_count_desc: 'album_count',
  };

  const sortCol = validSorts[sort] || 'artist';
  const sortDir = sort.endsWith('_desc') ? 'DESC' : 'ASC';

  const conditions = ['artist_id IS NOT NULL', 'artist IS NOT NULL'];
  const params     = [];

  if (search) { conditions.push(`artist LIKE ?`);  params.push(`%${search}%`); }
  if (genre)  { conditions.push(`genre = ?`);       params.push(genre); }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const sql = `
    SELECT
      artist_id,
      artist,
      COUNT(DISTINCT album_id)  AS album_count,
      COUNT(*)                  AS track_count,
      SUM(play_count)           AS total_plays
    FROM tracks
    ${where}
    GROUP BY artist_id
    ORDER BY ${sortCol} ${sortDir} NULLS LAST
    LIMIT ? OFFSET ?
  `;

  const countSql = `
    SELECT COUNT(*) AS total FROM (
      SELECT artist_id FROM tracks ${where} GROUP BY artist_id
    )
  `;

  const artists = db.prepare(sql).all(...params, parseInt(limit), parseInt(offset));
  const { total } = db.prepare(countSql).get(...params);

  res.json({ ok: true, artists, total, offset: parseInt(offset) });
});

// ── GET /library/api/albums — albums for a given artist ──────────────────────
router.get('/api/albums', (req, res) => {
  const { artist_id, search = '', genre = '', year = '', offset = 0, limit = 200 } = req.query;

  const conditions = ['album_id IS NOT NULL'];
  const params = [];

  if (artist_id) { conditions.push(`artist_id = ?`);              params.push(artist_id); }
  if (search)    { conditions.push(`(album LIKE ? OR artist LIKE ?)`); const q = `%${search}%`; params.push(q, q); }
  if (genre)     { conditions.push(`genre = ?`);                   params.push(genre); }
  if (year)      { conditions.push(`year = ?`);                    params.push(parseInt(year)); }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const sql = `
    SELECT album_id, album, artist, year, genre,
           COUNT(*) AS track_count, SUM(play_count) AS total_plays
    FROM tracks ${where}
    GROUP BY album_id
    ORDER BY COALESCE(year, 9999) ASC, album ASC
    LIMIT ? OFFSET ?
  `;

  const albums = db.prepare(sql).all(...params, parseInt(limit), parseInt(offset));
  res.json({ ok: true, albums });
});

// ── GET /library/api/albums/:albumId/tracks ───────────────────────────────────
router.get('/api/albums/:albumId/tracks', (req, res) => {
  const tracks = db.prepare(`
    SELECT id, title, artist, album, duration, play_count
    FROM tracks WHERE album_id = ?
    ORDER BY title ASC
  `).all(req.params.albumId);
  res.json({ ok: true, tracks });
});

// ── GET /library/api/tracks — flat list (addTo flow) ─────────────────────────
router.get('/api/tracks', (req, res) => {
  const { search = '', genre = '', year = '', sort = 'title', order = 'asc', offset = 0, limit = 100 } = req.query;
  const validSorts = { title: 't.title', artist: 't.artist', album: 't.album', genre: 't.genre', year: 't.year', play_count: 't.play_count' };
  const sortCol = validSorts[sort] || 't.title';
  const sortDir = order === 'desc' ? 'DESC' : 'ASC';
  const conditions = [], params = [];

  if (search) { conditions.push(`(t.title LIKE ? OR t.artist LIKE ? OR t.album LIKE ?)`); const q = `%${search}%`; params.push(q, q, q); }
  if (genre)  { conditions.push(`t.genre = ?`); params.push(genre); }
  if (year)   { conditions.push(`t.year = ?`);  params.push(parseInt(year)); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const tracks = db.prepare(`SELECT t.id, t.title, t.artist, t.album, t.genre, t.year, t.duration, t.play_count FROM tracks t ${where} ORDER BY ${sortCol} ${sortDir} NULLS LAST LIMIT ? OFFSET ?`).all(...params, parseInt(limit), parseInt(offset));
  const { total } = db.prepare(`SELECT COUNT(*) as total FROM tracks t ${where}`).get(...params);
  res.json({ ok: true, tracks, total, offset: parseInt(offset), limit: parseInt(limit) });
});

module.exports = router;
