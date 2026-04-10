const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const logger = require('../utils/logger');

const PAGE_SIZE = 500;

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  return s;
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function buildParams(settings, extra = {}) {
  const salt = crypto.randomBytes(8).toString('hex');
  const token = md5(settings.navidrome_password + salt);
  const params = new URLSearchParams({
    u: settings.navidrome_user,
    t: token,
    s: salt,
    v: '1.16.1',
    c: 'navilist',
    f: 'json',
    ...extra
  });
  return params.toString();
}

async function request(db, action, extra = {}) {
  const settings = getSettings(db);
  const base = settings.navidrome_url?.replace(/\/$/, '');
  const qs = buildParams(settings, { ...extra });
  const url = `${base}/rest/${action}?${qs}`;
  logger.debug('navidrome', `request: ${action} ${JSON.stringify(extra)}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res  = await fetch(url, { signal: controller.signal });
    const json = await res.json();
    return json['subsonic-response'];
  } finally {
    clearTimeout(timer);
  }
}

async function ping(db) {
  try {
    const res = await request(db, 'ping');
    const ok = res?.status === 'ok';
    logger.info('navidrome', `ping → ${res?.status}`);
    if (ok) return { ok: true };
    return { ok: false, error: res?.error?.message || 'Auth failed' };
  } catch (e) {
    logger.error('navidrome', `ping failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function getMusicFolders(db) {
  try {
    const res = await request(db, 'getMusicFolders');
    return res?.musicFolders?.musicFolder || [];
  } catch (e) {
    logger.error('navidrome', `getMusicFolders failed: ${e.message}`);
    return [];
  }
}

// ── Playlist functions ────────────────────────────────────────────────────────

async function getPlaylists(db) {
  try {
    const res = await request(db, 'getPlaylists');
    const raw = res?.playlists?.playlist;
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
  } catch (e) {
    logger.error('navidrome', `getPlaylists failed: ${e.message}`);
    return [];
  }
}

async function getPlaylist(db, id) {
  try {
    const res = await request(db, 'getPlaylist', { id });
    return res?.playlist || null;
  } catch (e) {
    logger.error('navidrome', `getPlaylist(${id}) failed: ${e.message}`);
    return null;
  }
}

async function createPlaylist(db, name, trackIds = []) {
  try {
    // Subsonic accepts multiple songId params — build manually
    const settings = getSettings(db);
    const base = settings.navidrome_url?.replace(/\/$/, '');
    const salt = crypto.randomBytes(8).toString('hex');
    const token = md5(settings.navidrome_password + salt);

    const params = new URLSearchParams({
      u: settings.navidrome_user,
      t: token,
      s: salt,
      v: '1.16.1',
      c: 'navilist',
      f: 'json',
      name
    });
    trackIds.forEach(id => params.append('songId', id));

    const url = `${base}/rest/createPlaylist?${params.toString()}`;
    const res = await fetch(url);
    const json = await res.json();
    const sub = json['subsonic-response'];

    if (sub?.status !== 'ok') throw new Error(sub?.error?.message || 'Create failed');
    logger.info('navidrome', `playlist created: ${name}`);
    return { ok: true, playlist: sub.playlist };
  } catch (e) {
    logger.error('navidrome', `createPlaylist failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function updatePlaylist(db, id, { name, comment } = {}) {
  try {
    const extra = { playlistId: id };
    if (name    !== undefined) extra.name    = name;
    if (comment !== undefined) extra.comment = comment;
    const res = await request(db, 'updatePlaylist', extra);
    if (res?.status !== 'ok') throw new Error(res?.error?.message || 'Update failed');
    logger.info('navidrome', `playlist ${id} updated`);
    return { ok: true };
  } catch (e) {
    logger.error('navidrome', `updatePlaylist(${id}) failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function addTracksToPlaylist(db, id, trackIds = []) {
  try {
    const settings = getSettings(db);
    const base = settings.navidrome_url?.replace(/\/$/, '');
    const salt = crypto.randomBytes(8).toString('hex');
    const token = md5(settings.navidrome_password + salt);

    const params = new URLSearchParams({
      u: settings.navidrome_user,
      t: token,
      s: salt,
      v: '1.16.1',
      c: 'navilist',
      f: 'json',
      playlistId: id
    });
    trackIds.forEach(tid => params.append('songIdToAdd', tid));

    const url = `${base}/rest/updatePlaylist?${params.toString()}`;
    const res = await fetch(url);
    const json = await res.json();
    const sub = json['subsonic-response'];

    if (sub?.status !== 'ok') throw new Error(sub?.error?.message || 'Add tracks failed');
    logger.info('navidrome', `added ${trackIds.length} tracks to playlist ${id}`);
    return { ok: true };
  } catch (e) {
    logger.error('navidrome', `addTracksToPlaylist(${id}) failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function replacePlaylistTracks(db, id, trackIds = []) {
  try {
    const settings = getSettings(db);
    const base = settings.navidrome_url?.replace(/\/$/, '');
    const salt = crypto.randomBytes(8).toString('hex');
    const token = md5(settings.navidrome_password + salt);

    const params = new URLSearchParams({
      u: settings.navidrome_user,
      t: token, s: salt, v: '1.16.1', c: 'navilist', f: 'json',
      playlistId: id
    });
    trackIds.forEach(tid => params.append('songId', tid));

    const url = `${base}/rest/createPlaylist?${params.toString()}`;
    const res = await fetch(url);
    const json = await res.json();
    const sub = json['subsonic-response'];

    if (sub?.status !== 'ok') throw new Error(sub?.error?.message || 'Replace failed');
    logger.info('navidrome', `replaced tracks on playlist ${id} (${trackIds.length} tracks)`);
    return { ok: true, count: trackIds.length };
  } catch (e) {
    logger.error('navidrome', `replacePlaylistTracks(${id}) failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function removeTracksFromPlaylist(db, id, indexes = []) {
  try {
    const settings = getSettings(db);
    const base = settings.navidrome_url?.replace(/\/$/, '');
    const salt = crypto.randomBytes(8).toString('hex');
    const token = md5(settings.navidrome_password + salt);

    const params = new URLSearchParams({
      u: settings.navidrome_user,
      t: token,
      s: salt,
      v: '1.16.1',
      c: 'navilist',
      f: 'json',
      playlistId: id
    });
    indexes.forEach(i => params.append('songIndexToRemove', i));

    const url = `${base}/rest/updatePlaylist?${params.toString()}`;
    const res = await fetch(url);
    const json = await res.json();
    const sub = json['subsonic-response'];

    if (sub?.status !== 'ok') throw new Error(sub?.error?.message || 'Remove tracks failed');
    logger.info('navidrome', `removed ${indexes.length} tracks from playlist ${id}`);
    return { ok: true };
  } catch (e) {
    logger.error('navidrome', `removeTracksFromPlaylist(${id}) failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function deletePlaylist(db, id) {
  try {
    const res = await request(db, 'deletePlaylist', { id });
    if (res?.status !== 'ok') throw new Error(res?.error?.message || 'Delete failed');
    logger.info('navidrome', `playlist ${id} deleted`);
    return { ok: true };
  } catch (e) {
    logger.error('navidrome', `deletePlaylist(${id}) failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ── Local playlist registry sync ──────────────────────────────────────────────

async function syncPlaylistsToLocal(db) {
  const playlists = await getPlaylists(db);
  if (!playlists.length) return { ok: true, synced: 0 };

  const now = Math.floor(Date.now() / 1000);
  const upsertPl = db.prepare(`
    INSERT INTO navilist_playlists (navidrome_id, name, comment, active, track_count, duration, created_at)
    VALUES (@navidrome_id, @name, @comment, 1, @track_count, @duration, @created_at)
    ON CONFLICT(navidrome_id) DO UPDATE SET
      name        = excluded.name,
      comment     = excluded.comment,
      track_count = excluded.track_count,
      duration    = excluded.duration,
      active      = 1
  `);
  const deleteTracks = db.prepare('DELETE FROM navilist_playlist_tracks WHERE playlist_id = ?');
  const insertTrack  = db.prepare(`
    INSERT OR IGNORE INTO navilist_playlist_tracks (playlist_id, track_id, position)
    VALUES (?, ?, ?)
  `);

  let synced = 0;
  for (const p of playlists) {
    const detail = await getPlaylist(db, p.id);
    if (!detail) continue;
    const tracks = Array.isArray(detail.entry) ? detail.entry : (detail.entry ? [detail.entry] : []);

    db.transaction(() => {
      upsertPl.run({
        navidrome_id: p.id,
        name:         p.name,
        comment:      p.comment || null,
        track_count:  tracks.length,
        duration:     p.duration || null,
        created_at:   now
      });
      deleteTracks.run(p.id);
      tracks.forEach((t, i) => insertTrack.run(p.id, t.id, i));
    })();
    synced++;
    logger.debug('navidrome', `synced playlist "${p.name}" to local (${tracks.length} tracks)`);
  }

  logger.info('navidrome', `playlist sync: ${synced} playlists stored locally`);
  return { ok: true, synced };
}

// ── Library sync ──────────────────────────────────────────────────────────────

async function syncFolderPage(db, folderId, offset, upsertMany, seenIds, syncedAt) {
  const extra = {
    query: '""',
    songCount: PAGE_SIZE,
    songOffset: offset,
    albumCount: 0,
    artistCount: 0
  };

  if (folderId !== null) extra.musicFolderId = folderId;

  const res = await request(db, 'search3', extra);
  if (res?.status !== 'ok') throw new Error(res?.error?.message || 'Search request failed');

  const songs = res?.searchResult3?.song || [];

  if (songs.length > 0) {
    songs.forEach(s => seenIds.add(s.id));
    upsertMany(songs.map(s => ({
      id:         s.id,
      title:      s.title,
      artist:     s.artist      ?? null,
      artistId:   s.artistId    ?? null,
      album:      s.album       ?? null,
      albumId:    s.albumId     ?? null,
      duration:   s.duration    ?? null,
      year:       s.year        ?? null,
      genre:      s.genre       ?? null,
      playCount:  s.playCount   ?? 0,
      starred:    s.starred     ? 1 : 0,
      userRating: s.userRating  ?? null,
      bitRate:    s.bitRate     ?? null,
      syncedAt
    })));
  }

  return songs.length;
}

async function syncLibrary(db) {
  const deezer = require('./deezer'); // inline to avoid circular dep at module load
  const IMAGE_DIR = '/app/data/artist-images';
  fs.mkdirSync(IMAGE_DIR, { recursive: true });

  let total = 0;
  let inserted = 0;
  let updated = 0;
  let removed = 0;
  const seenIds      = new Set();
  const newArtistIds = new Map(); // artistId → artistName, only for artists not yet imaged
  const syncedAt     = Math.floor(Date.now() / 1000);

  const settings = getSettings(db);
  const folderIds = settings.music_folder_ids
    ? settings.music_folder_ids.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const targets = folderIds.length > 0 ? folderIds : [null];
  logger.info('navidrome', `library sync started — folders: ${folderIds.length > 0 ? folderIds.join(', ') : 'all'}`);

  const upsert = db.prepare(`
    INSERT INTO tracks (id, title, artist, artist_id, album, album_id,
      duration, year, genre, play_count, starred, user_rating, bit_rate, synced_at)
    VALUES (@id, @title, @artist, @artistId, @album, @albumId,
      @duration, @year, @genre, @playCount, @starred, @userRating, @bitRate, @syncedAt)
    ON CONFLICT(id) DO UPDATE SET
      title       = excluded.title,
      artist      = excluded.artist,
      artist_id   = excluded.artist_id,
      album       = excluded.album,
      album_id    = excluded.album_id,
      duration    = excluded.duration,
      year        = excluded.year,
      genre       = excluded.genre,
      play_count  = excluded.play_count,
      starred     = excluded.starred,
      user_rating = excluded.user_rating,
      bit_rate    = excluded.bit_rate,
      synced_at   = excluded.synced_at
  `);

  const checkExisting = db.prepare('SELECT id FROM tracks WHERE id = ?');

  const upsertMany = db.transaction((tracks) => {
    for (const t of tracks) {
      const existing = checkExisting.get(t.id);
      upsert.run({ ...t, syncedAt });
      existing ? updated++ : inserted++;
      if (t.artistId && t.artist && !newArtistIds.has(t.artistId)) {
        const imgPath = path.join(IMAGE_DIR, `${t.artistId}.jpg`);
        if (!fs.existsSync(imgPath)) {
          newArtistIds.set(t.artistId, t.artist);
        }
      }
    }
  });

  try {
    for (const folderId of targets) {
      let offset = 0;
      if (folderId !== null) logger.info('navidrome', `syncing folder ${folderId}...`);
      while (true) {
        const count = await syncFolderPage(db, folderId, offset, upsertMany, seenIds, syncedAt);
        if (count === 0) break;
        total += count;
        offset += PAGE_SIZE;
        logger.info('navidrome', `synced ${total} tracks so far...`);
        logger.debug('navidrome', `folder ${folderId ?? 'all'} offset ${offset} — ${count} tracks this page`);
        if (count < PAGE_SIZE) break;
      }
    }
  } catch (e) {
    logger.error('navidrome', `sync failed: ${e.message}`);
    return { ok: false, error: e.message, total, inserted, updated, removed };
  }

  // ── Download artist images (gated on deezer_artist_images setting) ─────────
  const imagesEnabled = settings.deezer_artist_images === 'true';
  if (imagesEnabled && newArtistIds.size > 0) {
    logger.info('navidrome', `fetching images for ${newArtistIds.size} new artists...`);
    let imaged = 0;
    for (const [artistId, artistName] of newArtistIds) {
      const destPath = path.join(IMAGE_DIR, `${artistId}.jpg`);
      const ok = await deezer.downloadArtistImage(artistName, destPath);
      if (ok) imaged++;
    }
    logger.info('navidrome', `artist images: ${imaged}/${newArtistIds.size} saved`);
  } else if (!imagesEnabled) {
    logger.info('navidrome', 'artist image sync skipped (deezer_artist_images disabled)');
  }

  const deleteStale = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM tracks').all();
    const toDelete = existing.filter(r => !seenIds.has(r.id));
    const del = db.prepare('DELETE FROM tracks WHERE id = ?');
    for (const r of toDelete) { del.run(r.id); removed++; }
  });
  deleteStale();

  if (removed > 0) logger.info('navidrome', `removed ${removed} stale tracks`);
  logger.info('navidrome', `sync complete — ${total} tracks (${inserted} new, ${updated} updated, ${removed} removed)`);

  // ── Close the loop: check if any 'sent' missing artists are now in the library
  if (inserted > 0) {
    try {
      const sentArtists  = db.prepare(`SELECT * FROM missing_artists WHERE status = 'sent'`).all();
      const foundAt      = Math.floor(Date.now() / 1000);
      const markFound    = db.prepare(`UPDATE missing_artists SET status = 'found', found_at = ? WHERE id = ?`);
      const isInLibrary  = db.prepare('SELECT 1 FROM tracks WHERE LOWER(artist) = LOWER(?) LIMIT 1');
      let foundCount     = 0;

      for (const a of sentArtists) {
        if (isInLibrary.get(a.artist_name)) {
          markFound.run(foundAt, a.id);
          foundCount++;
          logger.info('navidrome', `missing artist resolved: "${a.artist_name}" is now in library`);
        }
      }

      if (foundCount > 0) {
        logger.info('navidrome', `${foundCount} missing artist(s) found — triggering smart playlist regeneration`);
        const engine   = require('../lib/pl_engine');
        const playlists = await getPlaylists(db);
        for (const p of playlists) {
          if (!p.comment?.startsWith('navilist:smart')) continue;
          try {
            const rules    = JSON.parse(p.comment.replace(/^navilist:smart\s*/, ''));
            const trackIds = await engine.generatePlaylist(db, rules);
            if (trackIds.length) await replacePlaylistTracks(db, p.id, trackIds);
            logger.info('navidrome', `regenerated smart playlist "${p.name}" (${trackIds.length} tracks)`);
          } catch (e) {
            logger.warn('navidrome', `failed to regenerate "${p.name}": ${e.message}`);
          }
        }
      }
    } catch (e) {
      logger.warn('navidrome', `close-the-loop check failed: ${e.message}`);
    }
  }

  await syncPlaylistsToLocal(db);

  return { ok: true, total, inserted, updated, removed };
}

module.exports = {
  request, ping, getMusicFolders,
  getPlaylists, getPlaylist, createPlaylist,
  updatePlaylist, addTracksToPlaylist, removeTracksFromPlaylist, deletePlaylist,
  replacePlaylistTracks, syncLibrary, syncPlaylistsToLocal
};
