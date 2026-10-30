'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createMaintenanceGate } = require('./inference-maintenance.cjs');

test('idle acquisition waits for an active chat and exposes the current phase reason', async () => {
  const gate = createMaintenanceGate(), leave = gate.enter();
  const pending = gate.holdWhenIdle('First phase', { timeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  leave();
  const release = await pending;
  assert.throws(() => gate.enter(), /First phase/);
  release.setReason('Second phase');
  assert.throws(() => gate.enter(), /Second phase/);
  release();
  const chat = gate.enter(); chat();
});
test('idle acquisition is bounded and cancellation does not hold chat', async () => {
  const gate = createMaintenanceGate(), leave = gate.enter();
  await assert.rejects(gate.holdWhenIdle('Tune', { timeoutMs: 5 }), e => e.idleTimeout === true);
  const abort = new AbortController(), pending = gate.holdWhenIdle('Tune', { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, e => e.cancelled === true);
  leave();
  const chat = gate.enter(); chat();
});

test('#872 held() reports the gate without taking it', () => {
  const gate = createMaintenanceGate();
  assert.equal(gate.held(), false);
  const leave = gate.enter();
  assert.equal(gate.held(), false, 'requests in flight are not maintenance');
  leave();
  const release = gate.hold('calibrating');
  assert.equal(gate.held(), true);
  assert.throws(() => gate.enter(), /calibrating/);
  release();
  assert.equal(gate.held(), false);
  gate.enter()();
});

// ── #2210: a hold another client took at the gate (the Rust front's reload, calibration or tune) ────────────
test('#2210 held() reports a hold the gate says another client holds, and not the one this process holds', async () => {
  const { createMaintenanceGate } = require('./inference-maintenance.cjs');
  let answer = true, asked = 0;
  const timers = [];
  const remote = {
    maintenanceHeld: async () => { asked++; return answer; },
    holdMaintenance: async () => ({ token: '0123456789abcdef0123456789abcdef', idleTtlMs: 60000 }),
    renewMaintenance: async () => true, releaseMaintenance: async () => {},
  };
  const gate = createMaintenanceGate({ remote, observeMs: 1000, setTimer: (fn) => { timers.push(fn); return { unref() {} }; }, log: () => {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(asked, 1, 'asked once at the start');
  assert.equal(gate.held(), true, 'the front\'s hold is seen');
  answer = false; await timers[0](); assert.equal(gate.held(), false, 'and its end');
  answer = null; await timers[0](); assert.equal(gate.held(), false, 'an unanswered ask leaves the last answer');
  answer = true; await timers[0](); assert.equal(gate.held(), true);
  answer = null; await timers[0](); assert.equal(gate.held(), true, 'an unanswered ask leaves the last answer');
  // A hold of this process\'s own is not foreign, and ends with its release at once (no stale "held").
  answer = false; await timers[0]();
  const release = await gate.hold('mine');
  answer = true; await timers[0]();
  assert.equal(gate.held(), true, 'held by this process');
  release();
  assert.equal(gate.held(), false, 'released: the earlier answer about this hold is dropped');
  // Chat of this process is not refused by the foreign hold itself (the gate does that); only held() reports it.
  answer = true; await timers[0]();
  assert.doesNotThrow(() => gate.enter()());
});

test('#2210 without observeMs, or a remote that cannot be asked, nothing is polled', () => {
  const { createMaintenanceGate } = require('./inference-maintenance.cjs');
  let timers = 0;
  const setTimer = () => { timers++; return { unref() {} }; };
  createMaintenanceGate({ remote: { maintenanceHeld: async () => true }, setTimer });
  createMaintenanceGate({ remote: { holdMaintenance: async () => null }, observeMs: 1000, setTimer });
  createMaintenanceGate({ remote: null, observeMs: 1000, setTimer });
  assert.equal(timers, 0);
});
