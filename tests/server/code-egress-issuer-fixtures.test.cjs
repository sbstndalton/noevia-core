'use strict';
// Row V: the differential fixtures (committed in noevia-rs crates/egress-issuer/tests/fixtures/oracle.json) come
// from the frozen Node oracle and must be reproducible byte for byte: the generator is deterministic.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), { execFileSync } = require('node:child_process');
const GEN = path.join(__dirname, '..', 'reference', 'code-egress-issuer-fixtures.cjs');
test('the oracle fixture generator is deterministic and covers grant, rotation, lost revoke and held grants', () => {
  const run = () => execFileSync(process.execPath, [GEN], { encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH } });
  const a = run(), b = run(); assert.equal(a, b);
  const doc = JSON.parse(a); assert.equal(doc.version, 1);
  const names = doc.scenarios.map((s) => s.name).join('\n');
  for (const want of ['basic grant', 'lost revoke', 'rotation', 'zero and negative', 'restarted proxy', 'same-task grants']) assert.match(names, new RegExp(want));
  const rotation = doc.scenarios.find((s) => s.name.startsWith('rotation'));
  const keys = rotation.steps.filter((s) => s.op === 'keyFile').map((s) => s.result.ok);
  assert.equal(keys.length, 2); assert.notEqual(keys[0].hex, keys[1].hex, 'the key rotated'); assert.ok(keys.every((k) => k.mode === '440'));
  assert.ok(!/ngr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(JSON.stringify(doc.scenarios.map((s) => s.initialKeyHex))) );
});
