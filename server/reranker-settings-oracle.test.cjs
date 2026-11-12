'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test('reranker settings reference cases remain exact', () => {
  const actual = require('./reranker-settings-oracle.cjs').oracle();
  assert.equal(actual.length, 10);
  assert.deepEqual(actual, require('./fixtures/reranker-settings.json'));
});
