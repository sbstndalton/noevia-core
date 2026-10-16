'use strict';
// The reasoning-settings route over a fake settings table: what a member reads, what only an
// administrator may change (nothing: the PUT is the Rust front's since #1071), and the words each
// refusal keeps. Resolution is reasoning-effort.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createReasoningSettingsRoutes, PUT_REFUSAL } = require('./reasoning-settings.cjs');

function fixture() {
  const sent = [], audits = [];
  const settings = new Map();
  const routes = createReasoningSettingsRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    authService: {
      db: {
        transaction: (fn) => (...args) => {
          const before = new Map(settings), auditLength = audits.length;
          try { return fn(...args); } catch (error) {
            settings.clear();
            for (const [key, value] of before) settings.set(key, value);
            audits.length = auditLength;
            throw error;
          }
        },
        prepare: (sql) => (sql.startsWith('SELECT') ? { get: () => (settings.has('d') ? { value: settings.get('d') } : undefined) } : { run: (v) => settings.set('d', v) }) },
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

test('a member reads the default and a project resolution; every PUT is the Rust front\'s and refused (#1071)', async () => {
  const f = fixture();
  assert.equal(await f.call('GET', '/api/reasoning-setting'), false);
  await f.call('GET', '/api/reasoning-settings');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { default: 'default', effort: 'default', mode: 'default::default', admin: false } });
  await f.call('GET', '/api/reasoning-settings', undefined, 'member', '?projectId=p1');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { default: 'default', effort: 'high', mode: 'mine:m:high', admin: false } });
  await f.call('GET', '/api/reasoning-settings', undefined, 'member', '?projectId=ghost');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'no such project' } });
  // No role, body or leftover switch value gets a PUT past Node: nothing read, written or audited.
  for (const [body, role] of [[{ default: 'low' }, 'member'], ['{', 'admin'], [{ default: 'max' }, 'admin'], [{ default: 'low' }, 'admin']]) {
    await f.call('PUT', '/api/reasoning-settings', body, role);
    assert.deepEqual(f.sent.pop(), { status: 503, body: PUT_REFUSAL });
  }
  assert.deepEqual(f.audits, []);
  assert.equal(f.settings.size, 0);
  f.settings.set('d', 'low');
  await f.call('GET', '/api/reasoning-settings', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { default: 'low', effort: 'low', mode: 'default::low', admin: true } });
  await f.call('DELETE', '/api/reasoning-settings');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
});
