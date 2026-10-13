'use strict';
// #1437: the sensitivity check's deadline, its per-decision log, and the decision layer's log
// reduced to codes. Synthetic text only; no model, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const rm = require('./routing-modes.cjs');
const { createDecisions } = require('./decision/index.cjs');
// #1647: these run against a synthetic model on a test-only qualified list (the gate: sensitivity-qualification-1647.test.cjs).
const SYN_IDENTITY = { model: 'synthetic/sensitivity-test', revision: 'a'.repeat(40) };
const SYN_QUALIFIED = [{ ...SYN_IDENTITY, evidence: { set: 'synthetic', sensitiveRecall: 1, measured: '2026-10-13' } }];

test('#1437: the sensitivity check has a named 2000 ms deadline (the owner-approved Laya ceiling)', async () => {
  assert.equal(rm.SENSITIVITY_DEADLINE_MS, 2000);
  const deadlines = [];
  const check = rm.createSensitivity({ decide: async (request) => {
    deadlines.push(request.constraints.deadlineMs);
    return { selected: 'not_sensitive', scores: { not_sensitive: 1 }, confidence: 1, metadata: { identity: SYN_IDENTITY } };
  }, qualified: SYN_QUALIFIED });
  assert.deepEqual(await check('synthetic'), { flagged: false, flag: null });
  assert.ok(deadlines[0] <= 2000 && deadlines[0] > 1900, `deadline was ${deadlines[0]}`);
});

test('#1437: each sensitivity decision logs its outcome, latency and cause code, never its text', async () => {
  const logs = [];
  const check = rm.createSensitivity({
    decide: async () => ({ selected: null, scores: {}, source: 'fallback', metadata: { fellBack: 'no-backend-answered', cause: 'http-503' } }),
    log: (entry) => logs.push(entry), qualified: SYN_QUALIFIED,
  });
  assert.deepEqual(await check('SYNTHETIC-PRIVATE-TEXT'), { flagged: true, flag: 'unavailable', cause: 'http-503' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].verdict, 'unavailable');
  assert.equal(logs[0].cause, 'http-503');
  assert.equal(logs[0].fellBack, true);
  assert.equal(typeof logs[0].latencyMs, 'number');
  assert.equal(logs[0].deadlineMs, 2000);
  assert.equal(JSON.stringify(logs).includes('SYNTHETIC-PRIVATE-TEXT'), false);
});

test('#1437: the decision layer log is reduced to codes and numbers (message text and failure text dropped)', () => {
  assert.deepEqual(rm.decisionCodes({ purpose: 'routing.sensitivity', backend: 'configured', failed: 'SYNTHETIC-PRIVATE-TEXT',
    source: 'fallback', fellBack: 'no-backend-answered', cause: 'http-503', latencyMs: 1600, confidence: null, request: 'SYNTHETIC' }),
  { purpose: 'routing.sensitivity', source: 'fallback', fellBack: 'no-backend-answered', cause: 'http-503', latencyMs: 1600, confidence: null });
  assert.equal(rm.decisionCodes({ cause: 'a sentence with spaces' }).cause, null, 'a cause must be a code');
  assert.equal(rm.decisionCodes(null).purpose, null);
});

test('#1437: a backend failure reaches the decision layer log as its http cause, through the real causeOf', async () => {
  const logs = [];
  const decisions = createDecisions({
    backends: { configured: { supports: () => true, locality: 'local', decide: async () => { throw Object.assign(Error('Decision endpoint unavailable'), { reason: 'http-503' }); } } },
    chains: { 'routing.sensitivity': ['configured'] },
    log: (entry) => logs.push(rm.decisionCodes(entry)),
  });
  const result = await decisions.decide({ kind: 'choice', purpose: 'routing.sensitivity', question: 'q', context: { cloud: 'forbidden', stateText: 'SYNTHETIC' },
    options: [{ id: 'sensitive', label: 'a' }, { id: 'not_sensitive', label: 'b' }], constraints: { deadlineMs: 2000, minConfidence: 0.6 }, fallback: { selected: null, scores: {} } });
  assert.equal(result.source, 'fallback');
  assert.equal(result.metadata.cause, 'http-503');
  // The layer logs the failed attempt, then the answer it fell back to; the outcome line carries the cause.
  const outcome = logs.find((e) => e.fellBack);
  assert.deepEqual(outcome, { purpose: 'routing.sensitivity', source: 'fallback', fellBack: 'no-backend-answered', cause: 'http-503', latencyMs: outcome.latencyMs, confidence: null });
  assert.equal(typeof outcome.latencyMs, 'number');
  assert.equal(JSON.stringify(logs).includes('SYNTHETIC'), false);
  assert.equal(JSON.stringify(logs).includes('Decision endpoint'), false, 'no error message text in the log');
});
