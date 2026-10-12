'use strict';
// #1483: Security and login listed sessions last seen five weeks ago with no expiry. A session
// past its absolute limit or idle longer than the idle limit can never sign anyone in, so the
// list must not show it, must show when a live one ends, and must not touch another account's
// rows. Synthetic users and timestamps only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAuth } = require('./auth.cjs');

const DAY = 24 * 60 * 60 * 1000;
const IDLE = 7 * DAY;
const ABSOLUTE = 30 * DAY;
const request = () => ({ headers: { origin: 'https://cowork.example.test', 'user-agent': 'synthetic-agent' }, socket: { remoteAddress: '127.0.0.1' } });
const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-sessions-1483-'));
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://cowork.example.test' });
  t.after(() => { auth.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await auth.setup(request(), response(), { setupCode: fs.readFileSync(path.join(root, 'first-run-setup-code'), 'utf8').trim(), publicOrigin: 'https://cowork.example.test', username: 'owner', password: 'synthetic sessions password' });
  const userId = auth.listUsers()[0].id;
  // Setup signs the owner in; the fixture starts from no sessions so each test lists only its own rows.
  auth.db.prepare('DELETE FROM sessions').run();
  const now = Date.now();
  const insert = (id, owner, { created, lastSeen, expires }) => auth.db.prepare('INSERT INTO sessions(id_hash,user_id,csrf_hash,created_at,last_seen_at,expires_at,user_agent,ip) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, owner, 'csrf', created, lastSeen, expires, 'Synthetic Browser', '127.0.0.1');
  const ids = (owner = userId) => auth.listSessions(owner, undefined).map((s) => s.id);
  const rowExists = (id) => !!auth.db.prepare('SELECT 1 FROM sessions WHERE id_hash=?').get(id);
  return { auth, userId, now, insert, ids, rowExists };
}

test('a session idle for five weeks is not listed and its row is removed', async (t) => {
  const { auth, userId, now, insert, ids, rowExists } = await fixture(t);
  // The shape of the live report: created and last used 35 days ago. Its absolute limit (30 days
  // from creation) has passed, so authenticate() refuses it and the list must not show it either.
  insert('stale-five-weeks', userId, { created: now - 35 * DAY, lastSeen: now - 35 * DAY, expires: now - 35 * DAY + ABSOLUTE });
  assert.deepEqual(ids(), []);
  assert.equal(rowExists('stale-five-weeks'), false, 'the dead row is removed, not just hidden');
});

test('a session idle past the idle limit is not listed, even inside its absolute limit', async (t) => {
  const { userId, now, insert, ids, rowExists } = await fixture(t);
  insert('idle-eight-days', userId, { created: now - 10 * DAY, lastSeen: now - 8 * DAY, expires: now - 10 * DAY + ABSOLUTE });
  assert.deepEqual(ids(), []);
  assert.equal(rowExists('idle-eight-days'), false);
});

test('a live session is listed with the moment it ends: the earlier of the idle and absolute limits', async (t) => {
  const { auth, userId, now, insert } = await fixture(t);
  const lastSeen = now - 2 * DAY;
  const created = now - 3 * DAY;
  insert('live-recent', userId, { created, lastSeen, expires: created + ABSOLUTE });
  const [row] = auth.listSessions(userId, 'live-recent');
  assert.equal(row.id, 'live-recent');
  assert.equal(row.current, true);
  assert.equal(row.expiresAt, lastSeen + IDLE, 'an idle session ends seven days after its last use, which is earlier than its absolute limit');
  assert.ok(row.expiresAt > now, 'a live session shows a future expiry');
});

test('a session near its absolute limit ends at that limit, not at the idle limit', async (t) => {
  const { auth, userId, now, insert } = await fixture(t);
  // Used a minute ago, but created 29 days ago: the absolute limit comes first.
  const created = now - 29 * DAY;
  insert('live-old', userId, { created, lastSeen: now - 60 * 1000, expires: created + ABSOLUTE });
  const [row] = auth.listSessions(userId, undefined);
  assert.equal(row.expiresAt, created + ABSOLUTE);
});

test('listing one account never lists or removes another account\'s sessions', async (t) => {
  const { auth, userId, now, insert, rowExists } = await fixture(t);
  const otherId = 'synthetic-other-account';
  auth.db.prepare('INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(otherId, 'other', 'other', 'Other', 'member', '', 'w-other', now, now);
  insert('other-stale', otherId, { created: now - 35 * DAY, lastSeen: now - 35 * DAY, expires: now - 5 * DAY });
  insert('own-live', userId, { created: now - DAY, lastSeen: now - DAY, expires: now - DAY + ABSOLUTE });
  const mine = auth.listSessions(userId, undefined).map((s) => s.id);
  assert.deepEqual(mine, ['own-live']);
  assert.equal(rowExists('other-stale'), true, 'another account\'s stale row is left for its own listing');
});
