const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../db/index');
const navidrome = require('../providers/navidrome');
const lidarr = require('../providers/lidarr');
const { getSyncState } = require('./sync');
const { getSettings } = require('../db/settings');

// GET /status/api — return full status data as JSON
router.get('/api', async (req, res) => {
  const ping        = await navidrome.ping(db);
  const settings    = getSettings(db);
  const lidarrPing  = (settings.lidarr_url && settings.lidarr_api_key)
    ? await lidarr.ping(settings)
    : { ok: false };
  const trackCount  = db.prepare('SELECT COUNT(*) as c FROM tracks').get().c;
  const albumCount  = db.prepare('SELECT COUNT(DISTINCT album_id) as c FROM tracks').get().c;
  const artistCount = db.prepare('SELECT COUNT(DISTINCT artist_id) as c FROM tracks').get().c;
  const genreCount  = db.prepare('SELECT COUNT(DISTINCT genre) as c FROM tracks WHERE genre IS NOT NULL').get().c;
  const lastSync    = db.prepare('SELECT MAX(synced_at) as s FROM tracks').get().s;
  const totalPlays  = db.prepare('SELECT COUNT(*) as c FROM play_history').get().c;
  const playsBySource = db.prepare(
    'SELECT source, COUNT(*) as c FROM play_history GROUP BY source'
  ).all();
  const sourceMap = {};
  playsBySource.forEach(r => { sourceMap[r.source] = r.c; });
  const syncState = getSyncState();

  // Service connection status
  const services = {
    lastfm:       { configured: !!(settings.lastfm_api_key && settings.lastfm_username), username: settings.lastfm_username || null },
    listenbrainz: { configured: !!(settings.listenbrainz_token && settings.listenbrainz_username), username: settings.listenbrainz_username || null },
    maloja:       { configured: !!(settings.maloja_url && settings.maloja_api_key), url: settings.maloja_url || null },
    lidarr:       { connected: lidarrPing.ok, url: settings.lidarr_url || null }
  };

  res.json({
    ok: true,
    ping,
    navidromeUrl: settings.navidrome_url || '',
    trackCount, albumCount, artistCount, genreCount,
    lastSync, totalPlays, sourceMap, syncState, services
  });
});

router.get('/api/counts', (req, res) => {
  const loved          = db.prepare("SELECT COUNT(*) as c FROM loved_tracks WHERE score = 1").get().c;
  const disliked       = db.prepare("SELECT COUNT(*) as c FROM loved_tracks WHERE score = -1").get().c;
  const topArtists     = db.prepare('SELECT COUNT(*) as c FROM user_top_artists').get().c;
  const topTracks      = db.prepare('SELECT COUNT(*) as c FROM user_top_tracks').get().c;
  const artistTagsLastfm = db.prepare("SELECT COUNT(DISTINCT artist_id) as c FROM artist_tags WHERE source = 'lastfm'").get().c;
  const similarArtists   = db.prepare("SELECT COUNT(DISTINCT artist_id) as c FROM artist_similar WHERE source = 'lastfm' AND similar_name != '__none__'").get().c;
  const missingPending = db.prepare("SELECT COUNT(*) as c FROM missing_artists WHERE status = 'pending'").get().c;
  const missingSent    = db.prepare("SELECT COUNT(*) as c FROM missing_artists WHERE status = 'sent'").get().c;
  const missingFound   = db.prepare("SELECT COUNT(*) as c FROM missing_artists WHERE status = 'found'").get().c;
  const missingIgnored = db.prepare("SELECT COUNT(*) as c FROM missing_artists WHERE status = 'ignored'").get().c;
  const lidarrAutoAdd  = db.prepare("SELECT value FROM settings WHERE key = 'lidarr_auto_add'").get()?.value === 'true';
  const lbPlaylists  = db.prepare('SELECT COUNT(*) as c FROM lb_playlist_cache').get().c;
  const lfmPlaylists = db.prepare('SELECT COUNT(*) as c FROM lfm_playlists').get().c;
  const malojaHistory = db.prepare("SELECT * FROM sync_state WHERE source = 'maloja'").get() || null;

  // Popularity (lib/popularity.js), per library artist: rated (a source listed it),
  // no data (fetched, no source had it), pending (has tracks not fetched yet).
  const pop = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(pending > 0)               AS pending,
           SUM(pending = 0 AND rated > 0)  AS rated,
           SUM(pending = 0 AND rated = 0)  AS none
    FROM (SELECT SUM(pop_source IS NULL) AS pending, SUM(pop_source IN ('lb', 'lastfm')) AS rated
          FROM tracks WHERE artist_id IS NOT NULL GROUP BY artist_id)
  `).get();
  const settings   = getSettings(db);
  const popularity = {
    total: pop.total || 0, rated: pop.rated || 0, none: pop.none || 0, pending: pop.pending || 0,
    listenbrainz: !!settings.listenbrainz_token, lastfm: !!settings.lastfm_api_key,
  };
  res.json({ ok: true, loved, disliked, topArtists, topTracks, artistTagsLastfm, similarArtists, missingPending, missingSent, missingFound, missingIgnored, lidarrAutoAdd, lbPlaylists, lfmPlaylists, malojaHistory, popularity });
});

router.get('/api/lidarr-recent', (req, res) => {
  const rows = db.prepare(`
    SELECT artist_name, source, mbid, sent_at
    FROM missing_artists
    WHERE status = 'sent' AND sent_at IS NOT NULL
    ORDER BY sent_at DESC
    LIMIT 10
  `).all();
  res.json({ ok: true, rows });
});

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'status.html'));
});

module.exports = router;
