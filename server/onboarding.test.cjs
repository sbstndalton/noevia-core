'use strict';
// The user_features migrations that run at boot stay Node's. Onboarding itself (the first-run
// wizard, invitations, completing onboarding, the Diary choice) is the Rust front's
// (sbstndalton/noevia#1071; noevia-rs crates/server-account).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createAuth } = require('./auth.cjs');
const { seedAccount } = require('../tests/server/seed-account.cjs');
const origin = 'https://onboarding.example.test';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-onboarding-'));
  let auth = createAuth({ dataDir: root, publicOrigin: origin });
  t.after(() => { auth.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const owner = seedAccount(root, { username: 'owner', onboarded: false });
  // The front's connection: Node's own refuses to write the account tables.
  const asFront = (sql, ...args) => { const db = new Database(path.join(root, 'cowork.db')); try { db.prepare(sql).run(...args); } finally { db.close(); } };
  return { get auth() { return auth; }, owner, asFront, restart() { auth.db.close(); auth = createAuth({ dataDir: root, publicOrigin: origin }); } };
}
test('a missing feature row stays opt-out across restart; legacy migration does not run twice', t => {
  const f = fixture(t);
  f.asFront('DELETE FROM user_features WHERE user_id=?', f.owner.id);
  f.restart();
  assert.equal(f.auth.diaryEnabled(f.owner.id), false);
  assert.equal(f.auth.listUsers()[0].onboarded, true);
});

test('the original feature migration keeps legacy users enabled and already onboarded', t => {
  const f = fixture(t);
  f.asFront('DELETE FROM user_features WHERE user_id=?', f.owner.id);
  f.asFront('DELETE FROM schema_migrations WHERE version=2');
  f.restart();
  assert.equal(f.auth.diaryEnabled(f.owner.id), true);
  assert.equal(f.auth.listUsers()[0].onboarded, true);
  f.asFront('UPDATE user_features SET diary_enabled=0 WHERE user_id=?', f.owner.id);
  f.restart();
  assert.equal(f.auth.diaryEnabled(f.owner.id), false, 'the migration does not run again');
});
