'use strict';
// #1896: Stop, then an immediate new turn. A tune/calibration waiting for chat to be idle takes the maintenance gate the
// moment the stopped reply ends; the new turn waits for it briefly (<= 3 s) and otherwise gets a retryable, logged 503.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMaintenanceGate } = require('./inference-maintenance.cjs');
const { enterChatInference, log503, refusalBody, CHAT_GATE_WAIT_MS } = require('./chat-admission.cjs');

const manager = (gate) => ({ enterInference: gate.enter, enterInferenceWithin: gate.enterWithin });
const tick = () => new Promise((r) => setImmediate(r));

test('Stop, then a new turn right away: a tune that took the gate for a moment is waited for and the turn proceeds', async () => {
  const gate = createMaintenanceGate(), m = manager(gate);
  const first = gate.enter(); // the turn being stopped
  const tuning = gate.holdWhenIdle('Chat is paused while noevia tunes m: preparing.', { timeoutMs: 1000 });
  first(); // Stop: the response closes and leaves the gate
  const release = await tuning; // the tune seizes the gate at once
  assert.throws(() => gate.enter(), /noevia tunes/, 'a plain enter() would answer 503 here');
  setTimeout(release, 50);
  const t0 = Date.now();
  const leave = await enterChatInference(m, { waitMs: 3000 });
  assert.equal(typeof leave, 'function');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(gate.active(), 1);
  leave();
});

test('a gate held longer than the wait is refused after the bounded wait with a retryable code', async () => {
  const gate = createMaintenanceGate(), release = gate.hold('Chat is paused while noevia calibrates m.');
  const t0 = Date.now();
  await assert.rejects(enterChatInference(manager(gate), { waitMs: 60 }), (e) => {
    assert.equal(e.status, 503); assert.equal(e.code, 'inferenceMaintenance'); assert.equal(e.retryable, true);
    assert.deepEqual(refusalBody(e), { error: 'Chat is paused while noevia calibrates m.', code: 'inferenceMaintenance', retryable: true, retryAfter: 3 });
    return true;
  });
  const took = Date.now() - t0;
  assert.ok(took >= 50 && took < 1000, `waited ${took} ms`);
  release();
  (await enterChatInference(manager(gate), { waitMs: 0 }))();
});

test('the wait is never past 3 s by default and ends when the client goes away', async () => {
  assert.ok(CHAT_GATE_WAIT_MS <= 3000);
  const gate = createMaintenanceGate(); gate.hold('x');
  const abort = new AbortController(), pending = enterChatInference(manager(gate), { waitMs: 3000, signal: abort.signal });
  await tick(); abort.abort();
  const t0 = Date.now();
  await assert.rejects(pending, (e) => e.status === 503);
  assert.ok(Date.now() - t0 < 500);
});

test('a manager without a gate admits the turn', async () => {
  assert.equal(await enterChatInference({}), undefined);
  assert.equal(typeof (await enterChatInference({ enterInference: () => () => {} })), 'function');
});

test('one content-free line per 503: route and reason code only', () => {
  const lines = [];
  log503('maintenance', { log: (l) => lines.push(l) });
  log503('machine-unreachable: user said "hello" /secret\n', { log: (l) => lines.push(l) });
  assert.equal(lines[0], '[chat] 503 route=/api/chat reason=maintenance');
  assert.equal(lines[1], '[chat] 503 route=/api/chat reason=unknown');
  assert.ok(!/hello|secret/.test(lines[1]));
  assert.doesNotThrow(() => log503('x', { log: () => { throw new Error('boom'); } }));
});
