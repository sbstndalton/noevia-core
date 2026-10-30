'use strict';
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('../dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}
// The provider routes with a fake registry: masked listing, what a member may and may not
// register, the endpoint probe, and removal with the project fallback. The policy itself is
// ssrf.test.cjs; the real files are provider-migration.test.cjs and workspace-shared.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createProviderRoutes } = require('./providers.cjs');
const { createProviderRegistry } = require('../providers.cjs');

function fixture({ probe = async () => ({ ok: true, status: 200, body: { data: [{ id: 'm-a' }, { id: 'm-b' }, {}] } }), maskKey = (k) => (k && k !== 'local' ? `…${k.slice(-4)}` : null) } = {}) {
  const sent = [];
  const providers = [{ id: 'default', label: 'Local', baseUrl: 'http://engine', apiKey: 'local' }, { id: 'shared-1', label: 'Team', baseUrl: 'https://t.example', apiKey: 'sk-teamteam1234', shared: true }];
  const projects = [{ id: 'p1', provider: 'shared-1', model: 'shared-only-model' }, { id: 'p2', provider: 'default', model: 'local-model' }];
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
      maskKey,
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
  for (const body of ['null', '7', '[]']) {
    await f.call('POST', '/api/providers', body);
    assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'request body must be a JSON object' } }, `a ${body} body is the client's mistake (#796)`);
  }
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

test('sbstndalton/noevia#2190 round 4: the probe is the Rust front\'s; a bypass is refused before anything', async () => {
  // Its validation, origin guard, key reuse and failures are asserted in noevia-rs
  // tests/storage_integrations.rs (provider_test_probes_with_node_rules).
  const f = fixture({ probe: async () => assert.fail('a refused probe fetched') });
  await f.call('POST', '/api/providers/test', { baseUrl: 'https://approved.example/v1' });
  assert.deepEqual(f.sent.pop(), { status: 503, body: { error: 'The provider test is owned by the Rust front.', code: 'RUST_PROVIDER_TEST_OWNED' } });
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
  assert.equal('model' in f.projects[0], false, 'the removed provider model cannot be sent to the default');
  assert.equal(f.projects[1].provider, 'default');
  assert.equal(f.projects[1].model, 'local-model');
  assert.equal(f.saved.projects, 1);
});

test('the listing marks a provider on a trial-terms host (NVIDIA Build) as external, and only that one', async () => {
  const f = fixture();
  f.providers.push({ id: 'nv', label: 'NVIDIA Build (free trial)', baseUrl: 'https://integrate.api.nvidia.com/v1', apiKey: 'nvapi-synthetic0000' });
  await f.call('GET', '/api/providers');
  const { body } = f.sent.pop();
  assert.equal(body.providers.find((p) => p.id === 'nv').external, true);
  assert.equal(body.providers.find((p) => p.id === 'default').external, undefined);
  assert.equal(body.providers.find((p) => p.id === 'shared-1').external, undefined);
});

test('#1482: with the real masker, neither the listing nor a save reply carries more than the last four characters', async () => {
  const realMask = createProviderRegistry({ currentWorkspace: () => ({}), PROVIDERS: [], DEFAULT_PROVIDER_ID: 'default' }).maskKey;
  const f = fixture({ maskKey: realMask });
  f.providers.push({ id: 'nv', label: 'NVIDIA Build (free trial)', baseUrl: 'https://integrate.api.nvidia.com/v1', apiKey: 'nvapi-SYNTHETICKEYBODY0042' });
  await f.call('GET', '/api/providers');
  const listed = JSON.stringify(f.sent.pop().body);
  assert.ok(!listed.includes('nvapi'), 'the vendor prefix is not sent');
  assert.ok(!listed.includes('SYNTHETIC'), 'the key body is not sent');
  assert.ok(listed.includes('"apiKeyMasked":"…0042"'), 'the last four characters are');
  await f.call('POST', '/api/providers', { label: 'Mine', baseUrl: 'https://approved.example', apiKey: 'sk-proj-SYNTHETICBODYABCD9876' });
  const saved = f.sent.pop();
  assert.equal(saved.status, 200);
  const reply = JSON.stringify(saved.body);
  assert.ok(!reply.includes('sk-proj') && !reply.includes('SYNTHETIC'), 'the save reply carries no more than the masked form');
  assert.equal(saved.body.apiKeyMasked, '…9876');
});
