'use strict';

// #1195: the header fetch tool's --mib argument. Only the parser is exercised: nothing is fetched, and
// requiring the tool does not run it (its main() is behind require.main).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// The tool lives in tools/, which the web image build does not copy (only server/, tests/server and
// tests/fixtures): there the tests skip, as the fixture-generator checks do. Server tests run them.
const TOOL = path.join(__dirname, '../../tools/fetch-real-gguf-headers.cjs');
const skip = !fs.existsSync(TOOL) && 'no tools/ here';
const { parseMib, MAX_MIB } = skip ? {} : require(TOOL);

test('--mib defaults to 32 when absent or empty', { skip }, () => {
  assert.equal(parseMib(undefined), 32);
  assert.equal(parseMib(''), 32);
});

test('--mib takes a whole number of MiB from 1 to the maximum', { skip }, () => {
  assert.equal(parseMib('1'), 1);
  assert.equal(parseMib('32'), 32);
  assert.equal(parseMib(String(MAX_MIB)), MAX_MIB);
});

test('--mib refuses NaN, fractions, zero, negatives and out-of-range values (never bytes=0-NaN)', { skip }, () => {
  for (const bad of ['abc', 'NaN', '1.5', '0', '-1', String(MAX_MIB + 1), 'Infinity', '1e400']) {
    assert.throws(() => parseMib(bad), /--mib must be a whole number of MiB from 1 to 256/, bad);
  }
});
