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
