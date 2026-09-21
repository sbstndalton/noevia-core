'use strict';
// The provider routes with a fake registry: masked listing, what a member may and may not
// register, the endpoint probe, and removal with the project fallback. The policy itself is
// ssrf.test.cjs; the real files are provider-migration.test.cjs and workspace-shared.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createProviderRoutes } = require('./providers.cjs');

function fixture({ probe = async () => ({ ok: true, status: 200, body: { data: [{ id: 'm-a' }, { id: 'm-b' }, {}] } }) } = {}) {
  const sent = [];
  const providers = [{ id: 'default', label: 'Local', baseUrl: 'http://engine', apiKey: 'local' }, { id: 'shared-1', label: 'Team', baseUrl: 'https://t.example', apiKey: 'sk-teamteam1234', shared: true }];
  const projects = [{ id: 'p1', provider: 'shared-1' }, { id: 'p2', provider: 'default' }];
  const saved = { private: 0, shared: 0, projects: 0 };
  const routes = createProviderRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    fetchJson: probe,
    endpointApproved: (authn, url) => authn.user.role === 'admin' || url.startsWith('https://approved.example'),
    PROVIDERS: providers, PROJECTS: projects, DEFAULT_PROVIDER_ID: 'default',
    modelManager: { enabled: true },
    currentWorkspace: () => ({ removeProvider: (id) => { const i = providers.findIndex((p) => p.id === id); if (i < 0) return false; providers.splice(i, 1); return true; } }),
    saveProjects: () => { saved.projects += 1; },
    registry: {
      saveProviders: () => { saved.private += 1; }, saveSharedProviders: () => { saved.shared += 1; },
      maskKey: (k) => (k && k !== 'local' ? `…${k.slice(-4)}` : null),
    },
  });
  const call = (method, path, body, role = 'member') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.method = method;
    return routes(req, {}, { path, authn: { user: { id: 'u1', role } } });
  };
  return { call, sent, providers, projects, saved };
}

test('other paths fall through; the listing masks keys and marks the managed default', async () => {
  const f = fixture();
  assert.equal(await f.call('GET', '/api/provider'), false);
  assert.equal(await f.call('PUT', '/api/providers'), false);
  assert.equal(await f.call('GET', '/api/providers'), true);
  const { status, body } = f.sent.pop();
  assert.equal(status, 200);
  assert.deepEqual(body.providers[0], { id: 'default', label: 'Local', baseUrl: 'http://engine', apiKeyMasked: null, isDefault: true, managed: true, shared: false, defaultModel: undefined });
  assert.equal(body.providers[1].apiKeyMasked, '…1234');
  assert.equal(body.providers[1].shared, true);
});

test('registering validates, guards the origin for members and saves to the right file', async () => {
  const f = fixture();
  await f.call('POST', '/api/providers', '{');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });
  await f.call('POST', '/api/providers', { label: 'x', baseUrl: 'https://approved.example', shared: true });
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'administrator required for shared providers' } });
  await f.call('POST', '/api/providers', { baseUrl: 'https://approved.example' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'label required' } });
  await f.call('POST', '/api/providers', { label: 'x', baseUrl: 'ftp://approved.example' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'baseUrl must be an http(s) URL' } });
  await f.call('POST', '/api/providers', { label: 'x', baseUrl: 'http://10.0.0.5:8080' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Provider origin is not approved for member connections; contact an administrator.' } });
  await f.call('POST', '/api/providers', { label: '  Mine ', baseUrl: 'https://approved.example/v1///', apiKey: ' sk-abcdef1234 ', defaultModel: 'm' });
  const reply = f.sent.pop();
  assert.equal(reply.status, 200);
  assert.match(reply.body.id, /^prov-/);
  assert.equal(reply.body.baseUrl, 'https://approved.example/v1');
  assert.equal(reply.body.apiKeyMasked, '…1234');
  assert.deepEqual(f.saved, { private: 1, shared: 0, projects: 0 });
  await f.call('POST', '/api/providers', { label: 'LAN', baseUrl: 'http://10.0.0.5:8080', shared: true }, 'admin');
  assert.equal(f.sent.pop().status, 200, 'an admin may register an internal endpoint and share it');
  assert.deepEqual(f.saved, { private: 1, shared: 1, projects: 0 });
  assert.equal(f.providers.at(-1).shared, true);
});

test('the probe applies the same origin guard and returns the model ids', async () => {
  const f = fixture();
  await f.call('POST', '/api/providers/test', { baseUrl: 'nope' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'valid baseUrl required' } });
  await f.call('POST', '/api/providers/test', { baseUrl: 'http://192.168.1.2' });
  assert.equal(f.sent.pop().status, 400);
  await f.call('POST', '/api/providers/test', { baseUrl: 'https://approved.example/v1' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true, models: ['m-a', 'm-b'] } });
  const down = fixture({ probe: async () => ({ ok: false, status: 503, body: '' }) });
  await down.call('POST', '/api/providers/test', { baseUrl: 'https://approved.example' });
  assert.deepEqual(down.sent.pop(), { status: 502, body: { error: 'provider returned 503' } });
  const broken = fixture({ probe: async () => { throw new Error('connect ECONNREFUSED'); } });
  await broken.call('POST', '/api/providers/test', { baseUrl: 'https://approved.example' });
  assert.deepEqual(broken.sent.pop(), { status: 502, body: { error: 'connect ECONNREFUSED' } });
});

test('removal protects the default, keeps shared rows for admins, and detaches projects', async () => {
  const f = fixture();
  await f.call('DELETE', '/api/providers/default');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'the default provider cannot be removed' } });
  await f.call('DELETE', '/api/providers/lemonade');
  assert.equal(f.sent.pop().status, 400);
  await f.call('DELETE', '/api/providers/shared-1');
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'administrator required' } });
  await f.call('DELETE', '/api/providers/ghost', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'no such provider' } });
  await f.call('DELETE', '/api/providers/shared-1', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.deepEqual(f.providers.map((p) => p.id), ['default']);
  assert.equal('provider' in f.projects[0], false, 'the project falls back to the default');
  assert.equal(f.projects[1].provider, 'default');
  assert.equal(f.saved.projects, 1);
});
