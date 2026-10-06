'use strict';

/**
 * playlist_types.js — playlist type tags
 *
 * naviList marks the playlists it owns with a Navidrome comment of the form
 * `navilist:<type>` or `navilist:<type> <json config>`. The registry
 * (navilist_playlists.type / .config) is the source of truth; the comment is the
 * mirror Navidrome keeps, so a playlist can be recognised again after a DB reset.
 *
 * Playlists without a navilist comment (manual, or made outside naviList) have
 * type null and are never regenerated or studio-refined.
 */

const TYPES = {
  NAVILIST:        'navilist',          // rules engine
  RADIO:           'radio',             // legacy: seed artists + similar, now an artist rule option
  LB:              'lb',                // ListenBrainz subscription
  LB_SNAPSHOT:     'lb-snapshot',
  LASTFM:          'lastfm',            // Last.fm chart subscription
  LASTFM_SNAPSHOT: 'lastfm-snapshot',
  IMPORT:          'import',            // file import
  EXPORTIFY:       'exportify',         // legacy file import tag
};

// Types regenerated on their cron schedule by refresh.js.
const SCHEDULED_TYPES = new Set([TYPES.NAVILIST]);

const COMMENT_RE = /^navilist:([a-z-]+)(?:\s+(\{[\s\S]*\}))?\s*$/;

// Parse a Navidrome comment → { type, config }. Unknown or untagged → { type: null, config: null }.
function parseComment(comment) {
  const m = COMMENT_RE.exec(comment || '');
  if (!m) return { type: null, config: null };
  let config = null;
  if (m[2]) {
    try { config = JSON.parse(m[2]); } catch (e) { config = null; }
  }
  return { type: m[1], config };
}

// Build the Navidrome comment for a type + config. Untyped → null (no comment).
function buildComment(type, config) {
  if (!type) return null;
  return config ? `navilist:${type} ${JSON.stringify(config)}` : `navilist:${type}`;
}

// ── Rules config ──────────────────────────────────────────────────────────────

// How a rule is used: require (filter in), prefer (boost by weight), exclude (filter out).
const RULE_USES = ['require', 'prefer', 'exclude'];

// Rule terms renamed since they were first saved. Old playlists keep the old
// name in their stored config / Navidrome comment until next published.
const LEGACY_RULE_TERMS = { tag: 'genre' };

function canonicalTerm(term) { return LEGACY_RULE_TERMS[term] || term; }

// One rule in the current shape. Legacy rules stored `required: true|false`
// instead of `use` (false = prefer, anything else = require) and a `mode`
// (easy/medium/hard) that is no longer used. An explicit but invalid `use` is
// kept so validation rejects it.
function normalizeRule(r) {
  const { required, mode, ...rest } = r;
  const use = r.use !== undefined ? r.use : (required === false ? 'prefer' : 'require');
  return { ...rest, term: canonicalTerm(r.term), use };
}

// Settings no longer used at the config's top level (replaced by the even
// artist split and per-rule handling).
const LEGACY_CONFIG_KEYS = ['max_per_artist', 'mode'];

// A rules config with every rule in the current shape. Returns the same object
// when nothing needed changing.
function normalizeRules(rules) {
  if (!Array.isArray(rules?.rules)) return rules;
  const staleRule = r => LEGACY_RULE_TERMS[r.term] || r.use === undefined || 'required' in r || 'mode' in r;
  if (!rules.rules.some(staleRule) && !LEGACY_CONFIG_KEYS.some(k => k in rules)) return rules;
  const out = { ...rules, rules: rules.rules.map(normalizeRule) };
  for (const k of LEGACY_CONFIG_KEYS) delete out[k];
  return out;
}

// ── Similar artists (artist rule option) ──────────────────────────────────────

// Artist rule option `similar`: also take the N most similar artists that are
// in the library. Ranked, so a depth means the same for every source. Absent =
// artist only. `similar_source` picks the source (lastfm | listenbrainz).
const SIMILAR_DEPTHS  = { close: 5, medium: 15, wide: 40 };
const SIMILAR_SOURCES = ['lastfm', 'listenbrainz'];

// Depth name for a legacy radio similarity threshold (0.5 / 0.25 / 0.1).
const LEGACY_RADIO_DEPTHS = { close: 0.5, medium: 0.25, wide: 0.1 };
function depthName(depth) {
  const d = typeof depth === 'number' ? depth : 0.25;
  return Object.entries(LEGACY_RADIO_DEPTHS)
    .reduce((best, [name, v]) => Math.abs(v - d) < Math.abs(LEGACY_RADIO_DEPTHS[best] - d) ? name : best, 'medium');
}

// A legacy radio config ({ artists, depth, include_seed, track_count }) as the
// equivalent rules config: one artist rule per seed with similar expansion via
// Last.fm (radio's only source); "include seed artists" off becomes an excluded
// artist rule per seed.
function radioConfigToRules(config = {}) {
  const seeds   = (config.artists || []).filter(Boolean);
  const similar = depthName(config.depth);
  const rules   = seeds.map(name => ({ term: 'artist', value: name, use: 'require', options: { similar, similar_source: 'lastfm' } }));
  if (config.include_seed === false)
    seeds.forEach(name => rules.push({ term: 'artist', value: name, use: 'exclude', options: {} }));
  return { rules, limit: config.track_count || 50 };
}

// type/config with legacy types converted: radio → rules playlist.
function currentTypeConfig(type, config) {
  if (type === TYPES.RADIO) return { type: TYPES.NAVILIST, config: radioConfigToRules(config || {}) };
  if (type === TYPES.NAVILIST) return { type, config: normalizeRules(config) };
  return { type, config };
}

module.exports = {
  TYPES, SCHEDULED_TYPES, RULE_USES, SIMILAR_DEPTHS, SIMILAR_SOURCES,
  parseComment, buildComment, canonicalTerm, normalizeRules, radioConfigToRules, currentTypeConfig,
};
