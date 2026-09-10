'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuth } = require('./auth.cjs');
const origin = 'https://onboarding.example.test';
const req = () => ({ headers: { origin }, socket: { remoteAddress: '127.0.0.1' } });
const res = () => ({ setHeader() {} });
const password = 'synthetic onboarding password';
async function fixture(t, diaryEnabled = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-onboarding-'));
  let auth = createAuth({ dataDir: root, publicOrigin: origin });
  t.after(() => { auth.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const setup = await auth.setup(req(), res(), { setupCode: fs.readFileSync(path.join(root, 'first-run-setup-code'), 'utf8').trim(), publicOrigin: origin, username: 'owner', password, diaryEnabled });
  assert.equal(setup.status, 201);
  return { get auth() { return auth; }, owner: setup.body.user, restart() { auth.db.close(); auth = createAuth({ dataDir: root, publicOrigin: origin }); } };
}
for (const enabled of [false, true]) {
  test(`fresh administrator preserves diary=${enabled} through restart and completion`, async t => {
    const f = await fixture(t, enabled);
    assert.equal(f.owner.onboarded, false);
    f.restart();
    assert.equal(f.auth.listUsers()[0].diaryEnabled, enabled);
    assert.equal(f.auth.listUsers()[0].onboarded, false);
    f.auth.markOnboarded(f.owner.id);
    f.restart();
    assert.equal(f.auth.listUsers()[0].diaryEnabled, enabled);
    assert.equal(f.auth.listUsers()[0].onboarded, true);
  });
  for (const role of ['member', 'admin']) test(`invited ${role} resumes with diary=${enabled}, completing only its own account`, async t => {
    const f = await fixture(t, !enabled);
    const joined = await f.auth.acceptInvite(req(), res(), { token: f.auth.createInvite(f.owner.id, role).token, username: 'invitee', password, diaryEnabled: enabled });
    assert.equal(joined.status, 201);
    assert.equal(joined.body.user.onboarded, false);
    f.restart();
    const login = await f.auth.passwordLogin(req(), res(), { username: 'invitee', password });
    assert.equal(login.body.user.onboarded, false);
    assert.equal(login.body.user.diaryEnabled, enabled);
    f.auth.markOnboarded(joined.body.user.id);
    f.auth.markOnboarded(joined.body.user.id);
    f.restart();
    const users = f.auth.listUsers();
    assert.equal(users.find(u => u.id === joined.body.user.id).onboarded, true);
    assert.equal(users.find(u => u.id === joined.body.user.id).diaryEnabled, enabled);
    assert.equal(users.find(u => u.id === f.owner.id).onboarded, false);
    assert.equal(users.find(u => u.id === f.owner.id).diaryEnabled, !enabled);
  });
}
test('completion preserves the latest explicit choice and missing rows default to diary off', async t => {
  const f = await fixture(t, true);
  f.auth.setDiaryEnabled(f.owner.id, false);
  f.auth.markOnboarded(f.owner.id);
  assert.equal(f.auth.diaryEnabled(f.owner.id), false);
  f.auth.setDiaryEnabled(f.owner.id, true);
  f.auth.markOnboarded(f.owner.id);
  assert.equal(f.auth.diaryEnabled(f.owner.id), true);
  f.auth.db.prepare('DELETE FROM user_features WHERE user_id=?').run(f.owner.id);
  assert.equal(f.auth.diaryEnabled(f.owner.id), false);
  f.auth.markOnboarded(f.owner.id);
  assert.equal(f.auth.diaryEnabled(f.owner.id), false);
  f.restart();
  assert.equal(f.auth.diaryEnabled(f.owner.id), false);
  assert.equal(f.auth.listUsers()[0].onboarded, true);
});
test('a missing feature row stays opt-out across restart; legacy migration does not run twice', async t => {
  const f = await fixture(t);
  f.auth.db.prepare('DELETE FROM user_features WHERE user_id=?').run(f.owner.id);
  f.restart();
  assert.equal(f.auth.diaryEnabled(f.owner.id), false);
  assert.equal(f.auth.listUsers()[0].onboarded, true);
});

test('the original feature migration keeps legacy users enabled and already onboarded', async t => {
  const f = await fixture(t);
  f.auth.db.prepare('DELETE FROM user_features WHERE user_id=?').run(f.owner.id);
  f.auth.db.prepare('DELETE FROM schema_migrations WHERE version=2').run();
  f.restart();
  assert.equal(f.auth.diaryEnabled(f.owner.id), true);
  assert.equal(f.auth.listUsers()[0].onboarded, true);
  f.auth.setDiaryEnabled(f.owner.id, false);
  f.restart();
  assert.equal(f.auth.diaryEnabled(f.owner.id), false);
});
