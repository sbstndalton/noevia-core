'use strict';
// #2210: the model maintenance routes the Rust front owns (noevia-rs bins/noevia-server model_maint,
// which replays this Core's own pre-move answers byte for byte, tests/model_reload.rs). Node refuses an
// owned (method, path) before authentication; every other method, every other model route and every
// other path shape still runs Node's ordinary chain.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { OWNED, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-model-maintenance.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const PAIRS = OWNED.map((o) => `${o.method} ${o.path}`);

test('the owned list is exactly the front\'s maintenance routes, by method and path', () => {
  assert.deepEqual(PAIRS, ['POST /api/models/presets/reload', 'GET /api/models/evidence', 'POST /api/models/evidence/import']);
  assert.ok(Object.isFrozen(OWNED) && OWNED.every((o) => Object.isFrozen(o)));
  assert.equal(ROUTE_REFUSAL.code, 'RUST_MODEL_MAINTENANCE_OWNED');
  for (const o of OWNED) {
    assert.equal(owned(o.method, o.path), true);
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'].filter((m) => m !== o.method)) assert.equal(owned(m, o.path), false, `${m} ${o.path}`);
  }
});

test('an owned request is refused with a 503 and its code, before the body is touched', () => {
  for (const o of OWNED) for (const suffix of ['', '?x=1']) {
    const req = { url: o.path + suffix, method: o.method, headers: { host: 'localhost' }, on() { throw new Error('body listener'); } };
    const res = {};
    assert.equal(refuseOwned(req, res, { parseRequestUrl, json }), true, o.path + suffix);
    assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
  }
});

test('what Node keeps is not refused: other methods, the other model routes, other path shapes', () => {
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
    assert.equal(refuseOwned({ url: '/api/models/presets/reload', method, headers: {} }, {}, { parseRequestUrl, json }), false, method);
  }
  for (const method of ['POST', 'HEAD', 'PUT', 'DELETE']) {
    assert.equal(refuseOwned({ url: '/api/models/evidence', method, headers: {} }, {}, { parseRequestUrl, json }), false, `${method} evidence`);
  }
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
    assert.equal(refuseOwned({ url: '/api/models/evidence/import', method, headers: {} }, {}, { parseRequestUrl, json }), false, `${method} import`);
  }
  for (const url of ['/api/models/presets/reload/', '/api/models/presets', '/api/models/preset', '/api/models/evidence/recheck', '/api/models/evidence/x', '/api/models/evidence/', '/api/models/calibration',
    '/api/models/load', '/api/models/presets/reloadx', '/API/MODELS/PRESETS/RELOAD', '/api/models/presets/%72eload', '/api/models/presets/reload/x']) {
    assert.equal(refuseOwned({ url, method: 'POST', headers: {} }, {}, { parseRequestUrl, json }), false, url);
  }
  assert.equal(refuseOwned({ url: '//[', method: 'POST', headers: {} }, {}, { parseRequestUrl, json }), false);
});

test('the dead Node reload handler is gone and the supervisor marker is in index.cjs', () => {
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'models.cjs'), 'utf8');
  assert.equal(routes.includes('Requests are in progress. Try again when chats finish.'), false);
  assert.equal(routes.includes('Could not reload model profiles.'), false);
  // The evidence read and the model-card import are gone from the routes; the recheck stays (it may load the model).
  assert.equal(routes.includes("p === '/api/models/evidence' && req.method === 'GET'"), false);
  assert.equal(routes.includes('importEvidence'), false);
  assert.ok(routes.includes("p === '/api/models/evidence/recheck'"));
  // And the manager writes no evidence itself: its producers queue for the front, the store's one writer.
  const manager = fs.readFileSync(path.join(__dirname, 'llamacpp-manager.cjs'), 'utf8');
  for (const writer of ['appendIfChanged', 'appendReportedRate', 'evidenceStore.append', 'createStore(evidenceDir)', 'importModelEvidence']) assert.equal(manager.includes(writer), false, writer);
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.ok(index.includes("require('./rust-model-maintenance.cjs').refuseOwned("), 'the supervisor marker');
});
