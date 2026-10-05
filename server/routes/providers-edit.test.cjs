'use strict';
// PUT /api/providers/:id (#535): editing a provider in place. A fake registry covers the policy
// (who may edit which row, key kept vs replaced, the origin guard, contextTokens bounds); the last
// tests run the real workspace store so the edit is proven on disk, key encrypted, across a reload.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createProviderRoutes } = require('./providers.cjs');

const NOT_APPROVED = 'Provider origin is not approved for member connections; contact an administrator.';

function fixture({ probe = async () => ({ ok: true, status: 200, body: { data: [{ id: 'm-a' }] } }) } = {}) {
  const sent = [];
  const probes = [];
  const providers = [
    { id: 'default', label: 'Local', baseUrl: 'http://engine', apiKey: 'local' },
    { id: 'shared-1', label: 'Team', baseUrl: 'https://t.example', apiKey: 'sk-teamteam1234', shared: true },
    { id: 'mine', label: 'Mine', baseUrl: 'https://approved.example/v1', apiKey: 'sk-original-1111', defaultModel: 'm-old' },
    { id: 'chatgpt-oauth', label: 'ChatGPT', baseUrl: 'https://chatgpt.com/backend-api/codex', apiKey: '', kind: 'chatgpt-oauth', external: true },
  ];
  const projects = [{ id: 'p1', provider: 'mine', model: 'm-old' }];
  const saved = { private: 0, shared: 0, projects: 0 };
  const sharedIds = [];
  const routes = createProviderRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    fetchJson: async (url, init, ms) => { probes.push({ url, init }); return probe(url, init, ms); },
    endpointApproved: (authn, url) => authn.user.role === 'admin' || url.startsWith('https://approved.example') || url.startsWith('https://other-approved.example'),
    PROVIDERS: providers, PROJECTS: projects, DEFAULT_PROVIDER_ID: 'default',
    modelManager: { enabled: true },
    currentWorkspace: () => ({ removeProvider: () => false }),
    saveProjects: () => { saved.projects += 1; },
    registry: {
      saveProviders: () => { saved.private += 1; }, saveSharedProviders: (id) => { saved.shared += 1; sharedIds.push(id); },
      maskKey: (k) => (k && k !== 'local' ? `…${k.slice(-4)}` : null),
    },
  });
  const call = (method, p, body, role = 'member') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.method = method;
    return routes(req, {}, { path: p, authn: { user: { id: 'u1', role } } });
  };
  const mine = () => providers.find((p) => p.id === 'mine');
  return { call, sent, providers, projects, saved, probes, mine, sharedIds };
}

const full = (over = {}) => ({ label: 'Mine', baseUrl: 'https://approved.example/v1', apiKey: '', defaultModel: 'm-old', contextTokens: null, ...over });

test('a blank or missing key keeps the stored one; a typed key replaces it; the reply never carries it', async () => {
  const f = fixture();
  assert.equal(await f.call('PUT', '/api/providers/mine', full({ label: ' Renamed ', contextTokens: 131072 })), true);
  let reply = f.sent.pop();
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { id: 'mine', label: 'Renamed', baseUrl: 'https://approved.example/v1', apiKeyMasked: '…1111', isDefault: false, managed: false, shared: false, defaultModel: 'm-old', contextTokens: 131072 });
  assert.equal(f.mine().apiKey, 'sk-original-1111', 'empty apiKey keeps the stored key');
  const { apiKey: _omit, ...withoutKey } = full({ label: 'Renamed', contextTokens: 131072 });
  await f.call('PUT', '/api/providers/mine', withoutKey);
  assert.equal(f.sent.pop().status, 200);
  assert.equal(f.mine().apiKey, 'sk-original-1111', 'an omitted apiKey keeps the stored key');
  await f.call('PUT', '/api/providers/mine', full({ apiKey: '  sk-replaced-2222 ' }));
  reply = f.sent.pop();
  assert.equal(reply.status, 200);
  assert.equal(f.mine().apiKey, 'sk-replaced-2222');
  assert.equal(reply.body.apiKeyMasked, '…2222');
  assert.ok(!JSON.stringify(reply.body).includes('sk-replaced'), 'the plaintext key never goes back to the client');
  assert.equal(f.mine().contextTokens, undefined, 'a null contextTokens clears the setting');
  assert.deepEqual(f.saved, { private: 3, shared: 0, projects: 0 });
  assert.deepEqual(f.projects[0], { id: 'p1', provider: 'mine', model: 'm-old' }, 'projects keep their provider and model');
});

test('the listing returns contextTokens only when set', async () => {
  const f = fixture();
  await f.call('PUT', '/api/providers/mine', full({ contextTokens: 65536 }));
  f.sent.pop();
  await f.call('GET', '/api/providers');
  const { body } = f.sent.pop();
  assert.equal(body.providers.find((p) => p.id === 'mine').contextTokens, 65536);
  assert.equal('contextTokens' in body.providers.find((p) => p.id === 'shared-1'), false);
});

test('a member cannot edit a shared row; an admin can, and it saves to the shared file', async () => {
  const f = fixture();
  await f.call('PUT', '/api/providers/shared-1', { label: 'Hijacked', baseUrl: 'https://approved.example' });
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'administrator required' } });
  assert.equal(f.providers[1].label, 'Team');
  await f.call('PUT', '/api/providers/shared-1', { label: 'Team 2', baseUrl: 'https://t.example', contextTokens: 200000 }, 'admin');
  const reply = f.sent.pop();
  assert.equal(reply.status, 200);
  assert.equal(reply.body.shared, true);
  assert.equal(f.providers[1].label, 'Team 2');
  assert.equal(f.providers[1].apiKey, 'sk-teamteam1234');
  assert.deepEqual(f.saved, { private: 0, shared: 1, projects: 0 });
});

test('the default provider, its legacy alias and ChatGPT sign-in rows are not editable; unknown ids are 404', async () => {
  const f = fixture();
  for (const id of ['default', 'lemonade']) {
    await f.call('PUT', `/api/providers/${id}`, full(), 'admin');
    assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'the default provider cannot be edited' } });
  }
  await f.call('PUT', '/api/providers/chatgpt-oauth', full());
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'this provider is managed by its sign-in and cannot be edited' } });
  await f.call('PUT', '/api/providers/ghost', full(), 'admin');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'no such provider' } });
  assert.deepEqual(f.saved, { private: 0, shared: 0, projects: 0 });
  assert.equal(f.providers[3].baseUrl, 'https://chatgpt.com/backend-api/codex');
});

test('a changed baseUrl passes the same origin guard as POST, and a stored key never follows it to another origin', async () => {
  const f = fixture();
  await f.call('PUT', '/api/providers/mine', full({ baseUrl: 'http://10.0.0.5:8080' }));
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: NOT_APPROVED } });
  await f.call('PUT', '/api/providers/mine', full({ baseUrl: 'ftp://approved.example' }));
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'baseUrl must be an http(s) URL' } });
  await f.call('PUT', '/api/providers/mine', full({ baseUrl: 'https://other-approved.example/v1' }));
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Enter the API key again when moving a provider to a different address.' } });
  assert.equal(f.mine().baseUrl, 'https://approved.example/v1', 'a refused edit changes nothing');
  await f.call('PUT', '/api/providers/mine', full({ baseUrl: 'https://approved.example/openai/v1//' }));
  assert.equal(f.sent.pop().status, 200, 'a path change on the same origin keeps the key');
  assert.equal(f.mine().baseUrl, 'https://approved.example/openai/v1');
  assert.equal(f.mine().apiKey, 'sk-original-1111');
  await f.call('PUT', '/api/providers/mine', full({ baseUrl: 'https://other-approved.example/v1', apiKey: 'sk-new-3333' }));
  assert.equal(f.sent.pop().status, 200);
  assert.equal(f.mine().baseUrl, 'https://other-approved.example/v1');
  assert.equal(f.mine().apiKey, 'sk-new-3333');
  // Unchanged URL: no guard re-check, so an admin-approved internal origin stays editable.
  f.mine().baseUrl = 'http://10.0.0.9:8000/v1';
  await f.call('PUT', '/api/providers/mine', full({ baseUrl: 'http://10.0.0.9:8000/v1', label: 'Renamed' }));
  assert.equal(f.sent.pop().status, 200);
});

test('contextTokens must be a whole number from 2048 to 2000000; out of range is refused, not clamped', async () => {
  const f = fixture();
  for (const bad of [2047, 2000001, 4096.5, -1, 'lots', true, [8192], {}]) {
    await f.call('PUT', '/api/providers/mine', full({ contextTokens: bad }));
    assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'contextTokens must be a whole number from 2048 to 2000000' } }, String(bad));
  }
  assert.equal(f.saved.private, 0);
  for (const [value, stored] of [[2048, 2048], [2000000, 2000000], ['65536', 65536], ['', undefined]]) {
    f.mine().contextTokens = 1234567;
    await f.call('PUT', '/api/providers/mine', full({ contextTokens: value }));
    assert.equal(f.sent.pop().status, 200, String(value));
    assert.equal(f.mine().contextTokens, stored, String(value));
  }
  await f.call('POST', '/api/providers', { label: 'New', baseUrl: 'https://approved.example', contextTokens: 100 });
  assert.equal(f.sent.pop().status, 400, 'POST applies the same bounds');
  await f.call('POST', '/api/providers', { label: 'New', baseUrl: 'https://approved.example', contextTokens: 32768 });
  const created = f.sent.pop();
  assert.equal(created.status, 200);
  assert.equal(created.body.contextTokens, 32768);
  assert.equal(f.providers.at(-1).contextTokens, 32768);
});

test('invalid bodies are refused and leave the row untouched; fields cannot flip shared/kind/external', async () => {
  const f = fixture();
  await f.call('PUT', '/api/providers/mine', '{');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });
  await f.call('PUT', '/api/providers/mine', '[]');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });
  await f.call('PUT', '/api/providers/mine', full({ label: '   ' }));
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'label required' } });
  await f.call('PUT', '/api/providers/mine', full({ label: 'x'.repeat(200), defaultModel: 'm'.repeat(500), shared: true, kind: 'chatgpt-oauth', external: true, id: 'default' }));
  assert.equal(f.sent.pop().status, 200);
  const row = f.mine();
  assert.equal(row.label.length, 80);
  assert.equal(row.defaultModel.length, 200);
  assert.equal(row.shared, undefined);
  assert.equal(row.kind, undefined);
  assert.equal(row.external, undefined);
  assert.equal(row.id, 'mine');
});

test('the probe may use a stored key only for a row the caller can edit, on the same origin', async () => {
  const f = fixture();
  await f.call('POST', '/api/providers/test', { baseUrl: 'https://approved.example/openai/v1', providerId: 'mine' });
  assert.equal(f.probes.at(-1).init.headers.Authorization, 'Bearer sk-original-1111');
  await f.call('POST', '/api/providers/test', { baseUrl: 'https://other-approved.example/v1', providerId: 'mine' });
  assert.equal(f.probes.at(-1).init.headers.Authorization, undefined, 'another origin never receives the stored key');
  await f.call('POST', '/api/providers/test', { baseUrl: 'https://approved.example/v1', providerId: 'mine', apiKey: 'sk-typed' });
  assert.equal(f.probes.at(-1).init.headers.Authorization, 'Bearer sk-typed');
  f.providers[1].baseUrl = 'https://approved.example';
  await f.call('POST', '/api/providers/test', { baseUrl: 'https://approved.example', providerId: 'shared-1' });
  assert.equal(f.probes.at(-1).init.headers.Authorization, undefined, 'a member cannot borrow a shared key');
  await f.call('POST', '/api/providers/test', { baseUrl: 'https://approved.example', providerId: 'shared-1' }, 'admin');
  assert.equal(f.probes.at(-1).init.headers.Authorization, 'Bearer sk-teamteam1234');
});

// ── The real workspace store: the edit lands on disk, key encrypted, and survives a reload. ──
function realStack(t) {
  const { createWorkspaceStore } = require('../workspace.cjs');
  const { createSecretStore } = require('../secrets.cjs');
  const { createProviderRegistry } = require('../providers.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-provider-edit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secrets = createSecretStore(root);
  const defaultProvider = { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '' };
  let store = createWorkspaceStore(root, defaultProvider, secrets);
  let userId = 'aaaaaaaa-1111-4111-8111-111111111111';
  // Like index.cjs: one workspace per request (requestScope), re-read from the store for each call.
  let current = null;
  const ws = () => current;
  const PROVIDERS = new Proxy([], { get: (_, k) => { const a = ws().providers; const v = a[k]; return typeof v === 'function' ? v.bind(a) : v; } });
  const registry = createProviderRegistry({ currentWorkspace: ws, PROVIDERS, DEFAULT_PROVIDER_ID: 'default' });
  const sent = [];
  const routes = createProviderRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    fetchJson: async () => ({ ok: true, status: 200, body: { data: [] } }),
    endpointApproved: () => true,
    PROVIDERS, PROJECTS: [], DEFAULT_PROVIDER_ID: 'default', modelManager: { enabled: false },
    currentWorkspace: ws, saveProjects: () => {}, registry,
  });
  const call = (method, p, body, role) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    current = store.get(userId);
    return routes(req, {}, { path: p, authn: { user: { id: userId, role } } });
  };
  return {
    root, sent, call, ws: () => store.get(userId),
    as(id) { userId = id; },
    reload() { store = createWorkspaceStore(root, defaultProvider, secrets); },
  };
}

test('a private edit persists encrypted, keeps the key on a blank field, and survives a reload', async (t) => {
  const s = realStack(t);
  await s.call('POST', '/api/providers', { label: 'Synthetic', baseUrl: 'https://synthetic.example/v1', apiKey: 'sk-synthetic-aaaa' }, 'member');
  const id = s.sent.pop().body.id;
  await s.call('PUT', `/api/providers/${id}`, { label: 'Synthetic 2', baseUrl: 'https://synthetic.example/v1', apiKey: '', defaultModel: 'm', contextTokens: 131072 }, 'member');
  assert.equal(s.sent.pop().status, 200);
  const onDisk = fs.readFileSync(path.join(s.ws().dir, 'providers.json'), 'utf8');
  assert.ok(!onDisk.includes('sk-synthetic-aaaa'), 'the key stays encrypted at rest');
  s.reload();
  const row = s.ws().providers.find((p) => p.id === id);
  assert.equal(row.label, 'Synthetic 2');
  assert.equal(row.apiKey, 'sk-synthetic-aaaa');
  assert.equal(row.contextTokens, 131072);
});

test('an admin edit of a shared row lands in the shared file and another account sees it', async (t) => {
  const s = realStack(t);
  await s.call('POST', '/api/providers', { label: 'Team', baseUrl: 'https://team.example/v1', apiKey: 'sk-team-bbbb', shared: true }, 'admin');
  const id = s.sent.pop().body.id;
  await s.call('PUT', `/api/providers/${id}`, { label: 'Team (edited)', baseUrl: 'https://team.example/v1', contextTokens: 262144 }, 'admin');
  assert.equal(s.sent.pop().status, 200);
  s.as('bbbbbbbb-2222-4222-8222-222222222222');
  const seen = s.ws().providers.find((p) => p.id === id);
  assert.equal(seen.label, 'Team (edited)');
  assert.equal(seen.contextTokens, 262144);
  assert.equal(seen.apiKey, 'sk-team-bbbb');
  await s.call('PUT', `/api/providers/${id}`, { label: 'Member edit', baseUrl: 'https://team.example/v1' }, 'member');
  assert.equal(s.sent.pop().status, 403);
  assert.equal(s.ws().providers.find((p) => p.id === id).label, 'Team (edited)');
});

test('a PUT that omits contextTokens keeps the stored value; null clears it', async () => {
  const f = fixture();
  await f.call('PUT', '/api/providers/mine', full({ contextTokens: 65536 }));
  f.sent.pop();
  await f.call('PUT', '/api/providers/mine', { label: 'Only label' });
  assert.equal(f.sent.pop().status, 200);
  assert.equal(f.mine().contextTokens, 65536);
  await f.call('PUT', '/api/providers/mine', { contextTokens: null });
  f.sent.pop();
  assert.equal(f.mine().contextTokens, undefined);
});

test('non-string label, baseUrl, apiKey or defaultModel are refused and change nothing', async () => {
  const f = fixture();
  for (const field of ['label', 'baseUrl', 'apiKey', 'defaultModel']) {
    await f.call('PUT', '/api/providers/mine', full({ [field]: field === 'apiKey' ? 123 : { x: 1 } }));
    const reply = f.sent.pop();
    assert.equal(reply.status, 400, field);
    assert.match(reply.body.error, /must be a string/);
  }
  assert.equal(f.mine().apiKey, 'sk-original-1111');
  assert.equal(f.mine().label, 'Mine');
});

test('#785: a shared save names the one row it changed, so the store applies it by id', async () => {
  const f = fixture();
  await f.call('PUT', '/api/providers/shared-1', { label: 'Team renamed' }, 'admin');
  assert.equal(f.sent.pop().status, 200);
  await f.call('POST', '/api/providers', { label: 'Team two', baseUrl: 'https://team-two.example/v1', shared: true }, 'admin');
  const created = f.sent.pop();
  assert.equal(created.status, 200);
  assert.deepEqual(f.sharedIds, ['shared-1', created.body.id]);
});

test('#782: a row whose stored key could not be decrypted is listed for re-entry until a key is typed', async () => {
  const f = fixture();
  Object.assign(f.mine(), { apiKey: '', keyUnreadable: true });
  await f.call('GET', '/api/providers');
  assert.equal(f.sent.pop().body.providers.find((p) => p.id === 'mine').keyUnreadable, true);
  await f.call('PUT', '/api/providers/mine', full({ apiKey: 'sk-reentered-3333' }));
  const reply = f.sent.pop();
  assert.equal(reply.status, 200);
  assert.equal(reply.body.keyUnreadable, undefined);
  assert.equal(f.mine().keyUnreadable, undefined);
});

test('#782: an unreadable key stays with its origin; moving the row elsewhere without a new key forgets it', async (t) => {
  const s = realStack(t);
  const { createSecretStore } = require('../secrets.cjs');
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-other-key-'));
  const unreadable = createSecretStore(otherDir).encrypt('sk-synthetic-lost');
  fs.rmSync(otherDir, { recursive: true, force: true });
  const dir = s.ws().dir;
  s.reload();
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ providers: [
    { id: 'mine-lost', label: 'Lost', baseUrl: 'https://lost.example/v1', apiKey: unreadable },
  ] }));
  const stored = () => JSON.parse(fs.readFileSync(path.join(dir, 'providers.json'), 'utf8')).providers.find((p) => p.id === 'mine-lost');

  // Same origin, no key typed: the ciphertext is kept for a later key restore.
  await s.call('PUT', '/api/providers/mine-lost', { label: 'Lost (renamed)', baseUrl: 'https://lost.example/v2' }, 'member');
  assert.equal(s.sent.pop().status, 200);
  assert.equal(stored().apiKey, unreadable);

  // Another origin, no key typed: the old ciphertext must not follow the address.
  await s.call('PUT', '/api/providers/mine-lost', { label: 'Moved', baseUrl: 'https://elsewhere.example/v1' }, 'member');
  const reply = s.sent.pop();
  assert.equal(reply.status, 200);
  assert.equal(reply.body.keyUnreadable, undefined);
  assert.notEqual(stored().apiKey, unreadable);
  s.reload();
  const row = s.ws().providers.find((p) => p.id === 'mine-lost');
  assert.equal(row.apiKey, '');
  assert.equal(row.keyUnreadable, undefined, 'the moved row holds an empty, readable key');
});
