'use strict';
// Track R11: the inference budget and idle unload PUTs are the Rust front's under NOEVIA_RUST_MODEL_WRITES=rust; unset,
// Node answers them as before.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { SWITCH, OWNED_PATHS, OWNED_GETS, OWNED_POSTS, ROUTE_REFUSAL, frontOwns, owned, refuseOwned } = require('./rust-model-writes.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const ask = (method, url, env) => {
  const seen = [];
  const refused = refuseOwned({ method, url, headers: {} }, {}, { parseRequestUrl, json: (_, s, b) => seen.push([s, b]), env });
  return { refused, seen };
};

test('only the switch set to rust hands the three PUTs to the front', () => {
  assert.deepEqual([...OWNED_PATHS], ['/api/models/inference-budget', '/api/models/idle-unload', '/api/models/preset']);
  assert.equal(SWITCH, 'NOEVIA_RUST_MODEL_WRITES');
  for (const env of [{}, { [SWITCH]: '' }, { [SWITCH]: 'on' }, { [SWITCH]: 'Rust' }, { [SWITCH]: 'node' }]) {
    assert.equal(frontOwns(env), false, JSON.stringify(env));
    for (const p of OWNED_PATHS) assert.deepEqual(ask('PUT', p, env), { refused: false, seen: [] }, p);
  }
  const env = { [SWITCH]: 'rust' };
  assert.equal(frontOwns(env), true);
  for (const p of OWNED_PATHS) assert.deepEqual(ask('PUT', `${p}?x=1`, env), { refused: true, seen: [[503, ROUTE_REFUSAL]] }, p);
  assert.deepEqual([...OWNED_GETS], ['/api/models/mtp-artifact']);
  assert.deepEqual(ask('GET', '/api/models/mtp-artifact?repo=qa/x&variant=q', env), { refused: true, seen: [[503, ROUTE_REFUSAL]] });
  assert.deepEqual(ask('GET', '/api/models/mtp-artifact', {}), { refused: false, seen: [] });
  assert.deepEqual([...OWNED_POSTS], ['/api/models/pull']);
  assert.deepEqual(ask('POST', '/api/models/pull', env), { refused: true, seen: [[503, ROUTE_REFUSAL]] });
  assert.deepEqual(ask('POST', '/api/models/pull', {}), { refused: false, seen: [] });
  assert.equal(ROUTE_REFUSAL.code, 'RUST_MODEL_WRITES_OWNED');
});

test('everything beside the three PUTs stays where it was', () => {
  const env = { [SWITCH]: 'rust' };
  for (const [m, p] of [['GET', '/api/models/inference-budget'], ['POST', '/api/models/idle-unload'], ['GET', '/api/models/preset'], ['PUT', '/api/models/presets/reload'], ['GET', '/api/models/pull'], ['POST', '/api/models/pull/'], ['POST', '/api/models/mtp-artifact'], ['GET', '/api/models/mtp-artifact/'], ['GET', '/api/models/inference-budget'],
    ['PUT', '/api/models/inference-budget/'], ['PUT', '/api/model-manager/idle-unload'], ['DELETE', '/api/models/idle-unload']]) {
    assert.equal(owned(m, p), false, `${m} ${p}`);
    assert.deepEqual(ask(m, p, env), { refused: false, seen: [] }, `${m} ${p}`);
  }
});

test('index.cjs mounts the refusal before the idle unload read refusal and the models routes', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const at = index.indexOf("require('./rust-model-writes.cjs').refuseOwned(req, res, { parseRequestUrl, json })");
  assert.ok(at > 0);
  assert.ok(at < index.indexOf("require('./rust-idle-unload-read.cjs').refuseOwned(req, res, { parseRequestUrl, json })"));
});
