'use strict';

// #1195: the header fetch tool's --mib argument. Only the parser is exercised: nothing is fetched, and
// requiring the tool does not run it (its main() is behind require.main).
const assert = require('node:assert/strict');
const test = require('node:test');

const { parseMib, MAX_MIB } = require('../../tools/fetch-real-gguf-headers.cjs');

test('--mib defaults to 32 when absent or empty', () => {
  assert.equal(parseMib(undefined), 32);
  assert.equal(parseMib(''), 32);
});

test('--mib takes a whole number of MiB from 1 to the maximum', () => {
  assert.equal(parseMib('1'), 1);
  assert.equal(parseMib('32'), 32);
  assert.equal(parseMib(String(MAX_MIB)), MAX_MIB);
});

test('--mib refuses NaN, fractions, zero, negatives and out-of-range values (never bytes=0-NaN)', () => {
  for (const bad of ['abc', 'NaN', '1.5', '0', '-1', String(MAX_MIB + 1), 'Infinity', '1e400']) {
    assert.throws(() => parseMib(bad), /--mib must be a whole number of MiB from 1 to 256/, bad);
  }
});
