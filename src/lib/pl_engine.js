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
 *   generateRadio(db, config)    → Promise<string[]>   — radio: seeds + similar artists, shuffled
 */

const logger = require('../utils/logger');
const { finalize } = require('./finalize');
const { getSimilarArtists } = require('./similar');
const { RULE_USES, canonicalTerm, normalizeRules } = require('./playlist_types');

// ── Constants ─────────────────────────────────────────────────────────────────

const SUPPORTED_TERMS = ['artist', 'genre', 'stats', 'decade', 'mood'];
const SUPPORTED_STATS = ['top_played', 'recently_played', 'not_recently_played', 'unplayed', 'starred', 'highly_rated', 'loved', 'disliked', 'top_artists'];
// Stats values whose result is a meaningful best-first ranking.
const RANKED_STATS    = ['top_played', 'recently_played', 'top_artists', 'highly_rated'];
const DEFAULT_LIMIT   = 25;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate a rules object. Returns { ok: bool, errors: string[] }.
 */
function validateRules(rules) {
  const errors = [];

  if (!rules || typeof rules !== 'object')       { return { ok: false, errors: ['rules must be an object'] }; }
  rules = normalizeRules(rules);   // legacy term names / `required` flag
  if (!Array.isArray(rules.rules))               { errors.push('rules.rules must be an array'); }
  if (rules.limit && typeof rules.limit !== 'number') { errors.push('rules.limit must be a number'); }

  (rules.rules || []).forEach((rule, i) => {
    if (!SUPPORTED_TERMS.includes(canonicalTerm(rule.term))) { errors.push(`rule[${i}]: unknown term "${rule.term}"`); }
    if (rule.value === undefined || rule.value === null || rule.value === '') { errors.push(`rule[${i}]: value is required`); }
    if (rule.weight !== undefined && (typeof rule.weight !== 'number' || rule.weight < 1)) {
      errors.push(`rule[${i}]: weight must be a positive integer`);
    }
    if (!RULE_USES.includes(rule.use)) {
      errors.push(`rule[${i}]: use must be one of ${RULE_USES.join(' | ')}`);
    }
  });

  return { ok: errors.length === 0, errors };
}

/**
 * Resolve a single rule to an array of track IDs (best-first for ranked stats).
 * A legacy `mode` on old saved rules is ignored.
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
 * Generate a full playlist from a rules object.
 * Returns a deduplicated, interleaved, optionally shuffled array of track IDs.
 */
async function generatePlaylist(db, rules) {
  rules = normalizeRules(rules);   // legacy term names (tag → genre) and `required` → `use`
  const validation = validateRules(rules);
  if (!validation.ok) {
    logger.error('pl_engine', `invalid rules: ${validation.errors.join(', ')}`);
    return [];
  }

  const limit        = rules.limit          ?? DEFAULT_LIMIT;
  // Preserve rank ordering for a single ranked stats rule (e.g. top played) — the
  // limit then takes the top N. Every other playlist shuffles, so a single decade /
  // genre / artist rule doesn't return the same first-N tracks on every refresh.
  const only = rules.rules.length === 1 ? rules.rules[0] : null;
  const isSingleRankedRule = !!only && only.use === 'require' && only.term === 'stats' && RANKED_STATS.includes(only.value);
  const shuffle      = rules.shuffle === false ? false : !isSingleRankedRule;

  // Split into required (filter in), preferred (boost) and excluded (filter out) rules
  const requiredRules  = rules.rules.filter(r => r.use === 'require');
  const preferredRules = rules.rules.filter(r => r.use === 'prefer');
  const excludedRules  = rules.rules.filter(r => r.use === 'exclude');

  // Resolve required rules
  const resolvedRequired = await Promise.all(
    requiredRules.map(rule => resolveRule(db, rule).then(ids => {
      logger.debug('pl_engine', `required rule [${rule.term}:${rule.value}] resolved ${ids.length} tracks`);
      return { rule, ids };
    }))
  );

  // Group by term — union within group, intersect across groups
  const termGroups = new Map();
  for (const { rule, ids } of resolvedRequired) {
    if (!termGroups.has(rule.term)) termGroups.set(rule.term, new Set());
    ids.forEach(id => termGroups.get(rule.term).add(id));
  }
  logger.debug('pl_engine', `term groups: ${[...termGroups.entries()].map(([t, s]) => `${t}:${s.size}`).join(', ')}`);

  // Intersect across term groups — build sets once, not per-candidate
  const termArrays = [...termGroups.values()].map(s => [...s]);
  let merged;
  if (termArrays.length === 0) {
    merged = [];
  } else if (termArrays.length === 1) {
    merged = termArrays[0];
  } else {
    const otherSets = termArrays.slice(1).map(arr => new Set(arr));
    merged = termArrays[0].filter(id => otherSets.every(s => s.has(id)));
  }
  logger.debug('pl_engine', `intersect result: ${merged.length} tracks from ${termGroups.size} term group(s)`);

  // Excluded rules: any track they match is removed from the pool.
  if (excludedRules.length) {
    const excluded = new Set();
    for (const rule of excludedRules) {
      const ids = await resolveRule(db, rule);
      logger.debug('pl_engine', `excluded rule [${rule.term}:${rule.value}] resolved ${ids.length} tracks`);
      ids.forEach(id => excluded.add(id));
    }
    const before = merged.length;
    merged = merged.filter(id => !excluded.has(id));
    logger.info('pl_engine', `excluded ${before - merged.length} tracks by ${excludedRules.length} exclude rule(s)`);
  }

  if (!merged.length) {
    logger.info('pl_engine', 'no tracks matched required rules');
    return [];
  }

  // Score candidates against preferred rules
  let scored;
  if (preferredRules.length) {
    const resolvedPreferred = await Promise.all(
      preferredRules.map(rule => resolveRule(db, rule).then(ids => {
        logger.debug('pl_engine', `preferred rule [${rule.term}:${rule.value}] resolved ${ids.length} tracks`);
        return { rule, ids: new Set(ids) };
      }))
    );
    const scoreMap = new Map();
    for (const { rule, ids } of resolvedPreferred) {
      const weight = rule.weight || 1;
      for (const id of ids) {
        scoreMap.set(id, (scoreMap.get(id) || 0) + weight);
      }
    }
    // Sort by score descending, shuffle within equal-score tiers
    const buckets = new Map();
    for (const id of merged) {
      const score = scoreMap.get(id) || 0;
      if (!buckets.has(score)) buckets.set(score, []);
      buckets.get(score).push(id);
    }
    if (shuffle) buckets.forEach(bucket => fisherYates(bucket));
    scored = [...buckets.keys()].sort((a, b) => b - a).flatMap(s => buckets.get(s));
  } else {
    scored = merged;
    if (shuffle) fisherYates(scored);
  }

  // Shared finalize: disliked → studio collapse → even split by artist up to limit
  const finalIds = await finalize(db, scored, { limit, label: 'pl_engine' });

  logger.info('pl_engine', `generated ${finalIds.length} tracks — ${requiredRules.length} required, ${preferredRules.length} preferred, ${excludedRules.length} excluded rule(s)`);
  logger.debug('pl_engine', `limit: ${limit}, shuffle: ${shuffle}`);
  return finalIds;
}

/**
 * Preview: resolve each rule and return per-rule metadata without full merging.
 * Useful for the UI to show "this rule would match N tracks" before committing.
 */
async function previewRules(db, rules) {
  rules = normalizeRules(rules);
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
 * artist — tracks by the named artist only. Rules playlists are strict to the
 * rules the user sets; similar-artist expansion is radio's job (generateRadio).
 * options.nosim is accepted for old saved rules but no longer needed.
 */
async function resolveArtist(db, rule) {
  const name   = rule.value;

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

// ── Radio ───────────────────────────────────────────────────────────────────

/**
 * resolveRadio — candidate pool for a set of seed artist_ids: the seeds (unless
 * includeSeed is false) plus their cached similar artists scoring >= depth,
 * ordered by play count. Cache-only — the preview route fetches similar artists
 * for new seeds before calling this.
 */
function resolveRadio(db, { artistIds, depth = 0.25, includeSeed = true }) {
  if (!artistIds?.length) return [];

  const allArtistIds = new Set();
  if (includeSeed) artistIds.forEach(id => allArtistIds.add(id));
  for (const artistId of artistIds) {
    getSimilarArtists(db, artistId).filter(r => r.score >= depth).forEach(r => allArtistIds.add(r.artistId));
  }
  if (!allArtistIds.size) return [];

  const placeholders = [...allArtistIds].map(() => '?').join(', ');
  return db.prepare(`
    SELECT id FROM tracks
    WHERE artist_id IN (${placeholders})
    ORDER BY play_count DESC
  `).all(...allArtistIds).map(r => r.id);
}

/**
 * generateRadio — full radio track list from a saved radio config
 * ({ artistIds, depth, include_seed, track_count }):
 * pool → shuffle → shared finalize (disliked, studio, even split by artist, limit).
 */
async function generateRadio(db, config) {
  const pool = resolveRadio(db, {
    artistIds:   config.artistIds,
    depth:       config.depth ?? 0.25,
    includeSeed: config.include_seed ?? true,
  });
  fisherYates(pool);
  return finalize(db, pool, { limit: config.track_count || 50, label: 'radio' });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { generatePlaylist, resolveRule, validateRules, previewRules, generateRadio };
