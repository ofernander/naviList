const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../db/index');
const navidrome = require('../providers/navidrome');
const lidarr    = require('../providers/lidarr');
const logger = require('../utils/logger');

router.post('/test-navidrome', async (req, res) => {
  const { navidrome_url, navidrome_user, navidrome_password } = req.body;
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    upsert.run('navidrome_url',      navidrome_url      || '');
    upsert.run('navidrome_user',     navidrome_user     || '');
    upsert.run('navidrome_password', navidrome_password || '');
  })();
  const result = await navidrome.ping(db);
  logger.info('settings', `navidrome test → ${result.ok ? 'ok' : result.error}`);
  res.json(result);
});

router.get('/music-folders', async (req, res) => {
  try {
    const folders = await navidrome.getMusicFolders(db);
    res.json({ ok: true, folders });
  } catch (e) {
    res.json({ ok: false, error: e.message, folders: [] });
  }
});

router.post('/test-lidarr', async (req, res) => {
  const { lidarr_url, lidarr_api_key } = req.body;
  const result = await lidarr.ping({ lidarr_url, lidarr_api_key });
  logger.info('settings', `lidarr test → ${result.ok ? 'ok' : result.error}`);
  res.json(result);
});

router.get('/lidarr-profiles', async (req, res) => {
  try {
    const settings = {};
    db.prepare('SELECT key, value FROM settings').all()
      .forEach(r => { settings[r.key] = r.value; });
    const profiles = await lidarr.getAllProfiles(settings);
    res.json({ ok: true, ...profiles });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /settings/api — return saved settings as JSON
router.get('/api', (req, res) => {
  const settings = {};
  db.prepare('SELECT key, value FROM settings').all()
    .forEach(r => { settings[r.key] = r.value; });
  res.json({ ok: true, settings });
});

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'settings.html'));
});

router.post('/', (req, res) => {
  const fields = [
    'navidrome_url', 'navidrome_user', 'navidrome_password',
    'music_folder_ids',
    'lastfm_api_key', 'lastfm_username',
    'listenbrainz_token', 'listenbrainz_username',
    'lidarr_url', 'lidarr_api_key', 'lidarr_root_folder',
    'lidarr_quality_profile_id', 'lidarr_metadata_profile_id',
    'deezer_artist_images'
  ];

  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const upsertMany = db.transaction((data) => {
    for (const [k, v] of Object.entries(data)) upsert.run(k, v);
  });

  // Handle music_folder_ids as array from checkboxes
  const body = { ...req.body };
  if (Array.isArray(body.music_folder_ids)) {
    body.music_folder_ids = body.music_folder_ids.join(',');
  } else if (!body.music_folder_ids) {
    body.music_folder_ids = '';
  }

  const data = {};
  fields.forEach(f => { if (body[f] !== undefined) data[f] = body[f]; });
  upsertMany(data);

  logger.info('settings', 'credentials saved');
  res.redirect('/settings');
});

module.exports = router;
