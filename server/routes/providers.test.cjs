'use strict';
// The former provider mount is retired; a bypass is refused without touching runtime state.
const test = require('node:test');
const assert = require('node:assert/strict');
const boundary = require('../rust-residual-fallbacks.cjs');
const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
test('retired provider namespace refuses a bypass before identity and feature access', () => {
  for (const method of methods) for (const p of ['/api/providers/chatgpt', '/api/providers/chatgpt/', '/api/providers/chatgpt/grid-unmatched']) {
    let answer;
    const req = { method, url: p, get authn() { assert.fail('must not read identity'); } };
    assert.equal(boundary.refuseOwned(req, {}, { parseRequestUrl: (r) => new URL(r.url, 'http://synthetic.invalid'), json: (_, status, body) => { answer = { status, body }; } }), true);
    assert.deepEqual(answer, { status: 503, body: boundary.ROUTE_REFUSAL });
  }
});
test('substantive model methods and adjacent provider ids keep their existing owners', () => {
  for (const [method, p] of [['GET', '/api/models/installed'], ['GET', '/api/models/downloads'], ['GET', '/api/models/assignments'], ['POST', '/api/models/prune-missing'], ['GET', '/api/models/reranker'], ['PUT', '/api/models/reranker'], ['DELETE', '/api/models/reranker'], ['PUT', '/api/providers/grid-x'], ['GET', '/api/providers/chatgpt-sibling']]) assert.equal(boundary.owned(method, p), false, `${method} ${p}`);
  for (const [method, p] of [['HEAD', '/api/models/downloads'], ['POST', '/api/models/installed'], ['PUT', '/api/models/assignments'], ['GET', '/api/models/prune-missing'], ['POST', '/api/models/reranker']]) assert.equal(boundary.owned(method, p), true);
});
