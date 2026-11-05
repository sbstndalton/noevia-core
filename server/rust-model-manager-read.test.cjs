'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { owned, refuseOwned } = require('./rust-model-manager-read.cjs');
test('ordinary manager GETs are refused before Node work; policy-bearing reads retain their owner', () => {
  for (const path of ['/api/model-manager/', '/api/model-manager/sections', '/api/model-manager/bad%2fpath', '/api/model-manager/benchmark/progress']) {
    assert.equal(owned('GET', path), true, path);
    const sent = [];
    assert.equal(refuseOwned({ method: 'GET', url: path }, {}, { parseRequestUrl: r => new URL(r.url, 'http://x'), json: (_, status, body) => sent.push({ status, body }) }), true);
    assert.equal(sent[0].status, 503);
    assert.equal(sent[0].body.code, 'RUST_MODEL_MANAGER_READ_OWNED');
  }
  for (const path of ['/api/model-manager', '/api/model-manager/models', '/api/model-manager/sections/sample/autoconfig', '/api/model-manager/sections/sample/%61utoconfig', '/api/model-manager/benchmark/runs/12']) assert.equal(owned('GET', path), false, path);
  assert.equal(owned('PUT', '/api/model-manager/sections/sample'), false);
  assert.equal(owned('HEAD', '/api/model-manager/sections'), false);
});
