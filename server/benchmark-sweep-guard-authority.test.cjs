'use strict';
// Row J review P2: an unavailable maintenance lease authority (503 maintenanceAuthorityUnavailable) is an
// outage, not a busy engine: a sweep start answers 503, and a running sweep's recovery after a restart keeps
// chat closed behind a barrier while it retries the hold. Synthetic manager progress and gate only.
const test = require('node:test'), assert = require('node:assert/strict');
const { createSweepGuard, SWEEP_UNAVAILABLE_ERROR, SWEEP_PAUSE_REASON } = require('./benchmark-sweep-guard.cjs');
const { createMaintenanceGate } = require('./inference-maintenance.cjs');

const outage = () => Object.assign(Error('The maintenance lease authority is not answering.'), { status: 503, code: 'maintenanceAuthorityUnavailable' });

function harness({ hold, progress, ...options }) {
  const gate = createMaintenanceGate(), logs = [];
  const guard = createSweepGuard({ hold: hold || ((r) => gate.hold(r)), progress, barrier: (r) => gate.barrier(r), log: (m) => logs.push(m),
    adoptRetryMs: 1, adoptMaxDelayMs: 2, adoptAttempts: 3, pollMs: 60000, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: clearTimeout, ...options });
  return { gate, guard, logs };
}

test('a sweep start keeps the authority outage as 503, not a misleading busy 409', async () => {
  const { guard } = harness({ hold: () => Promise.reject(outage()), progress: async () => null });
  await assert.rejects(guard.acquire(), (e) => e.status === 503 && e.code === 'maintenanceAuthorityUnavailable'
    && e.publicMessage === SWEEP_UNAVAILABLE_ERROR && e.waitable === true);
  const sync = harness({ hold: () => { throw outage(); }, progress: async () => null });
  assert.throws(() => sync.guard.acquire(), (e) => e.status === 503 && e.unavailable === true);
  // A busy refusal stays the 409.
  const busy = harness({ hold: () => { throw Object.assign(Error('busy'), { status: 409 }); }, progress: async () => null });
  assert.throws(() => busy.guard.acquire(), (e) => e.status === 409);
});

test('recovery: chat is closed behind a barrier through the outage, and the hold is adopted when the authority answers', async () => {
  let fails = 6; // more than adoptAttempts: an outage does not use up the attempts
  const gate = createMaintenanceGate();
  const seen = [];
  const { guard } = harness({
    hold: (r) => { if (fails-- > 0) { try { gate.enter()(); seen.push('open'); } catch { seen.push('closed'); } throw outage(); } return gate.hold(r); },
    progress: async () => ({ ok: true, body: { job: { active: true, unit: 'models', total: 1 } } }),
    barrier: (r) => gate.barrier(r),
  });
  assert.equal(await guard.adopt(), true);
  assert.deepEqual(seen.slice(1), ['closed', 'closed', 'closed', 'closed', 'closed'], 'chat closed after the first outage answer');
  assert.throws(() => gate.enter(), (e) => e.message === SWEEP_PAUSE_REASON, 'now held by the adopted sweep');
  assert.equal(guard.active(), true, 'the sweep is watched');
  assert.equal(seen[0], 'open', 'before the outage was known, chat was not yet closed');
});

test('recovery: a sweep that finishes during the outage lifts the barrier and adopts nothing', async () => {
  let polls = 0;
  const gate = createMaintenanceGate();
  const { guard, logs } = harness({
    hold: () => { throw outage(); },
    progress: async () => ({ ok: true, body: { job: polls++ < 3 ? { active: true, unit: 'models', total: 1 } : { active: false, unit: 'models' } } }),
    barrier: (r) => gate.barrier(r),
  });
  assert.equal(await guard.adopt(), false);
  gate.enter()();
  assert.equal(gate.held(), false);
  assert.ok(logs.some((l) => /finished while chat was paused/.test(l)), logs.join('\n'));
});

test('recovery: an outage past the sweep\'s own time bound lifts the barrier', async () => {
  let t = 0;
  const gate = createMaintenanceGate();
  const { guard } = harness({
    hold: () => { t += 1000; throw outage(); },
    progress: async () => ({ ok: true, body: { job: { active: true, unit: 'models', total: 1 } } }),
    barrier: (r) => gate.barrier(r), now: () => t, perModelMs: 2000, slackMs: 0,
  });
  assert.equal(await guard.adopt(), false);
  gate.enter()();
});
