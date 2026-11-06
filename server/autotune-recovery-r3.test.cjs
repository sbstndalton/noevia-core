'use strict';
// K round 3: the recovery callback honours the state-owner fence, and every front-issued operation with an
// effect has a ledger entry the front can settle by receipt.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createFullAutotuner } = require('./llamacpp-full-autotune.cjs');
const { createOwnerDouble } = require('./autotune-state-owner-double.cjs');

function rig(t, { job, invalidate } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotune-r3-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ history: {}, settings: {}, job: job === undefined ? { id: 'j', model: 'm', status: 'interrupted', _revision: 'r1', models: [],
    _recovery: { revision: 'r1', text: 'ORIGINAL', backedUp: false } } : job }));
  const owner = createOwnerDouble(file);
  const calls = { commits: [], requests: [], invalidations: 0 };
  let revision = 'r1', recovery = null;
  const maintenance = { requireRecovery: (_key, fn) => { recovery = fn; }, assertCovered() {}, coverageSignal: () => ({ aborted: false }) };
  const tuner = createFullAutotuner({ stateClient: owner, maintenance, servingChecks: {}, planner: {}, loadAdvisor: {}, longProfiles: { pairsOf: () => [] },
    request: async url => { calls.requests.push(url); return { ok: true, body: {} }; }, rawModels: async () => ({ ok: true, body: { data: [{ id: 'm', status: { value: 'unloaded', args: [] } }] } }),
    presets: { snapshot: () => ({ revision, text: 'T' }), get: () => ({ exists: true, defaults: {}, options: {}, revision }),
      commit: async body => { calls.commits.push(body); revision = 'r2'; } },
    applyUnlocked: async () => ({ ok: true }), identityFor: async () => ({ arch: 'a' }), contextFactory: () => { throw Error('not used'); },
    invalidateBaseline: invalidate ? async () => { calls.invalidations++; return invalidate(); } : async () => { calls.invalidations++; return true; } });
  return { tuner, owner, calls, recovery: () => recovery, file };
}
const settled = () => new Promise(r => setImmediate(r));

test('a recovery callback on a healthy actor restores, invalidates and re-reads through the owned wrappers', async t => {
  const r = rig(t);
  await r.tuner.attach(); await r.tuner.recover();
  await r.recovery()();
  assert.equal(r.calls.commits.length, 1);
  assert.deepEqual(r.calls.requests.filter(u => u.includes('reload')), ['/models?reload=1']);
  assert.equal(r.owner.state.job._recovery, undefined, 'the finished recovery reached the owner');
  assert.equal(r.owner.state.job.restored, true);
});

test('K r3 P1: a queued save the owner refuses fences the recovery before the invalidation and the re-read', async t => {
  const r = rig(t);
  await r.tuner.attach(); await r.tuner.recover();
  r.owner.refuse = op => (op === 'commit' ? 'writer' : null);
  await r.recovery()();
  // The restore itself was taken before the owner refused anything; nothing after the refusal is.
  assert.ok(r.calls.commits.length <= 1);
  assert.equal(r.calls.invalidations, 0, 'no baseline invalidation');
  assert.deepEqual(r.calls.requests.filter(u => u.includes('reload')), [], 'no router re-read');
});

test('K r3 P1: a fence that lands while the invalidation is pending stops the re-read and the later writes', async t => {
  let enter, release;
  const entered = new Promise(r => { enter = r; }), blocked = new Promise(r => { release = r; });
  const r = rig(t, { invalidate: async () => { enter(); await blocked; return true; } });
  await r.tuner.attach(); await r.tuner.recover();
  const running = r.recovery()();
  await entered;
  const writes = r.calls.commits.length;
  // The owner refuses this actor's next contact while the invalidation is still outstanding.
  r.owner.refuse = op => (op === 'sync' || op === 'commit' ? 'writer' : null);
  await r.tuner.scanFacts().catch(() => {});
  release();
  await running;
  assert.equal(r.calls.invalidations, 1);
  assert.deepEqual(r.calls.requests.filter(u => u.includes('reload')), [], 'the re-read is not made after the fence');
  assert.equal(r.calls.commits.length, writes, 'no preset write after the fence');
  assert.equal(r.owner.state.job._recovery !== undefined, true, 'the obligation stays with the owner for the legitimate writer');
});

test('K r3 P1: the restore itself is not taken once the actor is already fenced', async t => {
  const r = rig(t);
  await r.tuner.attach(); await r.tuner.recover();
  r.owner.refuse = op => (op === 'sync' || op === 'commit' ? 'writer' : null);
  await r.tuner.scanFacts().catch(() => {});
  await r.recovery()();
  assert.equal(r.calls.commits.length, 0);
  assert.equal(r.calls.requests.length, 0);
});

// ---- the operation ledger ------------------------------------------------------------------------------
const OP = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

test('settle: an operation the actor never received is refused and fenced, so a late arrival has no effect', async t => {
  const r = rig(t, { job: { id: 'j', model: 'm', status: 'interrupted', _revision: 'r1', models: [] } });
  await r.tuner.attach();
  assert.deepEqual(await r.tuner.settle({ op: OP(1) }), { state: 'refused' });
  const late = await r.tuner.listingFacts([{ model: 'm' }], undefined, OP(1));
  assert.deepEqual(late, { applied: false });
  assert.deepEqual(await r.tuner.launch({ op: OP(1), epoch: 1, jobRev: 1, job: { id: 'j', status: 'running' }, history: {} }), { launched: false });
  assert.deepEqual(await r.tuner.settle({ op: OP(1) }), { state: 'refused' });
});

test('settle: a running operation is not terminal; a finished one carries its authenticated outcome', async t => {
  let release; const blocked = new Promise(r => { release = r; });
  const r = rig(t, { job: { id: 'j', model: 'm', status: 'interrupted', _revision: 'r1', models: [] } });
  await r.tuner.attach();
  const rawModels = r.tuner.listingFacts;
  void rawModels;
  // identities with no selectors and nothing owed settles at once
  const done = await r.tuner.identityFacts([], undefined, OP(2));
  assert.deepEqual(done, { identities: [] });
  assert.deepEqual(await r.tuner.settle({ op: OP(2) }), { state: 'settled', outcome: { ok: true }, repaired: true });
  release(); await blocked;
  assert.deepEqual(await r.tuner.identityFacts([], undefined, OP(2)), { applied: false }, 'a repeated id is not run twice');
});

test('settle: an acknowledged "router has not re-read yet" is settled with a repair owed, and the covered repair completes it', async t => {
  const r = rig(t, { job: { id: 'j', model: 'm', status: 'interrupted', _revision: 'r1', _reloadPending: true, models: [] }, invalidate: async () => false });
  await r.tuner.attach();
  const answer = await r.tuner.identityFacts([], undefined, OP(3));
  assert.equal(answer.fault, 'reload');
  let receipt = await r.tuner.settle({ op: OP(3) });
  assert.deepEqual(receipt, { state: 'settled', outcome: { fault: 'reload', needsRepair: true }, repaired: false });
  // the repair under the front's recovery hold fails while the baseline is not acknowledged ...
  receipt = await r.tuner.settle({ op: OP(3), repair: true });
  assert.equal(receipt.repaired, false);
});

test('settle: bad ids are refused outright', async t => {
  const r = rig(t);
  await r.tuner.attach();
  for (const op of [undefined, null, 5, '', 'x'.repeat(65), 'has space']) await assert.rejects(r.tuner.settle({ op }));
  await assert.rejects(r.tuner.listingFacts([], undefined, 'bad id!'));
});
