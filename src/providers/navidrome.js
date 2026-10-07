const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const logger = require('../utils/logger');
const { getSettings } = require('../db/settings');
const { parseComment } = require('../lib/playlist_types');

const PAGE_SIZE = 500;

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

// Every artist Navidrome indexes: [{ id, name, musicBrainzId? }]. The MBID is an
// OpenSubsonic field. Which artists are listed (album artists only, or all)
// depends on the Navidrome version/config.
async function getArtists(db) {
  try {
    const res = await request(db, 'getArtists');
    const index = res?.artists?.index;
    const groups = Array.isArray(index) ? index : (index ? [index] : []);
    return groups.flatMap(g => Array.isArray(g.artist) ? g.artist : (g.artist ? [g.artist] : []));
  } catch (e) {
    logger.error('navidrome', `getArtists failed: ${e.message}`);
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

// ── Local playlist registry ───────────────────────────────────────────────────

// After a library sync: register naviList-tagged Navidrome playlists the registry
// doesn't know (e.g. after a DB reset — type/config come from the comment), and
// refresh name / track count of known ones. Never writes comment/type/config —
// publish.js owns those — and never fetches track lists.
async function adoptTaggedPlaylists(db) {
  const playlists = await getPlaylists(db);
  if (!playlists.length) return { ok: true, adopted: 0 };

  const now    = Math.floor(Date.now() / 1000);
  const known  = db.prepare('SELECT 1 FROM navilist_playlists WHERE navidrome_id = ?');
  const insert = db.prepare(`
    INSERT INTO navilist_playlists (navidrome_id, name, comment, type, config, active, track_count, duration, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `);
  const update = db.prepare('UPDATE navilist_playlists SET name = ?, track_count = ?, duration = ? WHERE navidrome_id = ?');

  let adopted = 0;
  db.transaction(() => {
    for (const p of playlists) {
      if (known.get(p.id)) {
        update.run(p.name, p.songCount ?? 0, p.duration || null, p.id);
        continue;
      }
      const { type, config } = parseComment(p.comment);
      if (!type) continue;   // manual playlist — not ours to register
      const created = p.created ? Math.floor(Date.parse(p.created) / 1000) || now : now;
      insert.run(p.id, p.name, p.comment, type, config ? JSON.stringify(config) : null,
        p.songCount ?? 0, p.duration || null, created);
      adopted++;
      logger.info('navidrome', `registry: adopted ${type} playlist "${p.name}" from its Navidrome comment`);
    }
  })();

  logger.info('navidrome', `playlist registry: ${playlists.length} Navidrome playlists checked, ${adopted} adopted`);
  return { ok: true, adopted };
}

// ── Native API auth ──────────────────────────────────────────────────────────

let nativeTokenCache = { token: null, expiresAt: 0 };

async function getNativeToken(db) {
  const now = Date.now();
  if (nativeTokenCache.token && now < nativeTokenCache.expiresAt) {
    return nativeTokenCache.token;
  }

  const settings = getSettings(db);
  const base     = settings.navidrome_url?.replace(/\/$/, '');
  if (!base || !settings.navidrome_user || !settings.navidrome_password) return null;

  try {
    const res  = await fetch(`${base}/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username: settings.navidrome_user, password: settings.navidrome_password })
    });
    if (!res.ok) throw new Error(`auth/login returned ${res.status}`);
    const json = await res.json();
    if (!json.token) throw new Error('no token in response');
    // Cache for 23 hours (ND tokens last 24h by default)
    nativeTokenCache = { token: json.token, expiresAt: now + 23 * 60 * 60 * 1000 };
    logger.debug('navidrome', 'native API token refreshed');
    return json.token;
  } catch (e) {
    logger.warn('navidrome', `getNativeToken failed: ${e.message}`);
    return null;
  }
}

async function getNdTrackCount(db) {
  try {
    const token = await getNativeToken(db);
    if (!token) return null;
    const settings = getSettings(db);
    const base     = settings.navidrome_url?.replace(/\/$/, '');
    const res      = await fetch(`${base}/api/song?_start=0&_end=0`, {
      headers: { 'X-ND-Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
      // Token may have expired — clear cache and retry once
      if (res.status === 401) {
        nativeTokenCache = { token: null, expiresAt: 0 };
        const fresh = await getNativeToken(db);
        if (!fresh) return null;
        const retry = await fetch(`${base}/api/song?_start=0&_end=0`, {
          headers: { 'X-ND-Authorization': `Bearer ${fresh}` }
        });
        if (!retry.ok) return null;
        const count = retry.headers.get('x-total-count');
        return count !== null ? parseInt(count, 10) : null;
      }
      return null;
    }
    const count = res.headers.get('x-total-count');
    return count !== null ? parseInt(count, 10) : null;
  } catch (e) {
    logger.warn('navidrome', `getNdTrackCount failed: ${e.message}`);
    return null;
  }
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
      mbid:       s.musicBrainzId || null,   // OpenSubsonic recording MBID ('' or absent → null)
      syncedAt
    })));
  }

  return songs.length;
}

async function syncLibrary(db) {
  const deezer = require('./deezer'); // inline to avoid circular dep at module load
  const IMAGE_DIR = path.join(process.env.DATA_DIR || '/app/data', 'artist-images');
  fs.mkdirSync(IMAGE_DIR, { recursive: true });

  let total = 0;
  let inserted = 0;
  let updated = 0;
  let removed = 0;
  let foundArtists = 0;
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
      duration, year, genre, play_count, starred, user_rating, bit_rate, mbid, synced_at)
    VALUES (@id, @title, @artist, @artistId, @album, @albumId,
      @duration, @year, @genre, @playCount, @starred, @userRating, @bitRate, @mbid, @syncedAt)
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
      mbid        = COALESCE(excluded.mbid, tracks.mbid),
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

      // The caller (sync runner) regenerates rules playlists when artists turn up.
      foundArtists = foundCount;
      if (foundCount > 0) logger.info('navidrome', `${foundCount} missing artist(s) found`);
    } catch (e) {
      logger.warn('navidrome', `close-the-loop check failed: ${e.message}`);
    }
  }

  await adoptTaggedPlaylists(db);

  return { ok: true, total, inserted, updated, removed, foundArtists };
}

module.exports = {
  request, ping, getMusicFolders, getArtists,
  getPlaylists, getPlaylist, createPlaylist,
  updatePlaylist, addTracksToPlaylist, removeTracksFromPlaylist, deletePlaylist,
  replacePlaylistTracks, syncLibrary, adoptTaggedPlaylists,
  getNativeToken, getNdTrackCount,
  buildParams
};
