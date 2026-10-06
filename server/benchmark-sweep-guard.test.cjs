'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSweepGuard, SWEEP_BUSY_ERROR, SWEEP_PAUSE_REASON } = require('./benchmark-sweep-guard.cjs');
const { createMaintenanceGate } = require('./inference-maintenance.cjs');

function harness({ progress, ...options }) {
  const gate = createMaintenanceGate(), timers = [], logs = []; const clock = { t: 0 };
  const guard = createSweepGuard({ hold: (r) => gate.hold(r), progress, log: (m) => logs.push(m), now: () => clock.t, pollMs: 1000,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearTimer: () => {}, ...options });
  const tick = async (advance = 1000) => { clock.t += advance; await timers.shift().fn(); };
  return { gate, guard, timers, logs, clock, tick };
}

test('#873 acquire pauses chat with a reason and refuses while requests run', () => {
  const { gate, guard } = harness({ progress: async () => null });
  const chat = gate.enter();
  assert.throws(() => guard.acquire(), (e) => e.status === 409 && e.publicMessage === SWEEP_BUSY_ERROR);
  chat();
  const release = guard.acquire();
  assert.throws(() => gate.enter(), (e) => e.message === SWEEP_PAUSE_REASON);
  assert.throws(() => guard.acquire(), /Requests are in progress/, 'one sweep at a time');
  release(); release();
  gate.enter()();
});

test('#873 an unreachable model manager releases chat after the grace period, not at once', async () => {
  let reply = { ok: true, body: { job: { active: true } } };
  const h = harness({ progress: async () => reply, unreachableMs: 3000 });
  h.guard.watch(h.guard.acquire(), 1);
  await h.tick();
  reply = null;
  await h.tick(); await h.tick();
  assert.equal(h.gate.held(), true, 'two missed polls keep the hold');
  await h.tick();
  assert.equal(h.gate.held(), false);
  assert.match(h.logs[0], /stopped answering/);
});

test('#873 the hold ends at the time limit even if the sweep claims to run on', async () => {
  const h = harness({ progress: async () => ({ ok: true, body: { job: { active: true } } }), perModelMs: 5000, slackMs: 1000 });
  h.guard.watch(h.guard.acquire(), 2);
  for (let i = 0; i < 10; i++) await h.tick();
  assert.equal(h.gate.held(), true);
  await h.tick();
  assert.equal(h.gate.held(), false); assert.equal(h.timers.length, 0);
  assert.match(h.logs[0], /time limit/);
});

test('#873 a progress call that throws counts as unreachable', async () => {
  const h = harness({ progress: async () => { throw Error('ECONNREFUSED'); }, unreachableMs: 1000 });
  h.guard.watch(h.guard.acquire(), 1);
  assert.equal(h.guard.active(), true);
  await h.tick();
  assert.equal(h.gate.held(), false); assert.equal(h.guard.active(), false);
});

test('#895 adopt() retries with bounded backoff until the model manager answers, then takes the gate', async () => {
  const replies = [() => { throw Error('ECONNREFUSED'); }, () => ({ ok: false, status: 503 }), () => ({ ok: true, body: { job: { active: true, unit: 'models', total: 2 } } })];
  let calls = 0;
  const h = harness({ progress: async () => replies[calls++](), adoptRetryMs: 100, adoptMaxDelayMs: 150 });
  const adopted = h.guard.adopt();
  await new Promise(setImmediate);
  assert.equal(calls, 1); assert.equal(h.gate.held(), false, 'not yet');
  assert.equal(h.timers.length, 1); assert.equal(h.timers[0].ms, 100);
  h.timers.shift().fn(); await new Promise(setImmediate);
  assert.equal(calls, 2); assert.equal(h.timers[0].ms, 150, 'the delay doubles up to the cap');
  h.timers.shift().fn();
  assert.equal(await adopted, true);
  assert.equal(calls, 3); assert.equal(h.gate.held(), true, 'the running sweep holds the gate again');
  assert.throws(() => h.gate.enter(), (e) => e.message === SWEEP_PAUSE_REASON);
  assert.equal(h.guard.active(), true);
});

test('#895 adopt() gives up after its attempts, and cancelAdopt() ends a pending retry', async () => {
  let calls = 0;
  const h = harness({ progress: async () => { calls++; return null; }, adoptRetryMs: 10, adoptAttempts: 3 });
  const gaveUp = h.guard.adopt();
  for (let i = 0; i < 2; i++) { await new Promise(setImmediate); h.timers.shift().fn(); }
  assert.equal(await gaveUp, false); assert.equal(calls, 3); assert.equal(h.timers.length, 0); assert.equal(h.gate.held(), false);
  const c = harness({ progress: async () => null, adoptRetryMs: 10 });
  const cancelled = c.guard.adopt();
  await new Promise(setImmediate);
  assert.equal(c.timers.length, 1);
  c.guard.cancelAdopt();
  assert.equal(await cancelled, false); assert.equal(c.gate.held(), false);
  // A definitive "nothing running" answers at once, without retrying.
  const idle = harness({ progress: async () => ({ ok: true, body: { job: null } }) });
  assert.equal(await idle.guard.adopt(), false); assert.equal(idle.timers.length, 0);
});

test('#895 the real timers are unref\'d, so a pending adopt() retry does not keep the process alive', async () => {
  const unrefs = [];
  const guard = createSweepGuard({ hold: () => () => {}, progress: async () => null, log: () => {}, adoptRetryMs: 60000,
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); const unref = t.unref.bind(t); t.unref = () => { unrefs.push(ms); return unref(); }; return t; } });
  const pending = guard.adopt();
  await new Promise(setImmediate);
  assert.deepEqual(unrefs, [60000]);
  guard.cancelAdopt();
  assert.equal(await pending, false);
});
