'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createFullAutotuner } = require('./llamacpp-full-autotune.cjs');
const { createAutotuneClearBridge } = require('./rust-autotune-clear-bridge.cjs');
function actor(t, status = 'failed', extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotune-clear-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const state = { history: { synthetic: [{ measured: 123 }] }, settings: { synthetic: { allowQ5Kv: true } }, job: { id: 'synthetic', status, originalText: 'private-profile', ...extra } };
  fs.writeFileSync(file, JSON.stringify(state));
  const build = () => createFullAutotuner({ stateFile: file, servingChecks: {}, planner: {}, loadAdvisor: {}, longProfiles: {} });
  return { file, state, build, tuner: build() };
}
test('conditional clear removes only the finished job and preserves history/settings; old token cannot repeat', t => {
  for (const status of ['failed', 'cancelled', 'interrupted', 'passed']) {
    const f = actor(t, status), before = fs.readFileSync(f.file, 'utf8');
    const facts = f.tuner.clearFacts();
    assert.equal(facts.status, status); assert.equal(facts.jobPresent, true);
    assert.doesNotMatch(JSON.stringify(facts), /private-profile|measured|allowQ5/);
    assert.deepEqual(f.tuner.compareAndClear('x'.repeat(64)), { applied: false });
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    assert.deepEqual(f.tuner.compareAndClear(facts.token), { applied: true });
    const after = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    assert.equal(after.job, undefined); assert.deepEqual(after.history, f.state.history); assert.deepEqual(after.settings, f.state.settings);
    assert.deepEqual(f.tuner.compareAndClear(facts.token), { applied: false });
  }
});
test('active, unknown and pending restore jobs cannot be cleared, including valid snapshot tokens', t => {
  for (const [status, extra] of [['running', {}], ['queued', {}], ['failed', { _reloadPending: true }]]) {
    const f = actor(t, status, extra), before = fs.readFileSync(f.file, 'utf8');
    assert.deepEqual(f.tuner.compareAndClear(f.tuner.clearFacts().token), { applied: false });
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  }
});
test('restart invalidates snapshots; failed persistence retains the in-memory job', t => {
  const f = actor(t), facts = f.tuner.clearFacts();
  assert.deepEqual(f.build().compareAndClear(facts.token), { applied: false });
  fs.rmSync(f.file); fs.rmdirSync(path.dirname(f.file));
  assert.throws(() => f.tuner.compareAndClear(facts.token));
  assert.equal(f.tuner.clearFacts().jobPresent, true);
  assert.equal(f.tuner.clearFacts().status, 'failed');
});
const secret = 'synthetic-secret-'.repeat(4);
async function bridgeCall({ peer = '127.0.0.1', headers = {}, url = '/internal/autotune-clear/facts', body = {}, tuner = null } = {}) {
  let sent;
  const bridge = createAutotuneClearBridge({ secret, json: (_r, status, value) => { sent = { status, value }; }, readJson: async () => body, autotune: () => tuner, log: () => {} });
  await bridge({ method: 'POST', url, headers: { 'x-noevia-store-token': secret, ...headers }, socket: { remoteAddress: peer } }, {});
  return sent;
}
test('private bridge denies remote peers, wrong credentials and even empty forwarded headers', async () => {
  for (const options of [{ peer: '192.0.2.1' }, { headers: { 'x-noevia-store-token': 'wrong' } }, { headers: { 'x-forwarded-for': '' } }, { headers: { 'x-noevia-client-ip': '' } }]) assert.equal((await bridgeCall(options)).status, 404);
  assert.deepEqual(await bridgeCall(), { status: 200, value: { available: false } });
  assert.equal((await bridgeCall({ tuner: {} })).status, 503);
});
test('private bridge requires an opaque selector and does not expose stale-state success', async t => {
  const f = actor(t);
  assert.equal((await bridgeCall({ tuner: f.tuner, body: { model: 'other' } })).status, 400);
  assert.equal((await bridgeCall({ tuner: f.tuner, url: '/internal/autotune-clear/clear', body: { token: 'x'.repeat(64) } })).status, 400);
  const facts = await bridgeCall({ tuner: f.tuner });
  assert.equal(facts.status, 200);
  assert.deepEqual(await bridgeCall({ tuner: f.tuner, url: '/internal/autotune-clear/clear', body: { token: facts.value.token } }), { status: 200, value: { applied: true } });
  assert.equal((await bridgeCall({ tuner: f.tuner, url: '/internal/autotune-clear/clear', body: { token: facts.value.token } })).status, 409);
});
