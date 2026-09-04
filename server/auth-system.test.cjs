'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAuth } = require('./auth.cjs');
const { createSecretStore } = require('./secrets.cjs');
const { createWorkspaceStore } = require('./workspace.cjs');

function request() { return { headers: { origin: 'https://cowork.example.test', 'user-agent': 'test' }, socket: { remoteAddress: '127.0.0.1' } }; }
function response() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; } }; }

test('bootstrap, password login, invitations, and workspace isolation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-system-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secrets = createSecretStore(root);
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://cowork.example.test', rpId: 'cowork.example.test', secrets });
  const setupCode = fs.readFileSync(path.join(root, 'first-run-setup-code'), 'utf8').trim();
  const setupRes = response();
  const setup = await auth.setup(request(), setupRes, { setupCode, publicOrigin: 'https://cowork.example.test', username: 'Owner', displayName: 'Owner', password: 'correct horse battery staple' });
  assert.equal(setup.status, 201); assert.equal(setup.body.user.role, 'admin');
  assert.equal(fs.existsSync(path.join(root, 'first-run-setup-code')), false);
  assert.doesNotMatch(auth.db.prepare('SELECT password_hash FROM users').get().password_hash, /correct horse/);
  const login = await auth.passwordLogin(request(), response(), { username: 'owner', password: 'correct horse battery staple' });
  assert.equal(login.status, 200);
  const registration = await auth.registrationOptions(setup.body.user.id);
  assert.ok(registration.options.challenge); assert.ok(registration.challengeToken);

  const invitation = auth.createInvite(setup.body.user.id, 'member');
  const member = await auth.acceptInvite(request(), response(), { token: invitation.token, username: 'member', displayName: 'Member', password: 'another correct horse battery' });
  assert.equal(member.status, 201);
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '' }, secrets);
  const ownerSpace = store.get(setup.body.user.id); const memberSpace = store.get(member.body.user.id);
  ownerSpace.projects.push({ id: 'private-project', name: 'Private' }); ownerSpace.saveProjects();
  assert.equal(memberSpace.projects.length, 0);
  assert.notEqual(ownerSpace.dir, memberSpace.dir);
});

test('provider secrets are encrypted on disk and decrypt for their owner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-secrets-'));
  const secrets = createSecretStore(root); const id = '22222222-2222-4222-8222-222222222222';
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '' }, secrets);
  const workspace = store.get(id); workspace.providers.push({ id: 'private', label: 'Private', baseUrl: 'https://example.test/v1', apiKey: 'super-secret-key' }); workspace.saveProviders();
  const raw = fs.readFileSync(path.join(workspace.dir, 'providers.json'), 'utf8');
  assert.doesNotMatch(raw, /super-secret-key/); assert.match(raw, /enc:v1:/);
  fs.rmSync(root, { recursive: true, force: true });
});
