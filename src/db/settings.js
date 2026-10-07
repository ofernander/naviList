'use strict';

// Settings accessor — the one place that turns the key/value settings table
// into a plain object.

function getSettings(db) {
  const s = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(r => { s[r.key] = r.value; });
  return s;
}

module.exports = { getSettings };
