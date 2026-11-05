'use strict';
// The public auto-tune routes (status GET, settings, resume, cancel, clear) are the Rust front's, and so is
// the state behind them (noevia-rs autotune_state.rs). Node refuses them directly; start/POST status and
// every neighbouring path stay Node's.
const test = require('node:test'), assert = require('node:assert/strict');
const parseRequestUrl = r => new URL(r.url, 'http://synthetic');
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'];

for (const [name, path, neighbours] of [
  ['settings', '/api/models/autotune/settings', ['/api/models/autotune', '/api/models/autotune/settings/', '/api/models/autotune/settingsx']],
  ['resume', '/api/models/autotune/resume', ['/api/models/autotune/resume/', '/api/models/autotune/resumed']],
  ['clear', '/api/models/autotune/clear', ['/api/models/autotune/clear/', '/api/models/autotune/cleared']],
  ['cancel', '/api/models/autotune/cancel', ['/api/models/autotune', '/api/models/autotune/cancel/', '/api/models/autotune/cancelled']],
]) {
  test(`${name}: every method on the exact path is refused in Node, neighbours stay separate`, () => {
    const { refuseOwned, ROUTE_REFUSAL } = require(`./rust-autotune-${name}.cjs`);
    for (const method of METHODS) {
      const sent = [];
      assert.equal(refuseOwned({ method, url: path + '?model=x' }, {}, { parseRequestUrl, json: (_r, status, body) => sent.push({ status, body }) }), true);
      assert.deepEqual(sent, [{ status: 503, body: ROUTE_REFUSAL }]);
    }
    for (const url of neighbours) assert.equal(refuseOwned({ method: 'GET', url }, {}, { parseRequestUrl, json: () => assert.fail('neighbour') }), false);
  });
}

test('status: only GET is refused in Node; start (POST) and the other methods keep Node ownership', () => {
  const { refuseOwned } = require('./rust-autotune-read.cjs');
  let status;
  assert.equal(refuseOwned({ method: 'GET', url: '/api/models/autotune?model=m' }, {}, { parseRequestUrl, json: (_r, s) => { status = s; } }), true);
  assert.equal(status, 503);
  for (const method of ['POST', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal(refuseOwned({ method, url: '/api/models/autotune' }, {}, { parseRequestUrl, json: () => assert.fail('method stolen') }), false);
  for (const url of ['/api/models/autotune/', '/api/models/autotune/resume', '/api/models/autotune-other']) assert.equal(refuseOwned({ method: 'GET', url }, {}, { parseRequestUrl, json: () => assert.fail('neighbour') }), false);
});

test('the retired state bridges are gone: no module answers /internal/autotune-{read,settings,resume,cancel,clear}', () => {
  const fs = require('node:fs'), path = require('node:path');
  for (const name of ['read', 'settings', 'resume', 'cancel', 'clear']) assert.equal(fs.existsSync(path.join(__dirname, `rust-autotune-${name}-bridge.cjs`)), false, name);
});
