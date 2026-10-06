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
  RADIO:           'radio',             // seed artists + similar
  LB:              'lb',                // ListenBrainz subscription
  LB_SNAPSHOT:     'lb-snapshot',
  LASTFM:          'lastfm',            // Last.fm chart subscription
  LASTFM_SNAPSHOT: 'lastfm-snapshot',
  IMPORT:          'import',            // file import
  EXPORTIFY:       'exportify',         // legacy file import tag
};

// Types regenerated on their cron schedule by refresh.js.
const SCHEDULED_TYPES = new Set([TYPES.NAVILIST, TYPES.RADIO]);

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

module.exports = { TYPES, SCHEDULED_TYPES, RULE_USES, parseComment, buildComment, canonicalTerm, normalizeRules };
