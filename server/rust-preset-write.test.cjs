'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { OWNED_ROUTES, ROUTE_REFUSAL, refuseOwned } = require('./rust-preset-write.cjs');
const { createPresetWriteEffects, PATH } = require('./rust-preset-write-effects.cjs');
const parseRequestUrl = req => new URL(req.url, 'http://localhost');

test('exactly PUT /api/models/preset is refused before authentication; every other method and path stays Node\'s', () => {
  assert.deepEqual([...OWNED_ROUTES], ['PUT /api/models/preset']);
  for (const [method, url, owns] of [
    ['PUT', '/api/models/preset', true],
    ['PUT', '/api/models/preset?model=m', true],
    ['GET', '/api/models/preset', false],
    ['POST', '/api/models/preset', false],
    ['DELETE', '/api/models/preset', false],
    ['PUT', '/api/models/preset/', false],
    ['PUT', '/api/models/presets/reload', false],
    ['PUT', '/api/models/preset/suggest', false],
  ]) {
    let sent;
    assert.equal(refuseOwned({ method, url }, {}, { parseRequestUrl, json: (_res, status, body) => { sent = { status, body }; } }), owns, `${method} ${url}`);
    assert.deepEqual(sent, owns ? { status: 503, body: ROUTE_REFUSAL } : undefined, `${method} ${url}`);
  }
  assert.equal(ROUTE_REFUSAL.code, 'RUST_PRESET_EDITOR_OWNED');
});

test('the route block keeps only the administrator check and the 405 for other methods: the editor is not here', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, 'routes/models.cjs'), 'utf8');
  assert.doesNotMatch(source, /applyPreset/);
  assert.doesNotMatch(source, /modelManager\.applyPreset/);
  const manager = require('node:fs').readFileSync(require('node:path').join(__dirname, 'llamacpp-manager.cjs'), 'utf8');
  assert.doesNotMatch(manager, /\bapplyPreset\b/);
  assert.match(manager, /async function applyUnlocked\(/);
});

const request = (extra = {}) => ({ url: PATH, method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-noevia-store-token': 'secret' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from('{"op":"applied"}'); }, ...extra });

test('the cache drop is for the trusted front only and drops both model caches', async () => {
  const calls = [];
  let sent;
  const handle = createPresetWriteEffects({
    secret: 'secret',
    json: (_res, status, body) => { sent = { status, body }; },
    service: { modelScanCache: { clear: () => calls.push('scan') }, invalidateModelReads: () => calls.push('reads') },
  });
  assert.equal(await handle({ ...request(), url: '/other' }, {}), false);
  for (const bad of [
    { method: 'GET' },
    { headers: { 'x-noevia-store-token': 'wrong' } },
    { headers: {} },
    { socket: { remoteAddress: '10.0.0.5' } },
    { headers: { 'x-noevia-store-token': 'secret', 'x-forwarded-for': '1.2.3.4' } },
    { headers: { 'x-noevia-store-token': 'secret', 'x-noevia-client-ip': '1.2.3.4' } },
  ]) {
    sent = undefined;
    assert.equal(await handle(request(bad), {}), true);
    assert.deepEqual(sent, { status: 404, body: { error: 'Not found' } });
  }
  assert.deepEqual(calls, []);
  assert.equal(await handle(request(), {}), true);
  assert.deepEqual(sent, { status: 200, body: { ok: true } });
  assert.deepEqual(calls, ['scan', 'reads']);
});
