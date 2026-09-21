'use strict';
// The reasoning-settings route over a fake settings table: what a member reads, what only an
// administrator may change, and the words each refusal keeps. Resolution is reasoning-effort.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createReasoningSettingsRoutes } = require('./reasoning-settings.cjs');

function fixture() {
  const sent = [], audits = [];
  const settings = new Map();
  const routes = createReasoningSettingsRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    authService: {
      db: { prepare: (sql) => (sql.startsWith('SELECT') ? { get: () => (settings.has('d') ? { value: settings.get('d') } : undefined) } : { run: (v) => settings.set('d', v) }) },
      audit: (...args) => audits.push(args),
    },
    getProject: (id) => (id === 'p1' ? { id: 'p1', provider: 'mine', model: 'm', reasoningEffort: 'high' } : null),
    getProvider: (id) => ({ id }),
    reasoningEffort: { validEffort: (e) => ['default', 'low', 'high'].includes(e), resolveEffort: (project, fallback) => project?.reasoningEffort || fallback, modeFor: (provider, model, effort) => `${provider.id}:${model}:${effort}` },
    DEFAULT_PROVIDER_ID: 'default',
  });
  const call = (method, path, body, role = 'member', search = '') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.method = method;
    return routes(req, {}, { path, authn: { user: { id: 'u1', role } }, url: new URL(`http://localhost${path}${search}`) });
  };
  return { call, sent, audits, settings };
}

test('a member reads the default and a project resolution; only an admin changes the default', async () => {
  const f = fixture();
  assert.equal(await f.call('GET', '/api/reasoning-setting'), false);
  await f.call('GET', '/api/reasoning-settings');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { default: 'default', effort: 'default', mode: 'default::default', admin: false } });
  await f.call('GET', '/api/reasoning-settings', undefined, 'member', '?projectId=p1');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { default: 'default', effort: 'high', mode: 'mine:m:high', admin: false } });
  await f.call('GET', '/api/reasoning-settings', undefined, 'member', '?projectId=ghost');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'no such project' } });
  await f.call('PUT', '/api/reasoning-settings', { default: 'low' });
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'Administrator required' } });
  await f.call('PUT', '/api/reasoning-settings', '{', 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });
  await f.call('PUT', '/api/reasoning-settings', { default: 'max' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'default must be default, low or high' } });
  await f.call('PUT', '/api/reasoning-settings', { default: 'low' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { default: 'low' } });
  assert.deepEqual(f.audits, [['reasoning.default', 'u1', null, { effort: 'low' }]]);
  await f.call('GET', '/api/reasoning-settings', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { default: 'low', effort: 'low', mode: 'default::low', admin: true } });
  await f.call('DELETE', '/api/reasoning-settings');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
});
