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
  INSERT INTO tracks (id, title, artist, artist_id, album, album_id, genre, user_rating, library_id, synced_at)
  VALUES (@id, @title, @artist, @artistId, 'alb', 'alb', @genre, @rating, @lib, 0)`);
const track = (id, title, artist, extra = {}) =>
  ({ id, title, artist, artistId: artist.toLowerCase(), genre: null, rating: null, lib: null, ...extra });

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
  const state = { folders: 'ok' };   // 'ok' | 'error-response' | 'http-500'
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
      const all = f ? songsByFolder[f] : Object.values(songsByFolder).flat();
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
