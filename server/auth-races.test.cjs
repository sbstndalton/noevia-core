'use strict';
// Bug hunt (area b): one-time secrets are single-use even when two requests race through the
// asynchronous password hashing that sits between the check and the insert.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAuth } = require('./auth.cjs');

const request = (ip) => ({ headers: { origin: 'https://cowork.example.test', 'user-agent': 'test' }, socket: { remoteAddress: ip } });
const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });
function fresh(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-races-'));
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://cowork.example.test' });
  t.after(() => { auth.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { auth, code: fs.readFileSync(path.join(root, 'first-run-setup-code'), 'utf8').trim() };
}

test('two simultaneous accepts of one invitation create one account', async (t) => {
  const { auth, code } = fresh(t);
  const admin = await auth.setup(request('10.0.0.1'), response(), { setupCode: code, publicOrigin: 'https://cowork.example.test', username: 'owner', password: 'synthetic owner password' });
  const { token } = auth.createInvite(admin.body.user.id, 'admin');
  const results = await Promise.all(['alpha', 'bravo'].map((username, i) =>
    auth.acceptInvite(request(`10.0.1.${i}`), response(), { token, username, password: 'synthetic invite password' })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 400]);
  assert.equal(auth.listUsers().length, 2, 'owner plus exactly one invited account');
});

test('two simultaneous first-run setups create one administrator', async (t) => {
  const { auth, code } = fresh(t);
  const results = await Promise.all(['first', 'second'].map((username, i) =>
    auth.setup(request(`10.0.2.${i}`), response(), { setupCode: code, publicOrigin: 'https://cowork.example.test', username, password: 'synthetic setup password' })));
  assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(auth.listUsers().length, 1);
});

test('a recovery link sets one password even when used twice at once', async (t) => {
  const { auth, code } = fresh(t);
  const admin = await auth.setup(request('10.0.3.1'), response(), { setupCode: code, publicOrigin: 'https://cowork.example.test', username: 'owner', password: 'synthetic owner password' });
  const { token } = auth.createRecovery(admin.body.user.id, admin.body.user.id);
  const results = await Promise.all(['synthetic new password one', 'synthetic new password two'].map((password) => auth.completeRecovery({ token, password })));
  assert.deepEqual(results.sort(), [false, true]);
});
