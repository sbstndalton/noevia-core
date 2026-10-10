'use strict';
// The sampling-settings route over a fake settings table: default-on, only an admin changes
// it, and the preset catalogue it returns. Selection logic is sampling-presets.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createSamplingSettingsRoutes } = require('./sampling-settings.cjs');
const { PRESETS, PRESETS_VERSION } = require('../sampling-presets.cjs');

function fixture() {
  const sent = [], audits = [];
  const settings = new Map();
  const routes = createSamplingSettingsRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    authService: {
      db: { prepare: () => ({ get: () => (settings.has('k') ? { value: settings.get('k') } : undefined), run: (_k, v) => settings.set('k', v) }) },
      audit: (...args) => audits.push(args),
    },
  });
  const call = (method, path, body, role = 'member') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.method = method;
    return routes(req, {}, { path, authn: { user: { id: 'u1', role } } });
  };
  return { call, sent, audits, settings };
}

test('defaults to enabled, exposes the preset catalogue, and only an admin may change it', async () => {
  const f = fixture();
  assert.equal(await f.call('GET', '/api/sampling-setting'), false);
  await f.call('GET', '/api/sampling-settings');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { enabled: true, presets: PRESETS, version: PRESETS_VERSION, admin: false } });

  await f.call('PUT', '/api/sampling-settings', { enabled: false });
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'Administrator required' } });

  await f.call('PUT', '/api/sampling-settings', '{', 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });

  await f.call('PUT', '/api/sampling-settings', { enabled: 'no' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'enabled must be true or false' } });

  await f.call('PUT', '/api/sampling-settings', { enabled: false }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { enabled: false } });
  assert.deepEqual(f.audits, [['sampling.autoPresets', 'u1', null, { enabled: false }]]);

  await f.call('GET', '/api/sampling-settings', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { enabled: false, presets: PRESETS, version: PRESETS_VERSION, admin: true } });

  await f.call('PUT', '/api/sampling-settings', { enabled: true }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { enabled: true } });
  await f.call('GET', '/api/sampling-settings');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { enabled: true, presets: PRESETS, version: PRESETS_VERSION, admin: false } });

  await f.call('DELETE', '/api/sampling-settings');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
});

// #1282: every valid JSON non-object shape returns validation, without writes or audit.
test('rejects null, arrays and scalar bodies without changing settings or audit', async () => {
  for (const raw of ['null', '[]', '[true]', '"text"', '0', 'false', '{}', '{"enabled":null}', '{"enabled":1}']) {
    const f = fixture();
    await f.call('PUT', '/api/sampling-settings', raw, 'admin');
    assert.deepEqual(f.sent, [{ status: 400, body: { error: 'enabled must be true or false' } }], raw);
    assert.equal(f.settings.size, 0, raw);
    assert.deepEqual(f.audits, [], raw);
  }
});

test('checks administrator before parsing null or malformed bodies', async () => {
  for (const raw of ['null', '{', '']) {
    const f = fixture();
    await f.call('PUT', '/api/sampling-settings', raw, 'member');
    assert.deepEqual(f.sent, [{ status: 403, body: { error: 'Administrator required' } }]);
    assert.equal(f.settings.size, 0);
    assert.deepEqual(f.audits, []);
  }
});
