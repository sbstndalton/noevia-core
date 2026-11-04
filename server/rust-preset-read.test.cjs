'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPresetStore } = require('./llamacpp-presets.cjs');
const { createPresetReadBridge, PATH } = require('./rust-preset-read-bridge.cjs');
const { refuseOwned } = require('./rust-preset-read.cjs');

async function call(manager, ask = { model: 'm' }, request = {}) {
  let result;
  const bridge = createPresetReadBridge({
    secret: 'test-secret',
    manager: () => manager,
    readJson: async () => ask,
    json: (_res, status, body) => { result = { status, body }; },
  });
  assert.equal(await bridge({
    url: PATH, method: 'POST', socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-noevia-store-token': 'test-secret' }, ...request,
  }, {}), true);
  return result;
}

test('exact GET refuses before Node route, other methods and paths stay available', () => {
  for (const [method, url, owns] of [
    ['GET', '/api/models/preset?model=m', true],
    ['PUT', '/api/models/preset', false],
    ['HEAD', '/api/models/preset', false],
    ['GET', '/api/models/preset/', false],
    ['GET', '/api/models/preset/suggest', false],
  ]) {
    let status;
    assert.equal(refuseOwned({ method, url }, {}, {
      parseRequestUrl: req => new URL(req.url, 'http://localhost'),
      json: (_res, s) => { status = s; },
    }), owns);
    assert.equal(status, owns ? 503 : undefined);
  }
});

test('facts use the conditional writer snapshot revision without exporting the file', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'models.ini');
  const text = '[*]\nparallel=2\n[m]\nc=4096\nmodel=/private/synthetic.gguf\n';
  fs.writeFileSync(file, text);
  const store = createPresetStore(file);
  const manager = { presetFacts: store.get };
  const { status, body } = await call(manager);
  assert.equal(status, 200);
  assert.equal(body.kind, 'preset');
  assert.equal(body.revision, store.snapshot().revision);
  assert.equal(body.exists, true);
  assert.deepEqual(body.options, { 'ctx-size': '4096' });
  assert.deepEqual(body.defaults, { parallel: '2' });
  assert.ok(body.fields.includes('ctx-size'));
  assert.equal(JSON.stringify(body).includes('/private/'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), text);

  const absent = await call(manager, { model: '' });
  assert.equal(absent.body.exists, false);
  assert.deepEqual(absent.body.options, {});
  assert.deepEqual(absent.body.defaults, body.defaults);

  fs.writeFileSync(file, '[m]\n[m]\n');
  assert.equal((await call(manager)).body.kind, 'duplicate');
  fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
  assert.equal((await call(manager)).body.kind, 'oversized');
  fs.unlinkSync(file);
  assert.equal((await call(manager)).body.kind, 'read-failed');
  fs.symlinkSync(path.join(dir, 'absent.ini'), file);
  assert.equal((await call(manager)).body.kind, 'nonregular');
});

test('bridge refuses nonfront requests and rejects extra input before touching state', async () => {
  const manager = { presetFacts: () => assert.fail('unexpected snapshot read') };
  for (const request of [
    { socket: { remoteAddress: '192.0.2.1' } },
    { headers: { 'x-noevia-store-token': 'wrong' } },
    { headers: { 'x-noevia-store-token': 'test-secret', 'x-forwarded-for': '' } },
    { headers: { 'x-noevia-store-token': 'test-secret', 'x-noevia-client-ip': '' } },
    { method: 'GET' },
  ]) assert.equal((await call(manager, undefined, request)).status, 404);
  assert.equal((await call(manager, { model: 'm', write: true })).status, 400);
  assert.deepEqual((await call({})).body, { kind: 'unavailable' });
  assert.deepEqual((await call({ presetFacts: () => null })).body, { kind: 'unconfigured' });
});
