'use strict';

// #1671: a random WebAuthn id (16 or 32 random bytes, base64url) gets an id placeholder whatever its
// characters happen to be. It used to need a digit, so in roughly 2% of runs a digit-free id stayed
// literal, every later <id:N> shifted by one, and the double-recording identity check failed.
const assert = require('node:assert/strict');
const test = require('node:test');
const { createNormaliser } = require('../../server/contract-record.cjs');

function record(firstId) {
  const n = createNormaliser();
  return [
    n.value({ user: { id: firstId, name: 'synthetic-admin' } }),
    n.value({ id: 'proj-1791600933849-w10hvg' }),
  ];
}

test('a digit-free random id is still an id, so later ids keep their numbers', () => {
  const withDigit = record('Ab3dEfGhIjKlMnOpQrStUv');
  const noDigit = record('AbcdEfGhIjKlMnOpQrStUv');
  assert.deepEqual(noDigit, withDigit);
  assert.equal(noDigit[0].user.id, '<id:1>');
  assert.equal(noDigit[1].id, '<id:2>');
});

// Seeded, so this test cannot itself flake; 4000 ids include about 100 digit-free ones.
function seeded(seed) {
  let x = seed >>> 0 || 1;
  return (n) => Buffer.from(Array.from({ length: n }, () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x & 255; })).toString('base64url');
}

test('two recordings with forced-different random ids normalise identically', () => {
  const rand = seeded(1671);
  let digitFree = 0;
  for (let i = 0; i < 2000; i++) {
    const first = rand(16);
    if (!/\d/.test(first)) digitFree++;
    const a = record(first);
    const b = record(rand(i % 2 ? 32 : 16));
    assert.deepEqual(a, b, `run ${i}`);
  }
  assert.ok(digitFree > 10, `the seed must exercise digit-free ids (${digitFree})`);
});

test('words and camelCase names under id keys stay literal', () => {
  const n = createNormaliser();
  for (const word of ['default', 'general', 'synthetic-member-account', 'modelManagerSettings', 'reasoningDefault', 'systemOneRouting', 'browserPlaywright', 'constrainedPlanDecoding', 'nativeClientAuth', 'freeChats']) {
    assert.equal(n.value({ id: word }).id, word);
  }
});
