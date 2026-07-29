const test = require('node:test');
const assert = require('node:assert/strict');
const { matchLocal, matchLocalWithScore } = require('../src/lib/sync/helpers');

test('matchLocalWithScore returns a fuzzy candidate when exact match is absent', () => {
  const cache = new Map([
    ['metallica|||enter sandman', 42],
    ['lifehouse|||blind', 99],
  ]);

  const result = matchLocalWithScore('Metallica', 'Enter Sandman', cache);
  assert.ok(result);
  assert.equal(result.id, 42);
  assert.equal(result.exact, true);
  assert.equal(result.score, 100);
  assert.equal(matchLocal('Metallica', 'Enter Sandman', cache), 42);
});

test('matchLocalWithScore surfaces a partial-artist fuzzy match for Flo Rida', () => {
  const cache = new Map([
    ['flo rida and t pain|||low', 123],
  ]);

  const result = matchLocalWithScore('Flo Rida', 'Low', cache);
  assert.ok(result);
  assert.equal(result.id, 123);
  assert.equal(result.exact, false);
  assert.ok(result.score >= 70);
});

test('matchLocalWithScore returns null for weak fuzzy matches', () => {
  const cache = new Map([
    ['some unrelated artist|||some other title', 7],
  ]);

  assert.equal(matchLocalWithScore('Totally', 'Different', cache), null);
  assert.equal(matchLocal('Totally', 'Different', cache), null);
});
