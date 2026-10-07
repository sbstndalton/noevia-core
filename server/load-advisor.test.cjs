'use strict';
// #1004: the decision service advises auto-tune's failure verdict only on a tie. Synthetic engine
// texts; the decision service is a fake (no Laya, no model, no network).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const { createLoadAdvisor, enabled, excerpt, OPTIONS, ADVICE_BUDGET_MS, EXCERPT_UNITS } = require('./load-advisor.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const ON = { LAYA_LOAD_ADVISOR: 'on' };
// A decision service answering `label` at `confidence`, recording what it was asked.
function fakeService({ label = 'oom', confidence = 0.9, delayMs = 0, fail = null } = {}) {
  const asked = [];
  return { asked, async choice(input, { signal } = {}) {
    asked.push(input);
    if (delayMs) await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, delayMs);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(Error('Decision endpoint unreachable'), { reason: 'aborted' })); });
    });
    if (fail) throw Object.assign(Error('Decision endpoint unavailable'), { reason: fail });
    const rest = (1 - confidence) / (OPTIONS.length - 1);
    return { selected: label, scores: Object.fromEntries(OPTIONS.map(o => [o.id, o.id === label ? confidence : rest])), confidence: null, metadata: {} };
  } };
}
// A stand-in for load_verdict with the crate's merge rule: a rule on "out of memory", else advice.
function fakeVerdict(calls = []) {
  return request => {
    calls.push(request);
    const fallback = { oom: 'oom', load: 'load_failed', timeout: 'timeout', time: 'over_time', recall: 'recall_failed' }[request.cause];
    const base = { ruleId: null, advice: null, adviceUsed: false, ask: false, reason: 'Fixed.' };
    if (!request.evidence) return { ...base, outcome: fallback, source: 'measured', rule: 'unknown' };
    if (/out of memory/i.test(request.evidence.text)) return { ...base, outcome: 'oom', source: 'rule', rule: 'oom', ruleId: 'text_oom' };
    const a = request.advice;
    const advice = a ? { label: a.label, permille: Math.round(a.confidence * 1000) } : null;
    if (advice && advice.permille >= 600 && advice.label !== 'unknown') return { ...base, advice, adviceUsed: true, outcome: advice.label, source: 'advisor', rule: 'unknown' };
    return { ...base, advice, outcome: fallback, source: 'fallback', rule: 'unknown', ask: !a && request.evidence.text.trim() !== '' };
  };
}

test('LAYA_LOAD_ADVISOR is on only when set to on', () => {
  assert.equal(enabled({}), false);
  for (const v of ['on', ' ON ', 'On']) assert.equal(enabled({ LAYA_LOAD_ADVISOR: v }), true, v);
  for (const v of ['1', 'true', 'yes', 'off', 'wasm', '']) assert.equal(enabled({ LAYA_LOAD_ADVISOR: v }), false, v);
  assert.equal(createLoadAdvisor({ env: {}, endpoint: null }).enabled(), false);
  assert.equal(createLoadAdvisor({ env: ON, endpoint: null }).enabled(), true);
  assert.equal(ADVICE_BUDGET_MS, 2000);
});

test('a measured cause or a rule decides without asking the decision service', async () => {
  const svc = fakeService(), calls = [];
  const a = createLoadAdvisor({ env: ON, endpoint: svc, verdict: fakeVerdict(calls) });
  let r = await a.judge({ cause: 'time', evidence: null });
  assert.equal(r.outcome, 'over_time');
  assert.equal(r.classification.advisor, 'not_asked');
  r = await a.judge({ cause: 'load', evidence: { status: 500, text: 'CUDA error: out of memory' } });
  assert.deepEqual([r.outcome, r.classification.source, r.classification.advisor], ['oom', 'rule', 'not_asked']);
  assert.equal(svc.asked.length, 0);
  assert.equal(calls.length, 2);
});

test('no rule: the decision service is asked once with the fixed question, and its confident label is used', async () => {
  const svc = fakeService({ label: 'template', confidence: 0.82 });
  const a = createLoadAdvisor({ env: ON, endpoint: svc, verdict: fakeVerdict() });
  const r = await a.judge({ cause: 'oom', evidence: { status: 500, exitCode: 1, text: 'srv  operator(): process exited unexpectedly' } });
  assert.equal(svc.asked.length, 1);
  assert.deepEqual(svc.asked[0].options.map(o => o.id), ['oom', 'load_failed', 'timeout', 'recall_failed', 'template', 'unknown']);
  assert.deepEqual(JSON.parse(svc.asked[0].state), { engineError: 'srv  operator(): process exited unexpectedly' });
  assert.deepEqual([r.outcome, r.classification.source, r.classification.advisor, r.classification.adviceUsed], ['template', 'advisor', 'used', true]);
  assert.deepEqual(r.classification.advice, { label: 'template', permille: 820 });
});

test('a low-confidence or "unknown" label is recorded and ignored: the calibrator\'s cause stands', async () => {
  for (const svc of [fakeService({ label: 'template', confidence: 0.4 }), fakeService({ label: 'unknown', confidence: 0.95 })]) {
    const r = await createLoadAdvisor({ env: ON, endpoint: svc, verdict: fakeVerdict() }).judge({ cause: 'load', evidence: { text: 'odd' } });
    assert.deepEqual([r.outcome, r.classification.source, r.classification.advisor], ['load_failed', 'fallback', 'ignored']);
  }
});

test('a slow decision service is cut off at the budget and ignored', async () => {
  const svc = fakeService({ delayMs: 5000 });
  const a = createLoadAdvisor({ env: ON, endpoint: svc, verdict: fakeVerdict(), budgetMs: 30 });
  const started = Date.now();
  const r = await a.judge({ cause: 'oom', evidence: { text: 'odd' } });
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual([r.outcome, r.classification.source, r.classification.advisor], ['oom', 'fallback', 'timeout']);
});

test('an unreachable, failing or unconfigured decision service means no advice', async () => {
  let r = await createLoadAdvisor({ env: ON, endpoint: fakeService({ fail: 'http-503' }), verdict: fakeVerdict() }).judge({ cause: 'load', evidence: { text: 'odd' } });
  assert.deepEqual([r.outcome, r.classification.advisor], ['load_failed', 'error']);
  r = await createLoadAdvisor({ env: ON, endpoint: null, verdict: fakeVerdict() }).judge({ cause: 'load', evidence: { text: 'odd' } });
  assert.deepEqual([r.outcome, r.classification.advisor], ['load_failed', 'unavailable']);
  // The real client with no COWORK_DECISION_URL is unconfigured too.
  r = await createLoadAdvisor({ env: ON, verdict: fakeVerdict() }).judge({ cause: 'load', evidence: { text: 'odd' } });
  assert.equal(r.classification.advisor, 'unavailable');
  // A reply naming something outside the options is an error.
  const odd = { async choice() { return { selected: 'reboot', scores: { reboot: 1 } }; } };
  r = await createLoadAdvisor({ env: ON, endpoint: odd, verdict: fakeVerdict() }).judge({ cause: 'load', evidence: { text: 'odd' } });
  assert.deepEqual([r.outcome, r.classification.advisor], ['load_failed', 'error']);
});

test('one question at a time: a second failure while one is open is not asked', async () => {
  const svc = fakeService({ delayMs: 50 });
  const a = createLoadAdvisor({ env: ON, endpoint: svc, verdict: fakeVerdict() });
  const [one, two] = await Promise.all([a.judge({ cause: 'load', evidence: { text: 'odd' } }), a.judge({ cause: 'load', evidence: { text: 'odd too' } })]);
  assert.equal(svc.asked.length, 1);
  assert.equal(one.classification.advisor, 'used');
  assert.equal(two.classification.advisor, 'busy');
  // Free again afterwards.
  assert.equal((await a.judge({ cause: 'load', evidence: { text: 'odd' } })).classification.advisor, 'used');
});

test('an unusable verdict module returns null (the caller keeps its own outcome), never throws', async () => {
  const svc = fakeService();
  const logs = [];
  const a = createLoadAdvisor({ env: ON, endpoint: svc, verdict: () => { throw Object.assign(Error('module gone: /secret/path'), { reason: 'trap' }); }, log: (...m) => logs.push(m.join(' ')) });
  assert.equal(await a.judge({ cause: 'load', evidence: { text: 'odd' } }), null);
  assert.equal(svc.asked.length, 0);
  assert.ok(logs.every(l => !l.includes('/secret/path')));
});

test('evidence is bounded and printable before it reaches the verdict or the decision service', async () => {
  assert.equal(excerpt('a\u0000b\u001bc\nd\te'), 'a b c\nd\te');
  assert.equal(excerpt('x'.repeat(EXCERPT_UNITS + 10)).length, EXCERPT_UNITS);
  assert.equal(excerpt('\ud800').isWellFormed(), true);
  assert.equal(excerpt(null), '');
  const calls = [];
  await createLoadAdvisor({ env: ON, endpoint: null, verdict: fakeVerdict(calls) }).judge({ cause: 'bogus', evidence: { status: 99999, exitCode: 1.5, text: 'y'.repeat(9000) } });
  assert.deepEqual(calls[0].cause, 'load');
  assert.deepEqual([calls[0].evidence.status, calls[0].evidence.exitCode, calls[0].evidence.text.length], [null, null, EXCERPT_UNITS]);
});

test('with the real module: rules, advice on a tie, and a fixed reason', { skip: skipWasm }, async () => {
  davParseWasm.reset();
  const svc = fakeService({ label: 'template', confidence: 0.9 });
  const a = createLoadAdvisor({ env: ON, endpoint: svc });
  let r = await a.judge({ cause: 'load', evidence: { status: 500, text: 'ggml_vulkan: vk::Device::allocateMemory: ErrorOutOfDeviceMemory' } });
  assert.deepEqual([r.outcome, r.classification.source, r.classification.ruleId, r.classification.advisor], ['oom', 'rule', 'text_oom', 'not_asked']);
  r = await a.judge({ cause: 'load', evidence: { exitCode: 137, text: '' } });
  assert.deepEqual([r.outcome, r.classification.ruleId], ['oom', 'exit_killed']);
  r = await a.judge({ cause: 'oom', evidence: { status: 500, text: 'SYNTHETIC-MARKER process exited unexpectedly' } });
  assert.deepEqual([r.outcome, r.classification.source, r.classification.advisor], ['template', 'advisor', 'used']);
  assert.ok(!r.reason.includes('SYNTHETIC-MARKER'));
  assert.equal(svc.asked.length, 1);
  // Row failed with no text: nothing to read, nothing asked.
  r = await a.judge({ cause: 'load', evidence: { exitCode: 1, text: '' } });
  assert.deepEqual([r.outcome, r.classification.source, r.classification.advisor], ['load_failed', 'fallback', 'not_asked']);
  assert.equal(svc.asked.length, 1);
});
