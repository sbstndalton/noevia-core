'use strict';
// #1640: the decision service's answer must carry a confidence, or decide()'s minConfidence bound
// throws it away. Every caller is driven the way server/index.cjs wires it (decision settings ->
// endpoint -> decision layer) against a synthetic decision service on loopback that answers in Laya's
// real shape ({selected, scores, model, calibrated:false}; noevia-services laya/server.py). Synthetic
// text only; no model, no Diary, nothing leaves 127.0.0.1.
const test = require('node:test');
const skipWasm = !require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
// Guards a wrong test signature (options passed twice makes node:test take the second object as the body, so the body never runs and the
// test reports ok): when the module is there, every guarded body must have run.
let ran = 0;
const assert = require('node:assert/strict');
const http = require('node:http');
const rm = require('./routing-modes.cjs');
const { createDecisions } = require('./decision/index.cjs');
const { createDecisionSettings } = require('./decision-settings.cjs');
const { createDecisionEndpoint } = require('./decision-endpoint.cjs');
const { createToolGate } = require('./tool-gate.cjs');
const { createStepSupervision } = require('./step-supervision.cjs');

const HANG = Symbol('hang');
// #1647: the replies come from a synthetic model that reports its identity and sits on a test-only
// qualified list, so these tests exercise the confidence path; the gate itself (the shipped list has no
// qualified model): sensitivity-qualification-1647.test.cjs.
const SYN_IDENTITY = { model: 'synthetic/sensitivity-test', revision: 'a'.repeat(40) };
const SYN_QUALIFIED = [{ ...SYN_IDENTITY, evidence: { set: 'synthetic', sensitiveRecall: 1, measured: '2026-10-13' } }];
const laya = (selected, scores, extra = {}) => ({ json: { selected, scores, model: SYN_IDENTITY.model, model_revision: SYN_IDENTITY.revision, calibrated: false, ...extra } });

/** A synthetic decision service. `reply(body)` returns { json } | { text, status } | HANG. */
async function fakeService(t, reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null; try { parsed = JSON.parse(body); } catch { /* recorded as null */ }
      seen.push(parsed);
      const r = typeof reply === 'function' ? reply(parsed) : reply;
      if (r === HANG) return; // never answers
      res.writeHead(r.status || 200, { 'content-type': 'application/json' });
      res.end(typeof r.text === 'string' ? r.text : JSON.stringify(r.json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/** The production chain from server/index.cjs: settings -> backend -> one decision layer per purpose. */
function stack(url, { sensitivityDeadlineMs } = {}) {
  const map = new Map();
  const settings = createDecisionSettings({ store: { get: (k) => map.get(k), set: (k, v) => map.set(k, v) }, env: {} });
  settings.save({ url, timeoutMs: 1500 }, 'admin');
  const backend = settings.backend();
  const logs = [];
  const decisions = createDecisions({ backends: { configured: backend }, chains: { 'routing.sensitivity': ['configured'], 'tool.gate': ['configured'] },
    log: (entry) => logs.push(rm.decisionCodes(entry)) });
  const checkLogs = [];
  const check = rm.createSensitivity({ decide: decisions.decide, log: (e) => checkLogs.push(e), qualified: SYN_QUALIFIED,
    ...(sensitivityDeadlineMs ? { deadlineMs: () => sensitivityDeadlineMs } : {}) });
  return { backend, decisions, check, logs, checkLogs };
}

/** Hybrid routing with a cloud target, as chat.cjs asks it. `asked` records every card shown. */
async function route(check, digest) {
  const asked = [];
  const out = await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: () => check(digest),
    ask: async (flag) => { asked.push(flag); return { choice: 'timeout' }; } });
  return { out, asked };
}

const SENSITIVE_TEXT = 'Synthetic test: my fictional friend Ada has a made-up diagnosis.';
const BENIGN_TEXT = 'Synthetic test: how do widgets work?';

// ── The endpoint ─────────────────────────────────────────────────────────────

test('#1640: the endpoint answers with the winning option share as confidence, uncalibrated, from the scores only', async (t) => {
  // Laya's own reply carries no revision (noevia-services laya/server.py), so it has no identity (#1647).
  const svc = await fakeService(t, laya('sensitive', { sensitive: 0.97, not_sensitive: 0.03 }, { model: 'convaiinnovations/laya', model_revision: undefined }));
  const endpoint = createDecisionEndpoint({ env: { COWORK_DECISION_URL: svc.url } });
  const two = [{ id: 'sensitive', label: 'a' }, { id: 'not_sensitive', label: 'b' }];
  const result = await endpoint.choice({ state: 'synthetic', question: 'q', options: two });
  assert.equal(result.confidence, 0.97);
  assert.deepEqual(result.metadata, { calibrated: false, model: 'convaiinnovations/laya' });
  // A confidence the service claims for itself is ignored: only the validated probability map counts.
  const claims = await fakeService(t, laya('not_sensitive', { sensitive: 0.45, not_sensitive: 0.55 }, { confidence: 0.99 }));
  const other = createDecisionEndpoint({ env: { COWORK_DECISION_URL: claims.url } });
  assert.equal((await other.choice({ state: 'synthetic', question: 'q', options: two })).confidence, 0.55);
});

// ── The sensitivity check (routing.sensitivity) ─────────────────────────────

test('#1640: "sensitive" at 0.97 from the decision service flags the turn and the card is shown', async (t) => {
  const svc = await fakeService(t, laya('sensitive', { sensitive: 0.97, not_sensitive: 0.03 }));
  const s = stack(svc.url);
  assert.deepEqual(await s.check(SENSITIVE_TEXT), { flagged: true, flag: 'router' });
  const { out, asked } = await route(s.check, SENSITIVE_TEXT);
  assert.deepEqual(asked, ['router'], 'the "This looks sensitive" card is asked for');
  assert.deepEqual(out, { route: 'local', reason: 'fail-closed', flag: 'router' }, 'an unanswered card stays local');
  // The request went to the service once per check, with cloud forbidden and the router's two options.
  assert.equal(svc.seen.length, 2);
  assert.deepEqual(svc.seen[0].options.map((o) => o.id), ['sensitive', 'not_sensitive']);
  // The decision log keeps the confidence it acted on (a number now), and no text.
  const answer = s.logs.find((e) => e.source === 'configured');
  assert.equal(answer.confidence, 0.97);
  assert.equal(JSON.stringify([s.logs, s.checkLogs]).includes('Ada'), false);
  assert.deepEqual(s.checkLogs.map((e) => e.verdict), ['router', 'router']);
});

test('#1640: "not sensitive" at 0.97 clears the turn for cloud, without a card', async (t) => {
  const svc = await fakeService(t, laya('not_sensitive', { sensitive: 0.03, not_sensitive: 0.97 }));
  const s = stack(svc.url);
  assert.deepEqual(await s.check(BENIGN_TEXT), { flagged: false, flag: null });
  const { out, asked } = await route(s.check, BENIGN_TEXT);
  assert.deepEqual(out, { route: 'cloud', reason: 'mode' });
  assert.deepEqual(asked, []);
});

test('#1640: the 0.6 bound is a share of at least 0.6 (a 0.2 margin with two options): 0.6 clears, 0.59 stays local', async (t) => {
  const at = await fakeService(t, laya('not_sensitive', { sensitive: 0.4, not_sensitive: 0.6 }));
  assert.deepEqual(await stack(at.url).check(BENIGN_TEXT), { flagged: false, flag: null });
  const under = await fakeService(t, laya('not_sensitive', { sensitive: 0.41, not_sensitive: 0.59 }));
  assert.deepEqual(await stack(under.url).check(BENIGN_TEXT), { flagged: true, flag: 'unavailable', cause: 'low-confidence' });
});

test('#1640 fail safe: low scores, a timeout and garbled or failed replies keep the turn local, with no card', async (t) => {
  const cases = [
    ['low not-sensitive', laya('not_sensitive', { sensitive: 0.45, not_sensitive: 0.55 }), 'low-confidence'],
    ['low not-sensitive claiming 0.99', laya('not_sensitive', { sensitive: 0.45, not_sensitive: 0.55 }, { confidence: 0.99 }), 'low-confidence'],
    ['low sensitive', laya('sensitive', { sensitive: 0.55, not_sensitive: 0.45 }), 'low-confidence'],
    ['not JSON', { text: 'sensitive? probably not' }, 'parse'],
    ['empty body', { text: '' }, 'empty-response'],
    ['no scores', { json: { selected: 'not_sensitive', model: 'convaiinnovations/laya', calibrated: false } }, 'invalid-result'],
    ['scores not a distribution', laya('not_sensitive', { sensitive: 0.5, not_sensitive: 0.9 }), 'invalid-result'],
    ['selected is not the top score', laya('not_sensitive', { sensitive: 0.97, not_sensitive: 0.03 }), 'invalid-result'],
    ['an option it was not offered', laya('maybe', { maybe: 0.97, not_sensitive: 0.03 }), 'invalid-result'],
    ['a refused request', { status: 422, json: { detail: 'synthetic' } }, 'http-422'],
    ['a busy service', { status: 503, json: {} }, 'http-503'],
    ['a service that never answers', HANG, 'deadline'],
  ];
  for (const [name, reply, cause] of cases) {
    const svc = await fakeService(t, reply);
    const s = stack(svc.url, { sensitivityDeadlineMs: 300 });
    const verdict = await s.check(BENIGN_TEXT);
    assert.deepEqual(verdict, { flagged: true, flag: 'unavailable', cause }, name);
    const { out, asked } = await route(s.check, BENIGN_TEXT);
    assert.equal(out.route, 'local', name);
    assert.equal(out.reason, 'check-unavailable', name);
    assert.deepEqual(asked, [], `${name}: a check that could not answer shows no card (#1421)`);
  }
});

test('#1640 fail safe: an answer without a numeric confidence never clears a turn, even if decide() lets it through', async () => {
  // A decide() that does not apply minConfidence itself (not the production layer) answering
  // "not sensitive" with no confidence, or a non-finite one: the check fails closed on its own.
  for (const confidence of [undefined, null, NaN, '0.97', Infinity]) {
    const check = rm.createSensitivity({ qualified: SYN_QUALIFIED, decide: async () => ({ selected: 'not_sensitive', scores: { sensitive: 0.03, not_sensitive: 0.97 }, confidence, source: 'configured', metadata: { identity: SYN_IDENTITY } }) });
    assert.deepEqual(await check(BENIGN_TEXT), { flagged: true, flag: 'unavailable', cause: 'low-confidence' }, String(confidence));
  }
});

test('#1640: the decision layer bound needs a finite number: null or a numeric string falls back as low-confidence', async () => {
  for (const [confidence, passes] of [[0.97, true], [0.6, true], [0.59, false], [null, false], ['0.97', false], [NaN, false], [Infinity, false]]) {
    const decisions = createDecisions({ backends: { b: { locality: 'local', supports: () => true,
      decide: async () => ({ selected: 'not_sensitive', scores: { sensitive: 0.03, not_sensitive: 0.97 }, confidence }) } }, chains: { 'routing.sensitivity': ['b'] } });
    const r = await decisions.decide({ kind: 'choice', purpose: 'routing.sensitivity', question: 'q', context: { cloud: 'forbidden', stateText: 'SYNTHETIC' },
      options: [{ id: 'sensitive', label: 'a' }, { id: 'not_sensitive', label: 'b' }], constraints: { deadlineMs: 1000, minConfidence: 0.6 }, fallback: { selected: null, scores: {} } });
    assert.equal(r.source, passes ? 'b' : 'fallback', String(confidence));
    if (!passes) assert.equal(r.metadata.fellBack, 'low-confidence', String(confidence));
  }
});

// ── The tool gate (tool.gate): reads scores[selected], the same share ───────

const TIME_TOOL = { type: 'function', function: { name: 'core_time', description: 'Current time', parameters: { type: 'object', properties: {} } } };
const pick = (selected, share) => (body) => laya(selected, Object.fromEntries(body.options.map((o) => [o.id, o.id === selected ? share : (1 - share) / (body.options.length - 1)])));

{
  test('#1640: the tool gate through the decision service agrees on the share', { skip: skipWasm }, async (t) => {
    ran++;
    const run = async (reply) => {
      const svc = await fakeService(t, reply);
      const s = stack(svc.url);
      const logs = [];
      const gate = createToolGate({ enabled: () => true, decide: s.decisions.decide, isWriteTool: () => false, limits: () => s.backend.limits,
        log: (e) => logs.push(e), warn: () => {} });
      return { r: await gate.evaluate('How long until the synthetic meeting?', [TIME_TOOL]), logs, s };
    };
    const sure = await run(pick('core_time', 0.97));
    assert.deepEqual(sure.r.decision, { tool: 'core_time', mode: 'require' });
    assert.equal(sure.r.confidence, 0.97);
    // The decision layer's confidence and the gate's are one number.
    assert.equal(sure.s.logs.find((e) => e.source === 'configured').confidence, 0.97);
    const unsure = await run(pick('core_time', 0.55));
    assert.equal(unsure.r.decision, 'none');
    assert.equal(unsure.logs.at(-1).reason, 'low-confidence');
    const garbled = await run({ text: '{"selected":' });
    assert.equal(garbled.r.decision, 'none');
  });
}

// ── Step supervision: reads the validated scores, not confidence ─────────────

test('#1640: step supervision through the decision service bounds a read-only escalate by its scores', async (t) => {
  const run = async (scores) => {
    const svc = await fakeService(t, laya(Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0], scores));
    const s = stack(svc.url);
    const logs = [];
    const supervisor = createStepSupervision({ enabled: () => true, deadlineMs: 1500, log: (e) => logs.push(e),
      provider: { decide: (...args) => s.backend.supervise(...args) } });
    const messages = [{ role: 'user', content: 'Synthetic: tidy my widget list' }, { role: 'tool', content: 'SYNTHETIC tool output' }];
    return { d: await supervisor.decide({ round: 0, messages }), logs };
  };
  assert.equal((await run({ continue: 0.02, verify: 0.01, escalate: 0.97 })).d.action, 'escalate');
  const weak = await run({ continue: 0.3, verify: 0.2, escalate: 0.5 });
  assert.equal(weak.d.action, 'continue');
  assert.equal(weak.logs.at(-1).fellBack, 'weak-escalate');
  assert.equal((await run({ continue: 0.97, verify: 0.02, escalate: 0.01 })).d.action, 'continue');
});

test.after(() => { if (!skipWasm) assert.equal(ran, 1, 'a wasm-guarded test body did not run'); });
