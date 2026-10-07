'use strict';

/**
 * pl_engine.js — naviList Playlist Engine
 *
 * Single entry point for all smart playlist generation logic.
 * Design spec: MISC/pl_engine.md
 *
 * A rules playlist is a set of blocks (config format: lib/playlist_types.js):
 * each block is a starting rule narrowed by its own conditions plus the shared
 * ones, optionally split by studio / live and by popularity; the playlist
 * combines the blocks by share.
 *
 * Exports:
 *   generatePlaylist(db, config) → Promise<string[]>   — full resolution to track ID list
 *   resolveRule(db, rule)        → Promise<string[]>   — single term → ranked track ID pool
 *   validateRules(config)        → { ok, errors[] }    — validate a rules config
 *   previewRules(db, config)     → Promise<Object[]>   — per-block count + sample, no combining
 */

const logger = require('../utils/logger');
const { cleanPool, orderByArtist, mixByPopularity, splitVersions, mixVersions, combineBlocks } = require('./finalize');
const { effectiveSource, ensureSimilarArtists, getSimilarArtists } = require('./similar');
const { CONDITION_USES, SIMILAR_DEPTHS, SIMILAR_SOURCES, canonicalTerm, normalizeRules, shareProblem,
        MIX_TIERS, mixProblem, mixWeights } = require('./playlist_types');

// ── Constants ─────────────────────────────────────────────────────────────────

const SUPPORTED_TERMS = ['artist', 'genre', 'stats', 'decade', 'mood'];
const SUPPORTED_STATS = ['top_played', 'recently_played', 'not_recently_played', 'unplayed', 'starred', 'highly_rated', 'loved', 'disliked', 'top_artists'];
// Stats values whose result is a meaningful best-first ranking.
const RANKED_STATS    = ['top_played', 'recently_played', 'top_artists', 'highly_rated'];
const DEFAULT_LIMIT   = 25;

// ── Public API ────────────────────────────────────────────────────────────────

const hasValue = v => !(v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length));

// Errors for one rule (a block's start or a condition), prefixed with `where`.
function ruleErrors(rule, where, { condition = false } = {}) {
  const errors = [];
  if (!rule || typeof rule !== 'object') return [`${where}: missing`];
  if (!SUPPORTED_TERMS.includes(canonicalTerm(rule.term))) errors.push(`${where}: unknown term "${rule.term}"`);
  if (!hasValue(rule.value)) errors.push(`${where}: value is required`);
  if (condition && !CONDITION_USES.includes(rule.use)) errors.push(`${where}: use must be one of ${CONDITION_USES.join(' | ')}`);
  const o = rule.options || {};
  if (o.similar !== undefined && !SIMILAR_DEPTHS[o.similar]) errors.push(`${where}: similar must be one of ${Object.keys(SIMILAR_DEPTHS).join(' | ')}`);
  if (o.similar_source !== undefined && !SIMILAR_SOURCES.includes(o.similar_source)) errors.push(`${where}: similar_source must be one of ${SIMILAR_SOURCES.join(' | ')}`);
  if (o.seed_share !== undefined && !(typeof o.seed_share === 'number' && o.seed_share >= 0 && o.seed_share <= 100)) errors.push(`${where}: seed_share must be 0–100`);
  return errors;
}

/**
 * Validate a rules config (v1 or v2 — normalized first). Returns { ok, errors[] }.
 * checkShares: false skips the share total (per-block previews don't use it).
 */
function validateRules(config, { checkShares = true } = {}) {
  if (!config || typeof config !== 'object') return { ok: false, errors: ['rules must be an object'] };
  config = normalizeRules(config);
  const errors = [];
  if (!Array.isArray(config.blocks) || !config.blocks.length) errors.push('add at least one block');
  if (config.limit !== undefined && typeof config.limit !== 'number') errors.push('limit must be a number');
  (config.blocks || []).forEach((b, i) => {
    errors.push(...ruleErrors(b.rule, `block ${i + 1}`));
    if (b.share !== undefined && !(typeof b.share === 'number' && b.share > 0 && b.share <= 100)) errors.push(`block ${i + 1}: share must be 1–100`);
    (b.conditions || []).forEach((c, j) => errors.push(...ruleErrors(c, `block ${i + 1} condition ${j + 1}`, { condition: true })));
    for (const key of Object.keys(MIX_TIERS)) {
      const problem = mixProblem(b[key], key);
      if (problem) errors.push(`block ${i + 1}: ${problem}`);
    }
  });
  for (const key of Object.keys(MIX_TIERS)) {
    const problem = mixProblem(config[key], key);
    if (problem) errors.push(`every block: ${problem}`);
  }
  (config.conditions || []).forEach((c, j) => {
    errors.push(...ruleErrors(c, `shared condition ${j + 1}`, { condition: true }));
    // "Only artist X" on every block would reduce the playlist to one artist.
    if (canonicalTerm(c.term) === 'artist' && c.use !== 'exclude') errors.push(`shared condition ${j + 1}: an artist for every block can only be Not`);
  });
  const shares = checkShares ? shareProblem(config.blocks) : null;
  if (shares) errors.push(shares);
  return { ok: errors.length === 0, errors };
}

/**
 * Resolve a single rule to an array of track IDs (best-first for ranked stats).
 */
async function resolveRule(db, rule) {
  switch (canonicalTerm(rule.term)) {
    case 'stats':   return resolveStats(db, rule);
    case 'decade':  return resolveDecade(db, rule);
    case 'genre':   return resolveGenre(db, rule);
    case 'artist':  return resolveArtist(db, rule);
    case 'mood':    return resolveMood(db, rule);
    default:
      logger.warn('pl_engine', `unknown term: ${rule.term}`);
      return [];
  }
}

/**
 * A block's track pool, in its starting rule's order: the start narrowed by
 * every Only condition (same term repeated = either, different terms = all
 * must hold), minus every Not condition. Shared conditions apply like the
 * block's own.
 */
async function resolveBlock(db, block, shared = []) {
  const conditions = [...(block.conditions || []), ...shared];
  let pool = await resolveRule(db, block.rule);

  const groups = new Map();   // term → Set of ids (Only conditions, union within a term)
  for (const c of conditions.filter(c => c.use !== 'exclude')) {
    const term = canonicalTerm(c.term);
    if (!groups.has(term)) groups.set(term, new Set());
    (await resolveRule(db, c)).forEach(id => groups.get(term).add(id));
  }
  for (const set of groups.values()) pool = pool.filter(id => set.has(id));

  const notConds = conditions.filter(c => c.use === 'exclude');
  if (notConds.length) {
    const excluded = new Set();
    for (const c of notConds) (await resolveRule(db, c)).forEach(id => excluded.add(id));
    pool = pool.filter(id => !excluded.has(id));
  }
  return pool;
}

// A block keeps its order only when it starts from a ranked stat (e.g. top
// played) — the limit then takes the best tracks; every other block shuffles,
// so a playlist varies on each refresh.
const isRanked = rule => canonicalTerm(rule.term) === 'stats' && RANKED_STATS.includes(rule.value);

/**
 * Generate a playlist from a rules config (v1 or v2). Each block: pool →
 * shuffle (unless ranked) → clean (disliked, studio) → even split by artist
 * (with optional seed share); then the blocks are combined by share.
 */
async function generatePlaylist(db, config) {
  config = normalizeRules(config);
  const validation = validateRules(config);
  if (!validation.ok) {
    logger.error('pl_engine', `invalid rules: ${validation.errors.join(', ')}`);
    return [];
  }
  const limit  = config.limit ?? DEFAULT_LIMIT;
  const lists  = [];
  for (const [i, block] of config.blocks.entries()) {
    let pool = await resolveBlock(db, block, config.conditions);
    if (!isRanked(block.rule)) fisherYates(pool);

    const o = block.rule.options || {};
    const seedShare = canonicalTerm(block.rule.term) === 'artist' && o.similar ? o.seed_share : undefined;
    const seedArtistIds = seedShare === undefined ? [] : db.prepare(
      'SELECT DISTINCT artist_id FROM tracks WHERE LOWER(artist) = LOWER(?)'
    ).all(block.rule.value).map(r => r.artist_id);
    const order = ids => orderByArtist(db, ids, { seedArtistIds, seedShare });
    lists.push(await orderBlock(db, block, config, pool, order));
    logger.debug('pl_engine', `block ${i + 1} [${block.rule.term}:${block.rule.value}] → ${lists[i].length} tracks`);
  }

  // A single block's share is ignored — it is the whole playlist.
  const shares = config.blocks.length > 1 ? config.blocks.map(b => b.share) : [undefined];
  const ids = combineBlocks(lists, shares, limit);
  if (!ids.length) logger.info('pl_engine', 'no tracks matched any block');
  logger.info('pl_engine', `generated ${ids.length} tracks from ${config.blocks.length} block(s), ${config.conditions.length} shared condition(s)`);
  return ids;
}

/**
 * Preview: each block's pool size + a sample, without combining. Lets the rule
 * builder show "this block matches N tracks" while editing.
 */
async function previewRules(db, config) {
  config = normalizeRules(config);
  const validation = validateRules(config, { checkShares: false });
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const blocks = [];
  for (const block of config.blocks) {
    let ids = await resolveBlock(db, block, config.conditions);
    // Splits never use tiers at 0%, so those tracks don't count.
    const versions = block.versions ?? config.versions;
    const popular  = block.popularity ?? config.popularity;
    const byPop    = list => popular ? mixByPopularity(db, list, mixWeights(popular, 'popularity')) : list;
    if (versions && mixWeights(versions, 'versions').live > 0) ids = mixVersions(db, splitVersions(db, ids), mixWeights(versions, 'versions'), byPop);
    else ids = byPop(ids);
    blocks.push({ count: ids.length, sample: ids.slice(0, 5) });
  }
  return { ok: true, blocks };
}

/**
 * A block's pool, cleaned and in playlist order. Splits apply when set (a
 * block's own wins over the playlist's): Studio / Live first, so its ratio is
 * exact, then Popularity within each side. Without a Studio / Live split that
 * takes live, the pool is studio only, as always.
 */
async function orderBlock(db, block, config, pool, order) {
  const popular  = block.popularity ?? config.popularity;
  const byPop    = ids => popular ? mixByPopularity(db, ids, mixWeights(popular, 'popularity'), order) : order(ids);
  const versions = block.versions ?? config.versions;
  const vw       = versions && mixWeights(versions, 'versions');
  if (vw && vw.live > 0) return mixVersions(db, splitVersions(db, pool, 'pl_engine'), vw, byPop);
  return byPop(await cleanPool(db, pool, 'pl_engine'));
}

// ── Term resolvers ────────────────────────────────────────────────────────────

/**
 * stats — local play history and track metadata
 * values: top_played | recently_played | unplayed | starred | highly_rated
 */
function resolveStats(db, rule) {
  const opts   = rule.options || {};
  const value  = rule.value;

  switch (value) {
    case 'top_played': {
      const source = opts.source || 'navidrome';
      if (source === 'history') {
        // Rank by play count in play_history over a time window
        const window = opts.window || 'all_time';
        const cutoff = windowToCutoff(window);
        const rows = db.prepare(`
          SELECT track_id AS id, COUNT(*) AS plays
          FROM play_history
          WHERE played_at >= ?
          GROUP BY track_id
          ORDER BY plays DESC
        `).all(cutoff);
        return rows.map(r => r.id);
      } else if (source === 'navidrome') {
        // Default: Navidrome all-time play_count
        const rows = db.prepare(`
          SELECT id FROM tracks
          WHERE play_count > 0
          ORDER BY play_count DESC
        `).all();
        return rows.map(r => r.id);
      } else {
        // External source (lastfm | listenbrainz | maloja): read synced rankings
        // from user_top_tracks for the selected period, ordered by rank.
        const period = opts.period || 'overall';
        const rows = db.prepare(`
          SELECT track_id AS id FROM user_top_tracks
          WHERE source = ? AND period = ?
          ORDER BY rank ASC
        `).all(source, period);
        return rows.map(r => r.id);
      }
    }

    case 'recently_played': {
      const window  = opts.window || 'month';
      const cutoff  = windowToCutoff(window);
      const rows    = db.prepare(`
        SELECT DISTINCT track_id FROM play_history
        WHERE played_at >= ?
        ORDER BY played_at DESC
      `).all(cutoff);
      return rows.map(r => r.track_id);
    }

    case 'not_recently_played': {
      // Tracks not scrobbled since the cutoff window
      const window  = opts.window || 'year';
      const cutoff  = windowToCutoff(window);
      // Tracks that either have no play_history rows at all,
      // or whose most recent play is before the cutoff
      const rows = db.prepare(`
        SELECT t.id FROM tracks t
        WHERE NOT EXISTS (
          SELECT 1 FROM play_history ph
          WHERE ph.track_id = t.id AND ph.played_at >= ?
        )
      `).all(cutoff);
      return rows.map(r => r.id);
    }

    case 'loved': {
      const rows = db.prepare(`
        SELECT DISTINCT track_id AS id FROM loved_tracks WHERE score = 1
      `).all();
      return rows.map(r => r.id);
    }

    case 'disliked': {
      // Disliked is handled as an exclusion in generatePlaylist.
      // Returning empty here so it can also be previewed.
      const rows = db.prepare(`
        SELECT DISTINCT track_id AS id FROM loved_tracks WHERE score = -1
      `).all();
      return rows.map(r => r.id);
    }

    case 'top_artists': {
      const period = opts.period || 'overall';
      const source = opts.source || 'lastfm';
      // Get artist_ids ranked for this period, then fetch their tracks
      const artists = db.prepare(`
        SELECT artist_id FROM user_top_artists
        WHERE source = ? AND period = ?
        ORDER BY rank ASC
      `).all(source, period);
      if (!artists.length) return [];
      const artistIds    = artists.map(a => a.artist_id);
      const placeholders = artistIds.map(() => '?').join(', ');
      const rows = db.prepare(`
        SELECT id FROM tracks
        WHERE artist_id IN (${placeholders})
        ORDER BY play_count DESC
      `).all(...artistIds);
      return rows.map(r => r.id);
    }

    case 'unplayed': {
      const rows = db.prepare(`
        SELECT id FROM tracks WHERE play_count = 0 OR play_count IS NULL
      `).all();
      return rows.map(r => r.id);
    }

    case 'starred': {
      const rows = db.prepare(`
        SELECT id FROM tracks WHERE starred = 1
      `).all();
      return rows.map(r => r.id);
    }

    case 'highly_rated': {
      const minRating = opts.min_rating || 4;
      const rows = db.prepare(`
        SELECT id FROM tracks
        WHERE user_rating >= ?
        ORDER BY user_rating DESC
      `).all(minRating);
      return rows.map(r => r.id);
    }

    default:
      logger.warn('pl_engine', `unknown stats value: ${value}`);
      return [];
  }
}

/**
 * decade — filter by tracks.year
 * value: "1990s" | "1990" | "90s" — also accepts array for multiple decades (OR'd)
 */
function resolveDecade(db, rule) {
  const values  = Array.isArray(rule.value) ? rule.value : [rule.value];
  const results = new Set();
  for (const val of values) {
    const { start, end } = parseDecade(val);
    if (!start) { logger.warn('pl_engine', `could not parse decade: ${val}`); continue; }
    const rows = db.prepare(`
      SELECT id FROM tracks
      WHERE year >= ? AND year < ?
      ORDER BY year ASC
    `).all(start, end);
    rows.forEach(r => results.add(r.id));
  }
  return [...results];
}

/**
 * genre — matches the track's own genre tag. Tracks with no genre tag
 * fall back to their artist's tags (artist_tags: Last.fm + MusicBrainz), so
 * untagged files still match without pulling in an artist's off-genre songs.
 * options.match: 'and' (default) | 'or'.
 */
function resolveGenre(db, rule) {
  const tags    = (Array.isArray(rule.value) ? rule.value : [rule.value]).map(t => String(t).toLowerCase());
  const match   = rule.options?.match || 'and';
  const ph      = tags.map(() => '?').join(', ');
  const results = new Set();

  // 1. Track genre. The field holds a single genre, so AND with several tags can
  //    only test the first one here; the artist-tag fallback applies AND fully.
  const trackRows = match === 'or'
    ? db.prepare(`SELECT id FROM tracks WHERE LOWER(genre) IN (${ph})`).all(...tags)
    : db.prepare('SELECT id FROM tracks WHERE LOWER(genre) = ?').all(tags[0]);
  trackRows.forEach(r => results.add(r.id));

  // 2. Tracks without a genre tag: match on their artist's tags.
  const untagged   = "(t.genre IS NULL OR TRIM(t.genre) = '')";
  const artistRows = match === 'or'
    ? db.prepare(`
        SELECT DISTINCT t.id FROM tracks t
        JOIN artist_tags atags ON atags.artist_id = t.artist_id
        WHERE ${untagged} AND atags.tag IN (${ph})
      `).all(...tags)
    : db.prepare(`
        SELECT t.id FROM tracks t
        JOIN artist_tags atags ON atags.artist_id = t.artist_id
        WHERE ${untagged} AND atags.tag IN (${ph})
        GROUP BY t.id
        HAVING COUNT(DISTINCT atags.tag) >= ?
      `).all(...tags, tags.length);
  artistRows.forEach(r => results.add(r.id));

  return [...results];
}

/**
 * artist — tracks by the named artist. With options.similar (close | medium |
 * wide) the rule also takes that artist's 5 / 15 / 40 most similar artists that
 * are in the library — the "radio" option — from options.similar_source
 * (lastfm | listenbrainz; default Last.fm when a key is configured, else
 * ListenBrainz). Without it the rule is strict to the named artist. Similar
 * artists are fetched once per artist and source, then cached (lib/similar.js).
 */
async function resolveArtist(db, rule) {
  const name   = rule.value;
  const depth  = SIMILAR_DEPTHS[rule.options?.similar];

  // Find artist_id(s) matching the name
  const artistRows = db.prepare(`
    SELECT DISTINCT artist_id FROM tracks
    WHERE LOWER(artist) = LOWER(?)
  `).all(name);

  if (!artistRows.length) {
    logger.warn('pl_engine', `artist not found in library: "${name}"`);
    logger.debug('pl_engine', `resolveArtist: no rows in tracks for LOWER(artist) = LOWER('${name}')`);
    return [];
  }

  const artistIds = new Set(artistRows.map(r => r.artist_id));

  if (depth !== undefined) {
    const source = effectiveSource(db, rule.options?.similar_source);
    const seeds  = [...artistIds];
    await ensureSimilarArtists(db, seeds.map(artistId => ({ artistId, name })), source);
    for (const artistId of seeds) {
      const owned = [...new Set(getSimilarArtists(db, artistId, source).map(r => r.artistId))]
        .filter(id => !seeds.includes(id));
      owned.slice(0, depth).forEach(id => artistIds.add(id));
    }
  }

  const placeholders = [...artistIds].map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT id FROM tracks
    WHERE artist_id IN (${placeholders})
    ORDER BY play_count DESC
  `).all(...artistIds);

  return rows.map(r => r.id);
}

/**
 * mood — MusicBrainz mood tags
 * Phase 3: requires artist_tags table
 */
function resolveMood(db, rule) {
  // artist_tags table always exists (defined in schema); empty until Phase 3 sync runs.
  const mood = rule.value.toLowerCase();
  const rows = db.prepare(`
    SELECT DISTINCT t.id FROM tracks t
    JOIN artist_tags atags ON atags.artist_id = t.artist_id
    WHERE atags.tag = ?
      AND atags.source = 'musicbrainz'
      AND atags.tag != '__none__'
    ORDER BY atags.weight DESC
  `).all(mood);

  return rows.map(r => r.id);
}

// ── Shuffle ───────────────────────────────────────────────────────────────────

function fisherYates(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function parseDecade(value) {
  if (!value) return {};
  const str = String(value).trim();
  // "1990s", "1990", "90s"
  const full = str.match(/^(\d{4})s?$/);
  if (full) {
    const start = parseInt(full[1]);
    return { start, end: start + 10 };
  }
  const short = str.match(/^(\d{2})s$/);
  if (short) {
    const base  = parseInt(short[1]);
    const start = base >= 20 ? 1900 + base : 2000 + base; // 90s→1990, 10s→2010
    return { start, end: start + 10 };
  }
  return {};
}

function windowToCutoff(window) {
  const now = Math.floor(Date.now() / 1000);
  switch (window) {
    case 'week':        return now - 7   * 86400;
    case 'month':       return now - 30  * 86400;
    case 'quarter':     return now - 90  * 86400;
    case 'year':        return now - 365 * 86400;
    case 'all_time':    return 0;
    default:            return now - 30  * 86400;
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { generatePlaylist, resolveRule, validateRules, previewRules };
