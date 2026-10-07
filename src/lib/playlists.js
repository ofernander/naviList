const express = require('express');
const router = express.Router();
const path = require('path');
const fs   = require('fs');
const db = require('../db/index');
const navidrome = require('../providers/navidrome');
const engine    = require('./pl_engine');
const logger = require('../utils/logger');
const { writeMissingArtists } = require('./sync/helpers');
const { publishPlaylist }                   = require('./publish');
const { buildMatcher, FUZZY_MIN_SCORE }     = require('./match');
const { setRefreshSchedule, cronProblem, cancelPlaylistRefresh, refreshPlaylist } = require('./refresh');
const { TYPES, parseComment, normalizeRules, currentTypeConfig } = require('./playlist_types');
const { getSettings }                       = require('../db/settings');

// type/config for a playlist: registry first, else the Navidrome comment.
function playlistTypeConfig(id, fallbackComment) {
  const row = db.prepare('SELECT type, config, comment FROM navilist_playlists WHERE navidrome_id = ?').get(id);
  if (row?.type) {
    let config = null;
    try { config = row.config ? JSON.parse(row.config) : null; } catch (e) {}
    return currentTypeConfig(row.type, config);
  }
  const parsed = parseComment(row?.comment || fallbackComment);
  return currentTypeConfig(parsed.type, parsed.config);
}

// Merge a subscription's cached source tracks with what's in Navidrome, so the
// detail view also lists the source tracks that aren't in the library. The
// playlist was built from the matched rows in order, so matched rows take the
// Navidrome tracks in sequence — source titles can differ from library titles
// (normalized / MBID / alias matches), so they're not paired by text.
function mergeCachedTracks(playlist, cached) {
  const ndTracks = Array.isArray(playlist.entry) ? playlist.entry : (playlist.entry ? [playlist.entry] : []);
  let next = 0;
  return cached.map(c => {
    if (c.matched && next < ndTracks.length) return ndTracks[next++];
    return { title: c.title, artist: c.artist, duration: 0, missing: true };
  });
}

// Post-save MB studio refinement — runs detached so preview/save stay fast, then
// swaps any wrong duplicate picks in the saved playlist and warms the cache.
function scheduleStudioRefine(playlistId, trackIds, comment) {
  runDetached(`studio-refine-${playlistId}`, async () => {
    const refined = await refineStudioPicks(db, trackIds);
    if (refined.length && refined.some((id, i) => id !== trackIds[i])) {
      await navidrome.replacePlaylistTracks(db, playlistId, refined);
      snapshotPlaylist(db, playlistId, null, comment, refined, null);
      logger.info('playlists', `studio-refine: ${playlistId} updated after MB tie-break`);
    }
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'playlists.html'));
});

// GET /playlists/api/list — Navidrome playlists + NSP files
router.get('/api/list', async (req, res) => {
  const active   = await navidrome.getPlaylists(db);
  const createdAt = {};
  db.prepare('SELECT navidrome_id, created_at FROM navilist_playlists').all()
    .forEach(r => { createdAt[r.navidrome_id] = r.created_at; });
  // Playlists not in the registry (manual) fall back to Navidrome's created date.
  const ndCreated = p => (p.created ? Math.floor(Date.parse(p.created) / 1000) || null : null);
  const lbCache  = db.prepare('SELECT lb_mbid, source_patch, title FROM lb_playlist_cache').all();
  const lbByMbid = new Map(lbCache.map(r => [r.lb_mbid, r]));

  // type/config from the registry (comment fallback) — the UI never parses comments.
  function enrichPlaylist(p) {
    const { type, config } = p.nsp_slug ? { type: 'nsp', config: null } : playlistTypeConfig(p.id, p.comment);
    const out = { ...p, type, config };
    if (type === TYPES.LB && config?.mbid) {
      const row = lbByMbid.get(config.mbid);
      if (row) return { ...out, lb_source_patch: row.source_patch, lb_title: row.title };
    }
    return out;
  }

  // NSP files from filesystem
  const { listNspFiles, getNspPath } = require('./nsp');
  const nspPath  = getNspPath();
  const nspFiles = listNspFiles(nspPath || '');
  const nspByName = new Map(nspFiles.map(f => [f.name.toLowerCase(), f]));
  const ndNames   = new Set(active.map(p => p.name?.toLowerCase()));

  // Tag ND playlists that match a .nsp file
  const taggedActive = active.map(p => {
    const nspEntry = nspByName.get(p.name?.toLowerCase());
    if (nspEntry) return { ...p, comment: 'navilist:nsp', nsp_slug: nspEntry.slug, nsp_config: nspEntry.config };
    return p;
  });

  // Only show filesystem stubs for NSP files not yet picked up by ND
  const nspPlaylists = nspFiles
    .filter(f => !ndNames.has(f.name?.toLowerCase()))
    .map(f => ({
      id: `nsp:${f.slug}`, name: f.name, comment: 'navilist:nsp',
      active: 1, songCount: null, duration: null, created_at: null,
      nsp_slug: f.slug, nsp_config: f.config,
    }));

  const playlists = [
    ...taggedActive.map(p => enrichPlaylist({ ...p, active: 1, created_at: createdAt[p.id] || ndCreated(p) })),
    ...nspPlaylists.map(p => ({ ...p, type: 'nsp' })),
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

// GET /playlists/api/albums — distinct album list for autocomplete
router.get('/api/albums', (req, res) => {
  const albums = db.prepare(`
    SELECT DISTINCT album FROM tracks
    WHERE album IS NOT NULL AND album != ''
    ORDER BY album ASC
  `).all().map(r => r.album);
  res.json({ ok: true, albums });
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

// GET /playlists/api/server-time — the clock refresh schedules run on (cron uses
// the server's timezone), so the builder can say when "06:00" is.
router.get('/api/server-time', (req, res) => {
  res.json({ ok: true, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, offsetMin: -new Date().getTimezoneOffset() });
});

// GET /playlists/api/:id/rules — a rules playlist's config in the current (v2)
// shape, for the rule builder: registry first, else the Navidrome comment.
// refresh_cron is its auto-refresh schedule (null = none).
router.get('/api/:id/rules', (req, res) => {
  const { type, config } = playlistTypeConfig(req.params.id, null);
  if (type !== TYPES.NAVILIST || !config) return res.json({ ok: false, error: 'Not a rules playlist' });
  const refresh_cron = db.prepare('SELECT refresh_cron FROM navilist_playlists WHERE navidrome_id = ?').get(req.params.id)?.refresh_cron || null;
  res.json({ ok: true, rules: config, refresh_cron });
});

// GET /playlists/api/:id — JSON detail
router.get('/api/:id', async (req, res) => {
  const { id } = req.params;

  const playlist = await navidrome.getPlaylist(db, id);
  if (!playlist) return res.json({ ok: false, error: 'Not found' });

  // For LB/LFM playlists, merge in missing tracks from cache
  const { type, config } = playlistTypeConfig(id, playlist.comment);
  let cached = [];
  if ((type === TYPES.LB || type === TYPES.LB_SNAPSHOT) && config?.mbid)
    cached = db.prepare('SELECT * FROM lb_playlist_tracks WHERE lb_mbid = ? ORDER BY position').all(config.mbid);
  if ((type === TYPES.LASTFM || type === TYPES.LASTFM_SNAPSHOT) && config?.lfm_id)
    cached = db.prepare('SELECT * FROM lfm_playlist_tracks WHERE lfm_id = ? ORDER BY position').all(config.lfm_id);
  if (cached.length) return res.json({ ok: true, playlist: { ...playlist, entry: mergeCachedTracks(playlist, cached) } });

  res.json({ ok: true, playlist });
});

// POST /playlists/preview-navilist — resolve tracks from rules, no ND writes
router.post('/preview-navilist', async (req, res) => {
  const { rules } = req.body;
  if (!rules) return res.json({ ok: false, error: 'rules required' });

  const validation = engine.validateRules(rules);
  if (!validation.ok) return res.json({ ok: false, errors: validation.errors });

  const trackIds = await engine.generatePlaylist(db, rules);
  if (!trackIds.length) return res.json({ ok: false, error: 'No tracks matched these rules' });

  const getTrack = db.prepare('SELECT id, title, artist, duration FROM tracks WHERE id = ?');
  const tracks   = trackIds.map(id => getTrack.get(id) || { id, title: '—', artist: '—', duration: 0 });

  res.json({ ok: true, tracks, count: tracks.length });
});

// POST /playlists/save-navilist — create in ND from previewed track list
router.post('/save-navilist', async (req, res) => {
  const { name, trackIds, refresh_cron } = req.body;
  const rules = normalizeRules(req.body.rules);   // store rules in the current shape
  if (!name?.trim())     return res.json({ ok: false, error: 'name required' });
  if (!rules)            return res.json({ ok: false, error: 'rules required' });
  if (!trackIds?.length) return res.json({ ok: false, error: 'trackIds required' });
  const validation = engine.validateRules(rules);
  if (!validation.ok) return res.json({ ok: false, error: validation.errors.join(' ') });
  const badCron = cronProblem(refresh_cron);
  if (badCron) return res.json({ ok: false, error: badCron });

  const published = await publishPlaylist(db, { name: name.trim(), type: TYPES.NAVILIST, config: rules, trackIds });
  if (!published.ok) return res.json(published);
  const { playlistId } = published;
  setRefreshSchedule(playlistId, refresh_cron, 'save-navilist');

  logger.info('playlists', `navilist playlist saved: "${name.trim()}" (${trackIds.length} tracks)`);
  res.json({ ok: true, playlistId, count: trackIds.length });
});

// POST /playlists/create — create new playlist
router.post('/create', async (req, res) => {
  const { name, trackIds } = req.body;
  if (!name?.trim()) return res.json({ ok: false, error: 'Name is required' });

  const ids = trackIds ? (Array.isArray(trackIds) ? trackIds : [trackIds]) : [];
  // Manual playlists are untyped: hand-picked, no studio tie-break.
  const result = await publishPlaylist(db, { name: name.trim(), trackIds: ids });
  if (!result.ok) return res.json(result);
  logger.info('playlists', `create: ${name} (${ids.length} tracks)`);
  res.json({ ok: true, playlist: { id: result.playlistId } });
});

// POST /playlists/:id/rename — rename playlist
router.post('/:id/rename', async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.json({ ok: false, error: 'Name is required' });

  const result = await navidrome.updatePlaylist(db, req.params.id, { name: name.trim() });
  if (!result.ok) return res.json(result);
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
  const rules = normalizeRules(req.body.rules);   // store rules in the current shape
  if (!rules) return res.json({ ok: false, error: 'rules required' });

  const validation = engine.validateRules(rules);
  if (!validation.ok) return res.json({ ok: false, errors: validation.errors });
  // refresh_cron: absent = leave the schedule alone; empty = clear it.
  const setCron  = req.body.refresh_cron !== undefined;
  const badCron  = setCron && cronProblem(req.body.refresh_cron);
  if (badCron) return res.json({ ok: false, error: badCron });

  // trackIds: the previewed list the builder saves (edits made in the preview kept);
  // absent = generate from the rules. name: rename along with the save.
  const { name, trackIds: given } = req.body;
  const trackIds = Array.isArray(given) && given.length ? given : await engine.generatePlaylist(db, rules);
  if (!trackIds.length) return res.json({ ok: false, error: 'No tracks matched rules' });

  const result = await publishPlaylist(db, { id: req.params.id, name: name?.trim() || null, type: TYPES.NAVILIST, config: rules, trackIds });
  if (!result.ok) return res.json(result);
  if (setCron) setRefreshSchedule(req.params.id, req.body.refresh_cron, 'edit-rules');

  logger.info('playlists', `rules saved + regenerated ${req.params.id}: ${trackIds.length} tracks`);
  res.json({ ok: true, count: trackIds.length });
});

// POST /playlists/:id/regenerate — rebuild a rules playlist from its stored config
router.post('/:id/regenerate', async (req, res) => {
  const row = db.prepare('SELECT * FROM navilist_playlists WHERE navidrome_id = ?').get(req.params.id);
  if (!row)        return res.json({ ok: false, error: 'Playlist not found in registry' });
  res.json(await refreshPlaylist(row, 'regenerate'));
});

// POST /playlists/preview-blocks — per-block track counts for the rule builder
// (no combining, no ND writes)
router.post('/preview-blocks', async (req, res) => {
  const result = await engine.previewRules(db, req.body.rules);
  res.json(result);
});

// POST /playlists/:id/purge — remove from local DB only, no ND call (for stale NSP rows etc)
router.post('/:id/purge', (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM navilist_playlist_tracks WHERE playlist_id = ?').run(req.params.id);
    db.prepare('DELETE FROM navilist_playlists WHERE navidrome_id = ?').run(req.params.id);
  })();
  res.json({ ok: true });
});

// POST /playlists/:id/delete — delete from NL and ND
router.post('/:id/delete', async (req, res) => {
  const { id } = req.params;

  const result = await navidrome.deletePlaylist(db, id);
  if (!result.ok) return res.json(result);

  db.transaction(() => {
    db.prepare('DELETE FROM navilist_playlist_tracks WHERE playlist_id = ?').run(id);
    db.prepare('DELETE FROM navilist_playlists WHERE navidrome_id = ?').run(id);
    // Deleting a subscription's playlist ends the subscription.
    db.prepare('DELETE FROM lb_subscriptions WHERE navidrome_id = ?').run(id);
    db.prepare('UPDATE lfm_playlists SET enabled = 0, navidrome_id = NULL WHERE navidrome_id = ?').run(id);
  })();

  cancelPlaylistRefresh(id);

  logger.info('playlists', `deleted ${id}`);
  res.json({ ok: true });
});

// GET /playlists/:id/export?format=m3u|xspf|csv|json
router.get('/:id/export', async (req, res) => {
  const { id } = req.params;
  const format  = (req.query.format || 'm3u').toLowerCase();

  const playlist = await navidrome.getPlaylist(db, id);
  if (!playlist) return res.status(404).json({ ok: false, error: 'Not found' });
  const name   = playlist.name;
  const tracks = Array.isArray(playlist.entry) ? playlist.entry : (playlist.entry ? [playlist.entry] : []);

  const safeName = (name || 'playlist').replace(/[^\w\s\-\u2013\u2014]/g, '').trim().replace(/\s+/g, '_');

  if (format === 'm3u') {
    const lines = ['#EXTM3U'];
    tracks.forEach(t => {
      lines.push(`#EXTINF:${t.duration || -1},${t.artist || ''} - ${t.title || ''}`);
      lines.push(`${t.artist || ''} - ${t.title || ''}`);
    });
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.m3u"`);
    return res.send(lines.join('\n'));
  }

  if (format === 'xspf') {
    const xmlTracks = tracks.map(t =>
      `    <track>\n      <title>${escXml(t.title)}</title>\n      <creator>${escXml(t.artist)}</creator>\n      <duration>${(t.duration || 0) * 1000}</duration>\n    </track>`
    ).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<playlist version="1" xmlns="http://xspf.org/ns/0/">\n  <title>${escXml(name)}</title>\n  <trackList>\n${xmlTracks}\n  </trackList>\n</playlist>`;
    res.setHeader('Content-Type', 'application/xspf+xml');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.xspf"`);
    return res.send(xml);
  }

  if (format === 'csv') {
    const rows = ['position,title,artist,duration'];
    tracks.forEach((t, i) => rows.push(`${i + 1},"${csvEsc(t.title)}","${csvEsc(t.artist)}",${t.duration || 0}`));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
    return res.send(rows.join('\n'));
  }

  if (format === 'json') {
    const payload = {
      name,
      exported_at: new Date().toISOString(),
      tracks: tracks.map((t, i) => ({ position: i + 1, title: t.title, artist: t.artist, duration: t.duration || 0 }))
    };
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.json"`);
    return res.json(payload);
  }

  res.status(400).json({ ok: false, error: `Unknown format: ${format}` });
});

// POST /playlists/import-playlist — match normalised rows against local library
router.post('/import-playlist', async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length) return res.json({ ok: false, error: 'rows required' });

  // Fast match path: cached is_live + heuristic, NO MB fetch, so the import preview
  // stays snappy on large files. The studio tie-break runs post-save via
  // publishPlaylist (fuzzy picks the song → MB picks the studio copy in the background).
  const matcher  = buildMatcher(db);
  const getTrack = db.prepare('SELECT id, title, artist, duration FROM tracks WHERE id = ?');
  // User-configurable fuzzy floor (0-100, default 80).
  const fuzzyMin = Math.max(0, Math.min(100,
    parseInt(getSettings(db).fuzzy_match_threshold, 10) || FUZZY_MIN_SCORE));

  const results = [];
  let nMatched = 0, nFuzzy = 0, nUnmatched = 0;

  for (const row of rows) {
    const title  = (row.trackName  || '').trim();
    const artist = (row.artistName || '').split(',')[0].trim();
    if (!title || !artist) { results.push({ title, artist, status: 'unmatched' }); nUnmatched++; continue; }

    const m = matcher.review({ artist, title }, fuzzyMin);
    if (m.status === 'matched' || m.status === 'normalized') {
      results.push({ title, artist, status: m.status, track: getTrack.get(m.id) });
      nMatched++;
    } else if (m.status === 'fuzzy') {
      results.push({ title, artist, status: 'fuzzy', candidates: m.candidates.map(c => ({ ...getTrack.get(c.id), score: c.score })) });
      nFuzzy++;
    } else {
      results.push({ title, artist, status: 'unmatched' });
      nUnmatched++;
    }
  }

  logger.info('playlists', `import: ${nMatched} matched, ${nFuzzy} to review, ${nUnmatched} unmatched`);
  res.json({ ok: true, results, counts: { matched: nMatched, fuzzy: nFuzzy, unmatched: nUnmatched } });
});

// POST /playlists/save-import — create ND playlist, write missing artists
router.post('/save-import', async (req, res) => {
  const { name, trackIds, unmatched, format, decisions } = req.body;
  if (!name?.trim()) return res.json({ ok: false, error: 'name required' });

  // The review flow sends `decisions` (one per row: chosen trackId or unmatched);
  // fall back to raw trackIds/unmatched for the plain flow.
  let finalTrackIds  = Array.isArray(trackIds) ? trackIds.slice() : [];
  let finalUnmatched = Array.isArray(unmatched) ? unmatched.slice() : [];
  if (Array.isArray(decisions) && decisions.length) {
    finalTrackIds  = decisions.map(d => d.trackId).filter(Boolean);
    finalUnmatched = decisions
      .filter(d => !d.trackId && (d.title || d.artist))
      .map(d => ({ title: d.title || '', artist: d.artist || '' }));
  }
  if (!finalTrackIds.length) return res.json({ ok: false, error: 'trackIds required' });

  // fuzzy picked the song; the publish-time studio tie-break picks the copy
  const published = await publishPlaylist(db, { name: name.trim(), type: TYPES.IMPORT, trackIds: finalTrackIds });
  if (!published.ok) return res.json(published);
  const { playlistId } = published;

  // Write unmatched artists to missing_artists — same pipeline as LB/LFM
  if (finalUnmatched.length) {
    const artists = [...new Set(finalUnmatched.map(t => t.artist).filter(Boolean))];
    if (artists.length) writeMissingArtists(db, artists, format || 'import');
  }

  logger.info('playlists', `import playlist saved: "${name.trim()}" (${finalTrackIds.length} tracks) [${format || 'unknown'}]`);
  res.json({ ok: true, playlistId, count: finalTrackIds.length });
});

function escXml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function csvEsc(str) {
  return (str || '').replace(/"/g, '""');
}

module.exports = router;
