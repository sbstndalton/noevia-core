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
