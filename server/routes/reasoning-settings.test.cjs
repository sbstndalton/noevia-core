'use strict';
// The reasoning-settings mount over a fake response: every method is the Rust front's since #1071 (PUT) and
// #2384 (GET), so Node only refuses a bypass, reads and writes nothing, and keeps the words each refusal has.
// The GET's resolution is noevia-rs crates/server-reasoning-settings (differential over the pre-move route);
// how the provider will be asked is rust-reasoning-read-facts.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createReasoningSettingsRoutes, PUT_REFUSAL, GET_REFUSAL } = require('./reasoning-settings.cjs');

function fixture() {
  const sent = [];
  const routes = createReasoningSettingsRoutes({ json: (res, status, body) => { sent.push({ status, body }); } });
  const call = (method, path, body, search = '') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.method = method;
    return routes(req, {}, { path, authn: { user: { id: 'u1', role: 'admin' } }, url: new URL(`http://localhost${path}${search}`) });
  };
  return { call, sent };
}

test('every reasoning-settings request that reaches Node is refused: GET (#2384) and PUT (#1071); other verbs keep their 405', async () => {
  const f = fixture();
  assert.equal(await f.call('GET', '/api/reasoning-setting'), false, 'a look-alike path is not this mount\'s');
  assert.equal(f.sent.length, 0);
  for (const search of ['', '?projectId=p1', '?projectId=ghost', '?projectId=']) {
    assert.equal(await f.call('GET', '/api/reasoning-settings', undefined, search), true);
    assert.deepEqual(f.sent.pop(), { status: 503, body: GET_REFUSAL }, search);
  }
  // No role, body or leftover switch value gets a PUT past Node.
  for (const body of [{ default: 'low' }, '{', { default: 'max' }, undefined]) {
    await f.call('PUT', '/api/reasoning-settings', body);
    assert.deepEqual(f.sent.pop(), { status: 503, body: PUT_REFUSAL });
  }
  for (const method of ['DELETE', 'POST', 'PATCH', 'HEAD']) {
    await f.call(method, '/api/reasoning-settings');
    assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } }, method);
  }
  assert.deepEqual(GET_REFUSAL, { error: 'The Rust front owns the reasoning settings read.' });
  assert.deepEqual(PUT_REFUSAL, { error: 'Reasoning settings are owned by the Rust front.' });
});
