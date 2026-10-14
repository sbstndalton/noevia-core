'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitIds, splitRecords, mulberry32 } = require('./split.cjs');

const rec = (id, over = {}) => ({ id, purpose: 'step.supervise', variant: 'base', lang: 'en', label: 'continue', body: {}, ...over });
function corpus() {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push(rec(`sup-en-c${i}`));
  for (let i = 0; i < 15; i++) rows.push(rec(`sup-en-e${i}`, { label: 'escalate' }));
  for (let i = 0; i < 10; i++) rows.push(rec(`route-de-${i}`, { purpose: 'model.route', lang: 'de', label: 'fast' }));
  for (let i = 0; i < 6; i++) rows.push(rec(`kind-${i}`, { purpose: 'chat.frame.kind', lang: ['nb', 'sv', 'it', 'pt', 'nl', 'fr'][i], label: 'idea' }));
  // Variants of a case follow it.
  rows.push(rec('route-de-0', { purpose: 'model.route', lang: 'de', label: 'fast', variant: 'nocode' }));
  rows.push(rec('sup-en-e0', { label: 'escalate', variant: 'perm1' }), rec('sup-en-e0', { label: 'escalate', variant: 'perm2' }));
  return rows;
}

test('the PRNG is fixed for a seed', () => {
  const a = mulberry32(1639), b = mulberry32(1639), c = mulberry32(1640);
  const xs = [a(), a(), a()];
  assert.deepEqual(xs, [b(), b(), b()]);
  assert.notDeepEqual(xs, [c(), c(), c()]);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('stratified by purpose, language and label: each stratum splits about 60/40, both sides get escalations', () => {
  const { tune, heldout, strata } = splitIds(corpus(), { seed: 1639 });
  assert.equal(tune.size + heldout.size, 61);
  assert.deepEqual(strata.find((x) => x.key === 'step.supervise|en|escalate'), { key: 'step.supervise|en|escalate', n: 15, tune: 9 });
  assert.deepEqual(strata.find((x) => x.key === 'step.supervise|en|continue'), { key: 'step.supervise|en|continue', n: 30, tune: 18 });
  assert.equal(strata.find((x) => x.key === 'model.route|de|fast').tune, 6);
  for (const id of tune) assert.ok(!heldout.has(id));
});

test('same seed, same split, whatever the input order; another seed differs', () => {
  const rows = corpus();
  const a = splitIds(rows, { seed: 1639 }), b = splitIds(rows.slice().reverse(), { seed: 1639 }), c = splitIds(rows, { seed: 7 });
  assert.deepEqual([...a.tune].sort(), [...b.tune].sort());
  assert.notDeepEqual([...a.tune].sort(), [...c.tune].sort());
});

test('every variant of a case lands with its case; a variant with no base is refused', () => {
  const s = splitRecords(corpus(), { seed: 1639 });
  for (const side of [s.tune, s.heldout]) {
    const ids = new Set(side.filter((r) => r.variant === 'base').map((r) => r.id));
    for (const r of side) assert.ok(ids.has(r.id), `${r.id}/${r.variant} away from its base`);
  }
  assert.equal(s.tune.length + s.heldout.length, corpus().length);
  assert.throws(() => splitRecords([...corpus(), rec('lost', { variant: 'perm1' })], { seed: 1639 }), /lost\/perm1: no base request/);
});

test('bad seed or fraction is refused', () => {
  assert.throws(() => splitIds(corpus(), { seed: 1.5 }), /seed/);
  assert.throws(() => splitIds(corpus(), { seed: 1, fraction: 1 }), /fraction/);
});
