const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../db/index');
const navidrome = require('../providers/navidrome');
const engine   = require('./pl_engine');
const logger = require('../utils/logger');

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'playlists.html'));
});

// GET /playlists/api/list — JSON list for client refresh
router.get('/api/list', async (req, res) => {
  const playlists = await navidrome.getPlaylists(db);
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

// GET /playlists/api/:id — JSON detail
router.get('/api/:id', async (req, res) => {
  const playlist = await navidrome.getPlaylist(db, req.params.id);
  if (!playlist) return res.json({ ok: false, error: 'Not found' });
  res.json({ ok: true, playlist });
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

  // Save rules into the comment field so they can be loaded for editing
  await navidrome.updatePlaylist(db, playlistId, {
    comment: `navilist:navilist ${JSON.stringify(rules)}`
  });

  logger.info('playlists', `smart playlist created: "${name.trim()}" (${trackIds.length} tracks)`);
  res.json({ ok: true, playlistId, count: trackIds.length });
});

// POST /playlists/create — create new playlist
router.post('/create', async (req, res) => {
  const { name, trackIds } = req.body;
  if (!name?.trim()) return res.json({ ok: false, error: 'Name is required' });

  const ids = trackIds ? (Array.isArray(trackIds) ? trackIds : [trackIds]) : [];
  const result = await navidrome.createPlaylist(db, name.trim(), ids);
  logger.info('playlists', `create: ${name} (${ids.length} tracks)`);
  res.json(result);
});

// POST /playlists/:id/rename — rename playlist
router.post('/:id/rename', async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.json({ ok: false, error: 'Name is required' });
  const result = await navidrome.updatePlaylist(db, req.params.id, { name: name.trim() });
  res.json(result);
});

// POST /playlists/:id/tracks/add — add tracks
router.post('/:id/tracks/add', async (req, res) => {
  const { trackIds } = req.body;
  if (!trackIds) return res.json({ ok: false, error: 'trackIds required' });
  const ids = Array.isArray(trackIds) ? trackIds : [trackIds];
  const result = await navidrome.addTracksToPlaylist(db, req.params.id, ids);
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

  const saved = await navidrome.updatePlaylist(db, req.params.id, {
    comment: `navilist:navilist ${JSON.stringify(rules)}`
  });
  if (!saved.ok) return res.json(saved);

  const trackIds = await engine.generatePlaylist(db, rules);
  if (!trackIds.length) return res.json({ ok: false, error: 'No tracks matched rules' });

  const result = await navidrome.replacePlaylistTracks(db, req.params.id, trackIds);
  if (!result.ok) return res.json(result);

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

// POST /playlists/:id/delete — delete playlist
router.post('/:id/delete', async (req, res) => {
  const result = await navidrome.deletePlaylist(db, req.params.id);
  logger.info('playlists', `deleted ${req.params.id}`);
  // Clear navidrome_id and enabled on any LB playlist that pointed to this
  db.prepare('UPDATE lb_playlists SET navidrome_id = NULL, enabled = 0 WHERE navidrome_id = ?').run(req.params.id);
  res.json(result);
});

module.exports = router;
