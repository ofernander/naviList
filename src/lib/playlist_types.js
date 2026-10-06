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
//
// v2 (current): the playlist is a set of BLOCKS, each a starting rule plus
// conditions that apply only to it; the playlist combines the blocks' tracks.
//   {
//     version: 2, limit: 50,
//     blocks: [{
//       rule:       { term, value, options },          // the block's starting point
//       conditions: [{ term, value, options, use }],   // use: require (Only) | exclude (Not)
//       share:      50                                  // optional — blocks split the limit evenly by default
//     }],
//     conditions: [ ... ]                               // apply to every block
//   }
// Inside a block the same condition term repeated means "either" (union);
// different terms narrow each other (intersection).
//
// v1 (legacy, flat): { rules: [{ term, value, use: require|prefer|exclude, weight }] }
// with older spellings (term `tag`, `required: bool`, `mode`, `max_per_artist`).
// normalizeRules converts v1 → v2; it is the only converter (startup migration,
// refresh, editing and saving all go through it).

const CONFIG_VERSION = 2;

// How a condition is used: require (Only matching tracks) or exclude (Not them).
const CONDITION_USES = ['require', 'exclude'];

// Rule terms renamed since they were first saved.
const LEGACY_RULE_TERMS = { tag: 'genre' };

function canonicalTerm(term) { return LEGACY_RULE_TERMS[term] || term; }

// A v1 rule in v1-current shape: legacy `required: true|false` → `use`, dead
// `mode` dropped, term renamed. An explicit but invalid `use` is kept so
// validation rejects it.
function normalizeV1Rule(r) {
  const { required, mode, ...rest } = r;
  const use = r.use !== undefined ? r.use : (required === false ? 'prefer' : 'require');
  return { ...rest, term: canonicalTerm(r.term), use };
}

// Options no longer used: `nosim` (artist rules are strict unless `similar` is set).
const LEGACY_OPTIONS = ['nosim'];
function cleanOptions(o) {
  const out = { ...(o || {}) };
  for (const k of LEGACY_OPTIONS) delete out[k];
  return out;
}

const headOf = r => ({ term: canonicalTerm(r.term), value: r.value, options: cleanOptions(r.options) });
const condOf = (r, use = r.use ?? 'require') => ({ term: canonicalTerm(r.term), value: r.value, options: cleanOptions(r.options), use });

// v1 flat rules → v2 blocks, keeping what the playlist produced:
// - required rules of the first rule's term become one block each (they were
//   "either" before); every other required rule and every excluded rule becomes
//   a condition on each block
// - preferred rules (boost within the same pool) become extra blocks — same
//   start + conditions plus the preferred rule — sharing half the playlist by
//   weight, so preferred tracks still take a larger slice
function v1ToBlocks(v1) {
  const rules = (v1.rules || []).map(normalizeV1Rule);
  const req   = rules.filter(r => r.use === 'require');
  const pref  = rules.filter(r => r.use === 'prefer');
  const excl  = rules.filter(r => r.use === 'exclude');
  const out   = { version: CONFIG_VERSION, limit: v1.limit, blocks: [], conditions: [] };
  if (!req.length) return out;

  const headTerm = req[0].term;
  const heads    = req.filter(r => r.term === headTerm);
  const base     = [...req.filter(r => r.term !== headTerm).map(r => condOf(r, 'require')), ...excl.map(r => condOf(r, 'exclude'))];
  const clone    = list => list.map(c => ({ ...c, options: { ...c.options } }));

  if (!pref.length) {
    out.blocks = heads.map(h => ({ rule: headOf(h), conditions: clone(base) }));
    return out;
  }
  const weightSum = pref.reduce((n, p) => n + (p.weight || 1), 0);
  for (const h of heads) {
    out.blocks.push({ rule: headOf(h), conditions: clone(base), share: round1(50 / heads.length) });
    for (const p of pref)
      out.blocks.push({ rule: headOf(h), conditions: [...clone(base), condOf(p, 'require')], share: round1(50 * (p.weight || 1) / weightSum / heads.length) });
  }
  return out;
}

function round1(n) { return Math.round(n * 10) / 10; }

// Block shares are strict percentages of the playlist. All blank = even split
// (the default). Set shares must total exactly 100% when every block has one,
// or stay under 100% so blank blocks split the rest. A single block's share is
// ignored. ±0.5% tolerates rounded conversions (e.g. 33.3 / 33.3 / 33.4).
// Returns null when fine, else a message for the user. (Mirrored in
// public/playlists.html for the live warning.)
const SHARE_TOLERANCE = 0.5;
function shareProblem(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 2) return null;
  const set = blocks.map(b => b.share).filter(s => typeof s === 'number');
  if (!set.length) return null;
  const total  = round1(set.reduce((n, s) => n + s, 0));
  const blanks = blocks.length - set.length;
  if (!blanks) {
    return Math.abs(total - 100) <= SHARE_TOLERANCE ? null
      : `Block shares add up to ${total}% — they need to total 100%.`;
  }
  return total < 100 - SHARE_TOLERANCE ? null
    : `Block shares add up to ${total}%, leaving nothing for the ${blanks === 1 ? 'block' : `${blanks} blocks`} without a share — keep the total under 100% or clear the shares.`;
}

const LEGACY_CONFIG_KEYS = ['rules', 'max_per_artist', 'mode', 'shuffle'];

// Any rules config (v1 or v2) as v2 with current term names. Malformed input is
// returned unchanged for validation to reject.
function normalizeRules(config) {
  if (!config || typeof config !== 'object') return config;
  if (!Array.isArray(config.blocks)) return Array.isArray(config.rules) ? v1ToBlocks(config) : config;
  const cond  = c => ({ ...c, term: canonicalTerm(c.term), options: cleanOptions(c.options), use: c.use ?? 'require' });
  const out   = { ...config, version: CONFIG_VERSION };
  for (const k of LEGACY_CONFIG_KEYS) delete out[k];
  out.blocks     = config.blocks.map(b => ({
    ...b,
    rule:       b.rule ? { ...b.rule, term: canonicalTerm(b.rule.term), options: cleanOptions(b.rule.options) } : b.rule,
    conditions: (b.conditions || []).map(cond),
  }));
  out.conditions = (config.conditions || []).map(cond);
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
// equivalent v1 rules config (normalizeRules then makes it v2): one artist rule per seed with similar expansion via
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

// type/config with legacy types converted: radio → rules playlist (v2).
function currentTypeConfig(type, config) {
  if (type === TYPES.RADIO) return { type: TYPES.NAVILIST, config: normalizeRules(radioConfigToRules(config || {})) };
  if (type === TYPES.NAVILIST) return { type, config: normalizeRules(config) };
  return { type, config };
}

module.exports = {
  TYPES, SCHEDULED_TYPES, CONDITION_USES, SIMILAR_DEPTHS, SIMILAR_SOURCES,
  parseComment, buildComment, canonicalTerm, normalizeRules, shareProblem, radioConfigToRules, currentTypeConfig,
};
