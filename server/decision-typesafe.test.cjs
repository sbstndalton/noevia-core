'use strict';
// #1639: production's TypeSafe codec reads every answer as the eval adapter that measured Kev-0.8B did.
const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('./decision-typesafe.cjs');
const adapter = require('../tools/decision-eval/adapter.cjs');

const body = { state: 'synthetic state', question: 'Synthetic question?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] };

test('the request is the adapter\'s, byte for byte', () => {
  assert.equal(JSON.stringify(ts.toTypeSafe(body, 'ollaya.dev/library/kev:0.8b')), JSON.stringify(adapter.toTypeSafe(body, 'ollaya.dev/library/kev:0.8b')));
});

test('seeded answers: the same selection and scores, or both refuse', () => {
  let seed = 1639;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let refused = 0;
  for (let n = 0; n < 2000; n++) {
    const pick = rand();
    const probs = pick < 0.05 ? { a: 0.5, b: 0.5, c: 0 } : pick < 0.08 ? { a: 0.4, b: 0.6 } : pick < 0.1 ? { a: -0.1, b: 0.6, c: 0.5 }
      : Object.fromEntries(['a', 'b', 'c'].map((id) => [id, Math.round(rand() * 10000) / 10000]));
    const json = { answers: { d: { type: 'choice', probabilities: probs } } };
    let mine = null, theirs = null;
    try { mine = ts.fromTypeSafe(json, ['a', 'b', 'c']); } catch (e) { assert.equal(e.reason, 'invalid-result'); }
    try { const r = adapter.fromTypeSafe(json, body, 'kev'); theirs = { selected: r.selected, scores: r.scores }; } catch { /* refused */ }
    assert.deepEqual(mine, theirs, JSON.stringify(probs));
    if (!mine) refused++;
  }
  assert.ok(refused > 50 && refused < 400, `${refused} refused`);
});
