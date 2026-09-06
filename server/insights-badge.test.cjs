'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAuth } = require('./auth.cjs');
const { createSecretStore } = require('./secrets.cjs');

function request() { return { headers: { origin: 'https://cowork.example.test', 'user-agent': 'test' }, socket: { remoteAddress: '127.0.0.1' } }; }
function response() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; } }; }

async function bootUser(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-badge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secrets = createSecretStore(root);
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://cowork.example.test', rpId: 'cowork.example.test', secrets });
  const setupCode = fs.readFileSync(path.join(root, 'first-run-setup-code'), 'utf8').trim();
  const setup = await auth.setup(request(), response(), {
    setupCode, publicOrigin: 'https://cowork.example.test',
    username: 'Owner', displayName: 'Owner', password: 'correct horse battery staple', diaryEnabled: true,
  });
  assert.equal(setup.status, 201);
  return { auth, userId: setup.body.user.id, root };
}

test('insights badge defaults off and round-trips per user', async (t) => {
  const { auth, userId } = await bootUser(t);
  assert.equal(auth.insightsBadgeEnabled(userId), false, 'off by default — proactive surfacing is never assumed');
  assert.deepEqual(auth.setInsightsBadge(userId, true), { insightsBadge: true });
  assert.equal(auth.insightsBadgeEnabled(userId), true);
  assert.deepEqual(auth.setInsightsBadge(userId, false), { insightsBadge: false });
  assert.equal(auth.insightsBadgeEnabled(userId), false);
});

test('setting the badge never clobbers diary_enabled', async (t) => {
  const { auth, userId } = await bootUser(t);
  assert.equal(auth.diaryEnabled(userId), true);
  auth.setInsightsBadge(userId, true);
  assert.equal(auth.diaryEnabled(userId), true, 'badge write must preserve the diary flag');
  auth.setDiaryEnabled(userId, false);
  auth.setInsightsBadge(userId, true);
  assert.equal(auth.diaryEnabled(userId), false, 'badge write after diary disable must still preserve it');
});

test('seen marker starts null and persists once marked', async (t) => {
  const { auth, userId, root } = await bootUser(t);
  assert.equal(auth.insightsSeenAt(userId), null);
  auth.markInsightsSeen(userId);
  const first = auth.insightsSeenAt(userId);
  assert.ok(typeof first === 'number' && first > 0);
  // Survives a fresh open of the same data dir (durable, not in-memory).
  const secrets2 = createSecretStore(root);
  const auth2 = createAuth({ dataDir: root, publicOrigin: 'https://cowork.example.test', rpId: 'cowork.example.test', secrets: secrets2 });
  assert.equal(auth2.insightsSeenAt(userId), first);
  // Marking again advances it (monotonic enough for the badge comparison).
  const later = first + 1;
  const realNow = Date.now;
  Date.now = () => later;
  try { auth2.markInsightsSeen(userId); } finally { Date.now = realNow; }
  assert.equal(auth2.insightsSeenAt(userId), later);
});
