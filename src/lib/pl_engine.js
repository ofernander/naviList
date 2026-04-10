'use strict';

/**
 * pl_engine.js — naviList Playlist Engine
 *
 * Single entry point for all smart playlist generation logic.
 * Design spec: MISC/pl_engine.md
 *
 * Exports:
 *   generatePlaylist(db, rules)  → Promise<string[]>   — full resolution to track ID list
 *   resolveRule(db, rule)        → Promise<string[]>   — single term → ranked track ID pool
 *   validateRules(rules)         → { ok, errors[] }    — validate rules JSON
 *   previewRules(db, rules)      → Promise<Object[]>   — per-rule count + sample, no full resolution
 */

const logger = require('../utils/logger');

// ── Constants ─────────────────────────────────────────────────────────────────

const SUPPORTED_TERMS = ['artist', 'tag', 'stats', 'decade', 'mood'];
const SUPPORTED_MODES = ['easy', 'medium', 'hard'];
const SUPPORTED_STATS = ['top_played', 'recently_played', 'not_recently_played', 'unplayed', 'starred', 'highly_rated', 'loved', 'disliked', 'top_artists'];
const DEFAULT_LIMIT   = 50;
const DEFAULT_MODE    = 'easy';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate a rules object. Returns { ok: bool, errors: string[] }.
 */
function validateRules(rules) {
  const errors = [];

  if (!rules || typeof rules !== 'object')       { return { ok: false, errors: ['rules must be an object'] }; }
  if (!Array.isArray(rules.rules))               { errors.push('rules.rules must be an array'); }
  if (rules.limit && typeof rules.limit !== 'number') { errors.push('rules.limit must be a number'); }

  (rules.rules || []).forEach((rule, i) => {
    if (!SUPPORTED_TERMS.includes(rule.term))    { errors.push(`rule[${i}]: unknown term "${rule.term}"`); }
    if (rule.value === undefined || rule.value === null) { errors.push(`rule[${i}]: value is required`); }
    if (rule.mode && !SUPPORTED_MODES.includes(rule.mode)) { errors.push(`rule[${i}]: unknown mode "${rule.mode}"`); }
    if (rule.weight !== undefined && (typeof rule.weight !== 'number' || rule.weight < 1)) {
      errors.push(`rule[${i}]: weight must be a positive integer`);
    }
  });

  return { ok: errors.length === 0, errors };
}

/**
 * Resolve a single rule to a ranked array of track IDs.
 * Mode slicing is applied here.
 */
async function resolveRule(db, rule) {
  const mode = rule.mode || DEFAULT_MODE;

  switch (rule.term) {
    case 'stats':   return resolveStats(db, rule, mode);
    case 'decade':  return resolveDecade(db, rule, mode);
    case 'tag':     return resolveTag(db, rule, mode);
    case 'artist':  return resolveArtist(db, rule, mode);
    case 'mood':    return resolveMood(db, rule, mode);
    default:
      logger.warn('pl_engine', `unknown term: ${rule.term}`);
      return [];
  }
}

/**
 * Generate a full playlist from a rules object.
 * Returns a deduplicated, interleaved, optionally shuffled array of track IDs.
 */
async function generatePlaylist(db, rules) {
  const validation = validateRules(rules);
  if (!validation.ok) {
    logger.error('pl_engine', `invalid rules: ${validation.errors.join(', ')}`);
    return [];
  }

  const limit        = rules.limit          ?? DEFAULT_LIMIT;
  const shuffle      = rules.shuffle        ?? true;
  const maxPerArtist = rules.max_per_artist ?? 5;

  // Resolve each rule to a pool
  const pools = await Promise.all(
    rules.rules.map(rule => resolveRule(db, rule).then(ids => {
      logger.debug('pl_engine', `rule [${rule.term}:${rule.value}] resolved ${ids.length} tracks`);
      return { rule, ids };
    }))
  );

  // Intersect all pools — a track must appear in every rule's pool to qualify.
  // With a single rule, intersection is a no-op (full pool passes through).
  const merged = intersect(pools);
  logger.debug('pl_engine', `intersect result: ${merged.length} tracks from ${pools.length} pool(s)`);

  // Shuffle to prevent artist clumping before truncating
  if (shuffle) fisherYates(merged);

  // Apply per-artist cap if set
  const capped = maxPerArtist ? capPerArtist(db, merged, maxPerArtist) : merged;

  // Apply disliked exclusion — remove any track the user has marked as disliked
  const dislikedSet = new Set(
    db.prepare('SELECT DISTINCT track_id FROM loved_tracks WHERE score = -1').all().map(r => r.track_id)
  );
  const filtered = dislikedSet.size > 0 ? capped.filter(id => !dislikedSet.has(id)) : capped;
  if (dislikedSet.size > 0) logger.info('pl_engine', `excluded ${capped.length - filtered.length} disliked tracks`);

  logger.info('pl_engine', `generated ${filtered.length} tracks from ${rules.rules.length} rules`);
  logger.debug('pl_engine', `limit: ${limit}, shuffle: ${shuffle}, maxPerArtist: ${maxPerArtist}, disliked excluded: ${capped.length - filtered.length}`);
  return filtered.slice(0, limit);
}

/**
 * Preview: resolve each rule and return per-rule metadata without full merging.
 * Useful for the UI to show "this rule would match N tracks" before committing.
 */
async function previewRules(db, rules) {
  const validation = validateRules(rules);
  if (!validation.ok) return rules.rules.map((r, i) => ({ rule: r, ok: false, error: validation.errors.filter(e => e.startsWith(`rule[${i}]`)).join(', ') }));

  return Promise.all(
    rules.rules.map(async rule => {
      const ids = await resolveRule(db, rule);
      return {
        rule,
        count:  ids.length,
        sample: ids.slice(0, 5)
      };
    })
  );
}

// ── Term resolvers ────────────────────────────────────────────────────────────

/**
 * stats — local play history and track metadata
 * values: top_played | recently_played | unplayed | starred | highly_rated
 */
function resolveStats(db, rule, mode) {
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
        return modeSlice(rows.map(r => r.id), mode);
      } else {
        // Default: Navidrome all-time play_count
        const rows = db.prepare(`
          SELECT id FROM tracks
          WHERE play_count > 0
          ORDER BY play_count DESC
        `).all();
        return modeSlice(rows.map(r => r.id), mode);
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
      return modeSlice(rows.map(r => r.track_id), mode);
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
      return modeSlice(rows.map(r => r.id), mode);
    }

    case 'unplayed': {
      const rows = db.prepare(`
        SELECT id FROM tracks WHERE play_count = 0 OR play_count IS NULL
      `).all();
      return rows.map(r => r.id); // unranked — mode has no effect
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
      return modeSlice(rows.map(r => r.id), mode);
    }

    default:
      logger.warn('pl_engine', `unknown stats value: ${value}`);
      return [];
  }
}

/**
 * decade — filter by tracks.year
 * value: "1990s" | "1990" | "90s"
 */
function resolveDecade(db, rule, _mode) {
  const { start, end } = parseDecade(rule.value);
  if (!start) {
    logger.warn('pl_engine', `could not parse decade: ${rule.value}`);
    return [];
  }
  const rows = db.prepare(`
    SELECT id FROM tracks
    WHERE year >= ? AND year < ?
    ORDER BY year ASC
  `).all(start, end);
  return rows.map(r => r.id);
}

/**
 * tag — genre/style matching
 * Phase 1: local tracks.genre only (easy mode)
 * Phase 3: artist_tags table for medium/hard
 */
function resolveTag(db, rule, mode) {
  const tags    = Array.isArray(rule.value) ? rule.value : [rule.value];
  const match   = rule.options?.match || 'and';
  const results = new Set();

  if (mode === 'easy') {
    // Local genre field only
    if (match === 'or') {
      const lowerTags    = tags.map(t => t.toLowerCase());
      const placeholders = lowerTags.map(() => '?').join(', ');
      const rows = db.prepare(`
        SELECT id FROM tracks WHERE LOWER(genre) IN (${placeholders})
      `).all(...lowerTags);
      rows.forEach(r => results.add(r.id));
    } else {
      // AND: track genre must match all tags — since tracks have one genre field,
      // AND with multiple tags on a single-value field only works for one tag.
      // For Phase 3 (artist_tags), proper AND across multi-tag rows will be implemented.
      const rows = db.prepare(`
        SELECT id FROM tracks WHERE LOWER(genre) = LOWER(?)
      `).all(tags[0]);
      rows.forEach(r => results.add(r.id));
      // Additional tags beyond first silently ignored in easy mode (single genre field)
    }
  } else {
    // medium / hard — query artist_tags table (Phase 3)
    // Tags are stored lowercase in artist_tags at sync time.
    const lowerTags = tags.map(t => t.toLowerCase());

    if (match === 'or') {
      const placeholders = lowerTags.map(() => '?').join(', ');
      const rows = db.prepare(`
        SELECT DISTINCT t.id FROM tracks t
        JOIN artist_tags atags ON atags.artist_id = t.artist_id
        WHERE atags.tag IN (${placeholders})
          AND atags.tag != '__none__'
        ORDER BY atags.weight DESC
      `).all(...lowerTags);
      rows.forEach(r => results.add(r.id));
    } else {
      // AND: artist must have ALL specified tags
      const placeholders = lowerTags.map(() => '?').join(', ');
      const rows = db.prepare(`
        SELECT DISTINCT t.id FROM tracks t
        JOIN artist_tags atags ON atags.artist_id = t.artist_id
        WHERE atags.tag IN (${placeholders})
          AND atags.tag != '__none__'
        GROUP BY t.id
        HAVING COUNT(DISTINCT atags.tag) >= ?
        ORDER BY MAX(atags.weight) DESC
      `).all(...lowerTags, lowerTags.length);
      rows.forEach(r => results.add(r.id));
    }
  }

  return [...results];
}

/**
 * artist — tracks by artist + similar artists
 * Phase 1: nosim only (local tracks table)
 * Phase 2: similar artists via artist_similar cache table
 */
async function resolveArtist(db, rule, mode) {
  const name   = rule.value;
  const nosim  = rule.options?.nosim || false;

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

  if (!nosim) {
    // Phase 2: expand with similar artists from artist_similar table.
    // Table always exists (defined in schema); empty until Phase 2 sync runs.
    for (const artistId of [...artistIds]) {
      const similar = db.prepare(`
        SELECT similar_artist_id FROM artist_similar
        WHERE artist_id = ? AND similar_artist_id IS NOT NULL
        ORDER BY score DESC
      `).all(artistId);
      const sliced = modeSlice(similar.map(r => r.similar_artist_id), mode);
      sliced.forEach(id => artistIds.add(id));
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
function resolveMood(db, rule, _mode) {
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

// ── Mode slicing ──────────────────────────────────────────────────────────────

/**
 * Slice a ranked array into easy / medium / hard thirds.
 * easy   → top third
 * medium → middle third
 * hard   → bottom third
 */
function modeSlice(ids, mode) {
  if (!ids.length) return [];
  const third = Math.ceil(ids.length / 3);
  switch (mode) {
    case 'easy':   return ids.slice(0, third);
    case 'medium': return ids.slice(third, third * 2);
    case 'hard':   return ids.slice(third * 2);
    default:       return ids.slice(0, third);
  }
}

// ── Intersection ─────────────────────────────────────────────────────────────

/**
 * Intersect pools — only keep track IDs present in every pool.
 * With a single pool, returns it unchanged.
 * Order is taken from the first pool (preserves ranking of the primary rule).
 */
function intersect(pools) {
  if (!pools.length) return [];
  if (pools.length === 1) return [...pools[0].ids];

  const sets = pools.slice(1).map(p => new Set(p.ids));
  return pools[0].ids.filter(id => sets.every(s => s.has(id)));
}

// ── Per-artist cap ───────────────────────────────────────────────────────────

/**
 * Cap the number of tracks per artist.
 * Looks up artist_id for each track ID and enforces the cap.
 * Prepared statement is created once outside the loop for performance.
 */
function capPerArtist(db, ids, max) {
  const counts    = new Map();
  const getArtist = db.prepare('SELECT artist_id FROM tracks WHERE id = ?');
  return ids.filter(id => {
    const row      = getArtist.get(id);
    const artistId = row?.artist_id || id;
    const count    = counts.get(artistId) || 0;
    if (count >= max) return false;
    counts.set(artistId, count + 1);
    return true;
  });
}

// ── Interleaving ──────────────────────────────────────────────────────────────

/**
 * Round-robin interleave pools by weight, deduplicate on the fly.
 * Each pool contributes in proportion to its weight.
 */
function interleave(pools, limit) {
  const seen   = new Set();
  const result = [];

  // Build weighted cursor list: [{ids, cursor}] repeated by weight
  const cursors = [];
  for (const { rule, ids } of pools) {
    const weight = rule.weight || 1;
    for (let w = 0; w < weight; w++) {
      cursors.push({ ids, cursor: 0 });
    }
  }

  let progress = true;
  while (result.length < limit && progress) {
    progress = false;
    for (const c of cursors) {
      if (result.length >= limit) break;
      // Advance cursor past already-seen IDs
      while (c.cursor < c.ids.length && seen.has(c.ids[c.cursor])) c.cursor++;
      if (c.cursor < c.ids.length) {
        const id = c.ids[c.cursor++];
        seen.add(id);
        result.push(id);
        progress = true;
      }
    }
  }

  return result;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

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

// ── Radio resolution ─────────────────────────────────────────────────────────

/**
 * resolveRadio — build a track pool from artist_similar cache for a given set of seed artist_ids.
 * Used for radio playlist regeneration (data was already seeded at creation time).
 * config: { artistIds: string[], depth: number, includeSeed: bool }
 */
function resolveRadio(db, config) {
  const { artistIds, depth = 0.25, includeSeed = true } = config;
  if (!artistIds?.length) return [];

  const allArtistIds = new Set();
  if (includeSeed) artistIds.forEach(id => allArtistIds.add(id));

  for (const artistId of artistIds) {
    const similar = db.prepare(`
      SELECT similar_artist_id FROM artist_similar
      WHERE artist_id = ?
        AND similar_artist_id IS NOT NULL
        AND score >= ?
        AND similar_name != '__none__'
      ORDER BY score DESC
    `).all(artistId, depth);
    similar.forEach(r => allArtistIds.add(r.similar_artist_id));
  }

  if (!allArtistIds.size) return [];

  const placeholders = [...allArtistIds].map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT id FROM tracks
    WHERE artist_id IN (${placeholders})
    ORDER BY play_count DESC
  `).all(...allArtistIds);

  return rows.map(r => r.id);
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { generatePlaylist, resolveRule, validateRules, previewRules, resolveRadio, fisherYates };
