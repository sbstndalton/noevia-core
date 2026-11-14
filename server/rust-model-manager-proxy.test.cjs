'use strict';
// Track R11: the /api/model-manager/* proxy is the Rust front's under NOEVIA_RUST_MODEL_MANAGER=rust; unset, Node answers it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { SWITCH, ROUTE_REFUSAL, frontOwns, owned, refuseOwned } = require('./rust-model-manager-proxy.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const ask = (method, url, env) => {
  const seen = [];
  const refused = refuseOwned({ method, url, headers: {} }, {}, { parseRequestUrl, json: (_, s, b) => seen.push([s, b]), env });
  return { refused, seen };
};
const PROXIED = [['GET', '/api/model-manager/benchmark/sweep'], ['POST', '/api/model-manager/benchmark/sweep/cancel'], ['POST', '/api/model-manager/benchmark/sweep%zz'], ['GET', '/api/model-manager/status'], ['PUT', '/api/model-manager/models-ini'], ['DELETE', '/api/model-manager/sections/qa'],
  ['POST', '/api/model-manager/sections/qa/rename'], ['POST', '/api/model-manager/models/delete'], ['POST', '/api/model-manager/benchmark/start'],
  ['GET', '/api/model-manager/benchmark/runs/3'], ['POST', '/api/model-manager/models'], ['GET', '/api/model-manager/sections/qa/autoconfig?x=1'],
  ['PATCH', '/api/model-manager/'], ['POST', '/api/model-manager/benchmark%2Fsweep'], ['POST', '/api/model-manager/benchmark%5Csweep'],
  ['HEAD', '/api/model-manager/models'], ['POST', '/api/model-manager/models']];

test('only the switch set to rust hands the proxy to the front', () => {
  assert.equal(SWITCH, 'NOEVIA_RUST_MODEL_MANAGER');
  for (const env of [{}, { [SWITCH]: '' }, { [SWITCH]: 'on' }, { [SWITCH]: 'Rust' }]) {
    assert.equal(frontOwns(env), false, JSON.stringify(env));
    for (const [m, p] of PROXIED) assert.deepEqual(ask(m, p, env), { refused: false, seen: [] }, `${m} ${p}`);
  }
  const env = { [SWITCH]: 'rust' };
  for (const [m, p] of PROXIED) assert.deepEqual(ask(m, p, env), { refused: true, seen: [[503, ROUTE_REFUSAL]] }, `${m} ${p}`);
  assert.equal(ROUTE_REFUSAL.code, 'RUST_MODEL_MANAGER_OWNED');
});

test('the sweep, the scan read and everything outside the prefix stay where they were', () => {
  const env = { [SWITCH]: 'rust' };
  for (const [m, p] of [['POST', '/api/model-manager/benchmark/sweep'], ['POST', '/api/model-manager/benchmark/sw%65ep'], ['POST', '/api/model-manager/%62enchmark/sweep'],
    ['GET', '/api/model-manager/models'], ['GET', '/api/model-manager'],
    ['GET', '/api/models/installed'], ['PUT', '/api/models/preset'], ['POST', '/api/model-managerx/status']]) {
    assert.equal(owned(m, p), false, `${m} ${p}`);
    assert.deepEqual(ask(m, p, env), { refused: false, seen: [] }, `${m} ${p}`);
  }
});

test('index.cjs mounts the refusal before the scan read refusal and the models routes', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const at = index.indexOf("require('./rust-model-manager-proxy.cjs').refuseOwned(req, res, { parseRequestUrl, json })");
  assert.ok(at > 0);
  assert.ok(at < index.indexOf("require('./rust-model-manager-scan.cjs').refuseOwned(req, res, { parseRequestUrl, json })"));
});
