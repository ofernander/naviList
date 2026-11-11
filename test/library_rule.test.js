'use strict';

// Library rule regression tests. Run with `npm test` (node:test, no extra deps).

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const http     = require('node:http');
const os       = require('node:os');
const fs       = require('node:fs');
const path     = require('node:path');
const Database = require('better-sqlite3');

process.env.DATA_DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'navilist-test-'));
process.env.LOG_LEVEL = 'error';
require('../src/utils/logger').setLevel?.('error');

const schema    = require('../src/db/schema');
const engine    = require('../src/lib/pl_engine');
const navidrome = require('../src/providers/navidrome');

function freshDb() {
  const db = new Database(':memory:');
  schema(db);
  return db;
}

const insert = db => db.prepare(`
  INSERT INTO tracks (id, title, artist, artist_id, album, album_id, genre, user_rating, library_id, is_live, mbid, synced_at)
  VALUES (@id, @title, @artist, @artistId, @album, 'alb', @genre, @rating, @lib, @isLive, @mbid, 0)`);
const track = (id, title, artist, extra = {}) =>
  ({ id, title, artist, artistId: artist.toLowerCase(), album: 'alb', genre: null, rating: null, lib: null, isLive: null, mbid: null, ...extra });

const libBlocks = (limit, a = 60, b = 40, cond = []) => ({
  limit,
  blocks: [
    { rule: { term: 'library', value: '1', options: { name: 'Mine' } }, conditions: cond, share: a },
    { rule: { term: 'library', value: '2', options: { name: 'Theirs' } }, share: b },
  ],
});
const libOf = db => { const g = db.prepare('SELECT library_id FROM tracks WHERE id = ?'); return id => g.get(id).library_id; };
const songOf = db => { const g = db.prepare('SELECT artist, title FROM tracks WHERE id = ?'); return id => { const t = g.get(id); return `${t.artist}|${t.title}`; }; };

// ── 1. Dedupe is scoped to Library playlists ──────────────────────────────────

test('playlists without a Library rule keep combining blocks by track id', async () => {
  const db = freshDb(); const ins = insert(db);
  // The same song as two tracks (different ids), one tagged rock, one pop.
  ins.run(track('rock-copy', 'Same Song', 'Band', { genre: 'rock' }));
  ins.run(track('pop-copy',  'Same Song', 'Band', { genre: 'pop' }));
  for (let i = 0; i < 4; i++) ins.run(track(`r${i}`, `Rock ${i}`, `R${i}`, { genre: 'rock' }));
  for (let i = 0; i < 4; i++) ins.run(track(`p${i}`, `Pop ${i}`,  `P${i}`, { genre: 'pop' }));

  const config = { limit: 100, blocks: [{ rule: { term: 'genre', value: 'rock' } }, { rule: { term: 'genre', value: 'pop' } }] };
  const key = engine.blockKey(db, require('../src/lib/playlist_types').normalizeRules(config));
  assert.equal(key('rock-copy'), 'rock-copy', 'non-library playlists key by id');

  const ids = await engine.generatePlaylist(db, config);
  assert.ok(ids.includes('rock-copy') && ids.includes('pop-copy'), 'both copies still used, as before');
  assert.equal(ids.length, 10);
});

test('playlists with a Library rule use a song held in two libraries once', async () => {
  const db = freshDb(); const ins = insert(db);
  ins.run(track('mine-copy',   'Shared', 'Band', { lib: '1' }));
  ins.run(track('theirs-copy', 'Shared', 'Band', { lib: '2' }));
  for (let i = 0; i < 4; i++) ins.run(track(`m${i}`, `Mine ${i}`,   `M${i}`, { lib: '1' }));
  for (let i = 0; i < 4; i++) ins.run(track(`t${i}`, `Theirs ${i}`, `T${i}`, { lib: '2' }));

  for (let run = 0; run < 20; run++) {
    const ids = await engine.generatePlaylist(db, libBlocks(100, undefined, undefined));
    const copies = ids.filter(id => id.endsWith('-copy'));
    assert.equal(copies.length, 1, 'exactly one copy of the shared song');
    assert.equal(ids.length, 9);
  }
});

test('a Library rule used only as a shared condition also dedupes by song', () => {
  const db = freshDb(); const ins = insert(db);
  ins.run(track('a', 'Shared', 'Band', { lib: '1' }));
  const config = require('../src/lib/playlist_types').normalizeRules({
    blocks: [{ rule: { term: 'genre', value: 'rock' } }],
    conditions: [{ term: 'library', value: '1', use: 'require' }],
  });
  assert.equal(engine.blockKey(db, config)('a'), 'band|||shared');
});

// ── 2. Sync fallback keeps library tags ───────────────────────────────────────

function mockNavidrome(songsByFolder, folderNames) {
  const state = { folders: 'ok', songs: songsByFolder };   // folders: 'ok' | 'error-response' | 'http-500'
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.pathname.split('/').pop();
    if (action === 'getMusicFolders' && state.folders === 'http-500') { res.statusCode = 500; return res.end('oops'); }
    let body = { status: 'ok' };
    if (action === 'getMusicFolders') {
      body = state.folders === 'error-response'
        ? { status: 'failed', error: { code: 0, message: 'temporarily unavailable' } }
        : { status: 'ok', musicFolders: { musicFolder: Object.entries(folderNames).map(([id, name]) => ({ id: Number(id), name })) } };
    } else if (action === 'search3') {
      const f = u.searchParams.get('musicFolderId');
      const off = Number(u.searchParams.get('songOffset'));
      const all = f ? state.songs[f] : Object.values(state.songs).flat();
      body.searchResult3 = { song: all.slice(off, off + 500) };
    } else if (action === 'getPlaylists') {
      body.playlists = { playlist: [] };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ 'subsonic-response': body }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state })));
}

function configure(db, port) {
  const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  set.run('navidrome_url', `http://127.0.0.1:${port}`);
  set.run('navidrome_user', 'u');
  set.run('navidrome_password', 'p');
}

const songs = (prefix, n, extra = {}) => Array.from({ length: n }, (_, i) =>
  ({ id: `${prefix}${i}`, title: `${prefix} song ${i}`, artist: `${prefix}A${i % 3}`, artistId: `${prefix}a${i % 3}`, ...extra }));

for (const failure of ['error-response', 'http-500']) {
  test(`getMusicFolders failing (${failure}) keeps library tags, libraries and tracks`, async () => {
    const { server, state } = await mockNavidrome({ 1: songs('m', 6, { userRating: 5 }), 2: songs('t', 6) }, { 1: 'Mine', 2: 'Theirs' });
    try {
      const db = freshDb();
      configure(db, server.address().port);

      const first = await navidrome.syncLibrary(db);
      assert.equal(first.ok, true);
      const tagsBefore = db.prepare('SELECT id, library_id FROM tracks ORDER BY id').all();
      assert.equal(tagsBefore.filter(r => r.library_id === '1').length, 6);
      assert.equal(tagsBefore.filter(r => r.library_id === '2').length, 6);
      const before = new Set(await engine.generatePlaylist(db, libBlocks(50)));

      state.folders = failure;
      const second = await navidrome.syncLibrary(db);
      assert.equal(second.ok, true, 'sync still succeeds through the unscoped fallback');
      assert.equal(second.removed, 0, 'no tracks removed');
      assert.deepEqual(db.prepare('SELECT id, library_id FROM tracks ORDER BY id').all(), tagsBefore, 'library tags unchanged');
      assert.deepEqual(db.prepare('SELECT id, name FROM libraries ORDER BY id').all(), [{ id: '1', name: 'Mine' }, { id: '2', name: 'Theirs' }]);
      assert.deepEqual(new Set(await engine.generatePlaylist(db, libBlocks(50))), before, 'Library playlist resolves to the same tracks');
    } finally { server.close(); }
  });
}

test('a configured folder list syncs only those folders and still tags them', async () => {
  const { server } = await mockNavidrome({ 1: songs('m', 3), 2: songs('t', 3) }, { 1: 'Mine', 2: 'Theirs' });
  try {
    const db = freshDb();
    configure(db, server.address().port);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('music_folder_ids', '2')").run();
    await navidrome.syncLibrary(db);
    assert.deepEqual(db.prepare('SELECT DISTINCT library_id AS l FROM tracks').all(), [{ l: '2' }]);
  } finally { server.close(); }
});

// ── 3. Overlapping and short blocks ───────────────────────────────────────────

test('heavy overlap between libraries keeps the 60/40 split exact', async () => {
  const db = freshDb(); const ins = insert(db);
  // Mine: 30 songs rated 5. Theirs: 30 songs, 20 of them the same songs as Mine.
  for (let i = 0; i < 30; i++) ins.run(track(`m${i}`, `Song ${i}`, `A${i % 6}`, { lib: '1', rating: 5 }));
  for (let i = 0; i < 30; i++) ins.run(track(`t${i}`, `Song ${i < 20 ? i : 100 + i}`, `A${i % 6}`, { lib: '2' }));
  const lib = libOf(db), song = songOf(db);

  for (let run = 0; run < 50; run++) {
    const ids = await engine.generatePlaylist(db, libBlocks(20, 60, 40, [{ term: 'rating', value: 'min4', use: 'require' }]));
    assert.equal(ids.length, 20);
    assert.equal(ids.filter(id => lib(id) === '1').length, 12, 'Mine gets 60%');
    assert.equal(ids.filter(id => lib(id) === '2').length, 8,  'Theirs gets 40%');
    assert.equal(new Set(ids.map(song)).size, 20, 'no song twice');
  }
});

test('a block that runs short leaves its slots to the other block', async () => {
  const db = freshDb(); const ins = insert(db);
  for (let i = 0; i < 30; i++) ins.run(track(`m${i}`, `Mine ${i}`, `A${i % 6}`, { lib: '1' }));
  // Theirs: 3 songs of its own, plus 5 that Mine also has.
  for (let i = 0; i < 3; i++) ins.run(track(`t${i}`, `Theirs ${i}`, `B${i}`, { lib: '2' }));
  for (let i = 0; i < 5; i++) ins.run(track(`d${i}`, `Mine ${i}`, `A${i % 6}`, { lib: '2' }));
  const lib = libOf(db), song = songOf(db);

  for (let run = 0; run < 50; run++) {
    const ids = await engine.generatePlaylist(db, libBlocks(20));
    assert.equal(ids.length, 20, 'playlist still filled to its limit');
    assert.equal(new Set(ids.map(song)).size, 20, 'no song twice');
    const theirs = ids.filter(id => lib(id) === '2').length;
    assert.ok(theirs >= 3 && theirs <= 8, `Theirs used what it had (${theirs})`);
  }
});

test('when every block is short the playlist is just shorter, never padded with repeats', async () => {
  const db = freshDb(); const ins = insert(db);
  for (let i = 0; i < 4; i++) ins.run(track(`m${i}`, `Song ${i}`, `A${i}`, { lib: '1' }));
  for (let i = 0; i < 4; i++) ins.run(track(`t${i}`, `Song ${i}`, `A${i}`, { lib: '2' }));   // all duplicates
  const ids = await engine.generatePlaylist(db, libBlocks(20));
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids.map(songOf(db))).size, 4);
});

// ── 4. Post-save studio refinement keeps Library rules ────────────────────────

const publish   = require('../src/lib/publish');
const { normalizeRules } = require('../src/lib/playlist_types');

// Stub Navidrome writes and capture what publishPlaylist (and the detached
// studio refine after it) sends, so tests check the published track ids.
function stubNavidrome() {
  const calls = [];
  const orig = { ...navidrome };
  navidrome.createPlaylist        = async (db, name, ids) => { calls.push(['create', ids]); return { ok: true, playlist: { id: 'pl1' } }; };
  navidrome.replacePlaylistTracks = async (db, id, ids) => { calls.push(['replace', ids]); return { ok: true }; };
  navidrome.updatePlaylist        = async () => ({ ok: true });
  return { calls, restore: () => Object.assign(navidrome, orig) };
}
const settle = () => new Promise(r => setTimeout(r, 150));   // let the detached refine finish
const published = db => db.prepare('SELECT track_id FROM navilist_playlist_tracks WHERE playlist_id = ? ORDER BY position').all('pl1').map(r => r.track_id);

test('studio refine never swaps a Library playlist track for a copy in another library', async () => {
  const db = freshDb(); const ins = insert(db);
  // "Hit" is in both libraries. Theirs' copy is MB-confirmed studio; Mine's is unknown —
  // the old refine would swap Mine's copy for Theirs'.
  ins.run(track('mine-hit',   'Hit', 'Band', { lib: '1', rating: 5 }));
  ins.run(track('theirs-hit', 'Hit', 'Band', { lib: '2', isLive: 0 }));
  for (let i = 0; i < 5; i++) ins.run(track(`m${i}`, `Mine ${i}`,   `M${i}`, { lib: '1', rating: 5 }));
  for (let i = 0; i < 5; i++) ins.run(track(`t${i}`, `Theirs ${i}`, `T${i}`, { lib: '2' }));
  const config = libBlocks(6, 50, 50, [{ term: 'rating', value: 'min4', use: 'require' }]);
  const trackIds = ['mine-hit', 'm0', 'm1', 't0', 't1', 't2'];

  const nd = stubNavidrome();
  try {
    const res = await publish.publishPlaylist(db, { name: 'Blend', type: 'navilist', config: normalizeRules(config), trackIds });
    assert.equal(res.ok, true);
    await settle();
    assert.deepEqual(published(db), trackIds, 'registry keeps the Library pick');
    assert.ok(!nd.calls.some(([k]) => k === 'replace'), 'no refine replace sent to Navidrome');
  } finally { nd.restore(); }
});

test('studio refine never swaps to a same-library copy that breaks another condition', async () => {
  const db = freshDb(); const ins = insert(db);
  ins.run(track('hit-5star', 'Hit', 'Band', { lib: '1', rating: 5 }));
  ins.run(track('hit-2star', 'Hit', 'Band', { lib: '1', rating: 2, isLive: 0 }));   // studio, but fails Rating ≥ 4
  const config = normalizeRules(libBlocks(5, 100, undefined, [{ term: 'rating', value: 'min4', use: 'require' }]));
  config.blocks = config.blocks.slice(0, 1);
  assert.deepEqual(await publish.refineForPlaylist(db, ['hit-5star'], { type: 'navilist', config }), ['hit-5star']);
});

test('studio refine still swaps within the rules when the copy qualifies', async () => {
  const db = freshDb(); const ins = insert(db);
  ins.run(track('hit-unknown', 'Hit', 'Band', { lib: '1', rating: 5 }));
  ins.run(track('hit-studio',  'Hit', 'Band', { lib: '1', rating: 5, isLive: 0 }));
  ins.run(track('hit-other',   'Hit', 'Band', { lib: '2', isLive: 0 }));
  const config = normalizeRules(libBlocks(5, 60, 40, [{ term: 'rating', value: 'min4', use: 'require' }]));

  const nd = stubNavidrome();
  try {
    await publish.publishPlaylist(db, { name: 'Blend', type: 'navilist', config, trackIds: ['hit-unknown'] });
    await settle();
    assert.deepEqual(published(db), ['hit-studio'], 'swapped to the studio copy in the same library');
    assert.deepEqual(nd.calls.at(-1), ['replace', ['hit-studio']]);
  } finally { nd.restore(); }
});

test('published Library playlist keeps its library shares through the refine (overlapping libraries)', async () => {
  const db = freshDb(); const ins = insert(db);
  // 20 songs in both libraries; every copy in Theirs is MB-confirmed studio, so the
  // old refine would move all of Mine's overlapping picks over to Theirs.
  for (let i = 0; i < 30; i++) ins.run(track(`m${i}`, `Song ${i}`, `A${i % 6}`, { lib: '1', rating: 5 }));
  for (let i = 0; i < 30; i++) ins.run(track(`t${i}`, `Song ${i < 20 ? i : 100 + i}`, `A${i % 6}`, { lib: '2', isLive: 0 }));
  const config = normalizeRules(libBlocks(20, 60, 40, [{ term: 'rating', value: 'min4', use: 'require' }]));
  const lib = libOf(db), song = songOf(db);

  const nd = stubNavidrome();
  try {
    for (let run = 0; run < 10; run++) {
      const trackIds = await engine.generatePlaylist(db, config);
      await publish.publishPlaylist(db, { id: 'pl1', type: 'navilist', config, trackIds });
      await settle();
      const final = published(db);
      assert.equal(final.filter(id => lib(id) === '1').length, 12, 'Mine keeps 60%');
      assert.equal(final.filter(id => lib(id) === '2').length, 8,  'Theirs keeps 40%');
      assert.equal(new Set(final.map(song)).size, 20);
    }
  } finally { nd.restore(); }
});

test('playlists without a Library rule keep the old library-wide refine', async () => {
  const db = freshDb(); const ins = insert(db);
  ins.run(track('rock-hit', 'Hit', 'Band', { genre: 'rock' }));
  ins.run(track('any-hit',  'Hit', 'Band', { genre: 'pop', isLive: 0 }));
  const config = normalizeRules({ blocks: [{ rule: { term: 'genre', value: 'rock' } }] });
  assert.deepEqual(await publish.refineForPlaylist(db, ['rock-hit'], { type: 'navilist', config }), ['any-hit']);
  assert.deepEqual(await publish.refineForPlaylist(db, ['rock-hit'], { type: 'import' }), ['any-hit']);
});

// ── 5. Library data is published only after a complete sync ──────────────────

function mockWithFailures(songsByFolder, folderNames) {
  const state = { fail: null, names: folderNames, songs: songsByFolder };   // fail: { folder, offset }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const action = u.pathname.split('/').pop();
    let body = { status: 'ok' };
    if (action === 'getMusicFolders') {
      body.musicFolders = { musicFolder: Object.entries(state.names).map(([id, name]) => ({ id: Number(id), name })) };
    } else if (action === 'search3') {
      const f = u.searchParams.get('musicFolderId');
      const off = Number(u.searchParams.get('songOffset'));
      if (state.fail && state.fail.folder === f && state.fail.offset === off) body = { status: 'failed', error: { message: 'boom' } };
      else body.searchResult3 = { song: (state.songs[f] || []).slice(off, off + 500) };
    } else if (action === 'getPlaylists') {
      body.playlists = { playlist: [] };
    }
    res.end(JSON.stringify({ 'subsonic-response': body }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state })));
}

const libraryState = db => ({
  libraries: db.prepare('SELECT id, name FROM libraries ORDER BY id').all(),
  tags:      db.prepare('SELECT id, library_id FROM tracks ORDER BY id').all(),
  tracks:    db.prepare('SELECT id, title, artist, album, play_count, user_rating, synced_at FROM tracks ORDER BY id').all(),
});

for (const [where, fail] of [['the first page', { folder: '1', offset: 0 }], ['a later page', { folder: '1', offset: 500 }], ['a later folder', { folder: '2', offset: 0 }]]) {
  test(`a sync that fails on ${where} leaves library data exactly as it was`, async () => {
    // Folder 1 has 700 songs, so it takes two pages.
    const { server, state } = await mockWithFailures({ 1: songs('m', 700), 2: songs('t', 10) }, { 1: 'Mine', 2: 'Theirs' });
    try {
      const db = freshDb();
      configure(db, server.address().port);
      assert.equal((await navidrome.syncLibrary(db)).ok, true);
      const before = libraryState(db);

      // Navidrome changes: a library is renamed, a new one appears, songs move library.
      state.names = { 1: 'Mine (renamed)', 2: 'Theirs', 3: 'New' };
      // Every library 1 title changes too (e.g. retagged), so any partial write shows.
      const retitled = songs('m', 700).map(x => ({ ...x, title: `${x.title} (retagged)` }));
      state.songs = { 1: retitled.concat(songs('t', 5)), 2: songs('t', 10).slice(5), 3: songs('n', 4) };
      state.fail  = fail;
      const res = await navidrome.syncLibrary(db);
      assert.equal(res.ok, false);
      const after = libraryState(db);
      assert.deepEqual(after.libraries, before.libraries, 'library list unchanged');
      assert.deepEqual(after.tags, before.tags, 'every track keeps its library');
      assert.deepEqual(after.tracks, before.tracks, 'no track inserted, updated or removed');

      state.fail = null;
      assert.equal((await navidrome.syncLibrary(db)).ok, true);
      const done = libraryState(db);
      assert.deepEqual(done.libraries.map(l => l.name), ['Mine (renamed)', 'Theirs', 'New']);
      const tagOf = new Map(done.tags.map(r => [r.id, r.library_id]));
      assert.equal(tagOf.get('t0'), '1', 'moved song re-tagged once the sync completes');
      assert.equal(tagOf.get('n0'), '3');
    } finally { server.close(); }
  });
}

// ── 6. Dedupe policy for distinct recordings ──────────────────────────────────

test('policy: in a Library playlist, same artist + title counts as one song even across distinct recordings', async () => {
  // Two different recordings (different MBIDs and albums) of "Song" by "Band",
  // one per library. naviList's song key is artist + title (studio.songKey), so a
  // Library playlist uses only one of them. Playlists without a Library rule are
  // unaffected (see the first test in this file).
  const db = freshDb(); const ins = insert(db);
  ins.run(track('rec-a', 'Song', 'Band', { lib: '1', mbid: 'mbid-a', album: 'Album 1' }));
  ins.run(track('rec-b', 'Song', 'Band', { lib: '2', mbid: 'mbid-b', album: 'Album 2 (2011 re-recording)' }));
  for (let run = 0; run < 10; run++) {
    const ids = await engine.generatePlaylist(db, libBlocks(10));
    assert.equal(ids.filter(id => id.startsWith('rec-')).length, 1);
  }
});

// ── 7. Partial discovery never leaks into Library-filtered playlists ─────────

// Every track, ordered: a block that starts from "Unplayed" (all synced tracks
// here) with a shared Library exclusion.
const notLibrary = (id, limit = 500) => ({
  limit,
  blocks: [{ rule: { term: 'stats', value: 'unplayed' } }],
  conditions: [{ term: 'library', value: id, options: { name: `Library ${id}` }, use: 'exclude' }],
});

test('after a later-folder failure, "Library is not 1" never yields a library 1 track', async () => {
  const { server, state } = await mockWithFailures({ 1: songs('m', 8), 2: songs('t', 8) }, { 1: 'Mine', 2: 'Theirs' });
  try {
    const db = freshDb();
    configure(db, server.address().port);
    assert.equal((await navidrome.syncLibrary(db)).ok, true);

    // New songs land in library 1; the next sync reads folder 1 then fails on folder 2.
    state.songs = { 1: songs('m', 8).concat(songs('mnew', 6)), 2: songs('t', 8) };
    state.fail  = { folder: '2', offset: 0 };
    assert.equal((await navidrome.syncLibrary(db)).ok, false);

    const ids = await engine.generatePlaylist(db, notLibrary('1'));
    assert.ok(ids.length > 0);
    assert.ok(ids.every(id => id.startsWith('t')), `only library 2 tracks: ${ids.filter(id => !id.startsWith('t'))}`);
  } finally { server.close(); }
});

test('untagged tracks (fallback pass, or before the first full sync) never pass "Library is not X"', async () => {
  const { server, state } = await mockNavidrome({ 1: songs('m', 5), 2: songs('t', 5) }, { 1: 'Mine', 2: 'Theirs' });
  try {
    const db = freshDb();
    configure(db, server.address().port);
    assert.equal((await navidrome.syncLibrary(db)).ok, true);

    // A song is added to library 1 while the library list is unavailable: the
    // fallback pass inserts it with no library.
    state.folders = 'error-response';
    state.songs   = { 1: songs('m', 5).concat(songs('mnew', 1)), 2: songs('t', 5) };
    assert.equal((await navidrome.syncLibrary(db)).ok, true);
    assert.equal(db.prepare("SELECT library_id FROM tracks WHERE id = 'mnew0'").get().library_id, null);

    const ids = await engine.generatePlaylist(db, notLibrary('1'));
    assert.deepEqual(ids.sort(), songs('t', 5).map(s => s.id).sort());

    // Non-Library playlists still see the new track.
    const all = await engine.generatePlaylist(db, { limit: 500, blocks: [{ rule: { term: 'stats', value: 'unplayed' } }] });
    assert.ok(all.includes('mnew0'));
  } finally { server.close(); }
});

// ── 8. Stale removal is part of the same publication ─────────────────────────

test('playlists generated while artist images download already see the full new state', async () => {
  const deezer = require('../src/providers/deezer');
  const origDownload = deezer.downloadArtistImage;
  let release, reached;
  const paused = new Promise(r => { release = r; });
  const atImages = new Promise(r => { reached = r; });
  deezer.downloadArtistImage = async () => { reached(); await paused; return false; };

  const { server, state } = await mockWithFailures({ 1: songs('m', 6), 2: songs('t', 6) }, { 1: 'Mine', 2: 'Theirs' });
  try {
    const db = freshDb();
    configure(db, server.address().port);
    assert.equal((await navidrome.syncLibrary(db)).ok, true);   // images off: no pause
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('deezer_artist_images', 'true')").run();

    // Library 2 is removed from Navidrome; a new artist arrives in library 1.
    state.names = { 1: 'Mine' };
    state.songs = { 1: songs('m', 6).concat(songs('fresh', 2)) };
    const syncing = navidrome.syncLibrary(db);
    await atImages;   // sync is now paused inside the artist image download

    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE id LIKE 't%'").get().n, 0, 'removed library\'s tracks already gone');
    assert.deepEqual(db.prepare('SELECT id FROM libraries').all(), [{ id: '1' }]);
    assert.deepEqual(await engine.generatePlaylist(db, { limit: 50, blocks: [{ rule: { term: 'library', value: '2' } }] }), [], 'removed library is not selectable');
    const mine = await engine.generatePlaylist(db, { limit: 50, blocks: [{ rule: { term: 'library', value: '1' } }] });
    assert.equal(mine.length, 8, 'new library 1 tracks already selectable');

    release();
    const res = await syncing;
    assert.equal(res.ok, true);
    assert.equal(res.removed, 6);
  } finally { release(); deezer.downloadArtistImage = origDownload; server.close(); }
});
