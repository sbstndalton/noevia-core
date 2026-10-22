'use strict';
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}
// sbstndalton/noevia#2115, #2117: a local chat turn takes a lease on its model from the inference gate before its first
// request, says "waiting" while another chat's model is in use, sends the lease on every request of the turn (each
// round, the compaction summary and the title), and gives it back when the turn ends, however it ends. A refusal
// from the gate reaches the client with its code and whether trying again may help. Synthetic fakes only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { fakeGate } = require('./fixtures/fake-inference-gate.cjs');

const MODEL = 'route-smart';
const frame = (f) => Buffer.from('data: ' + JSON.stringify(f) + '\n\n');
const stream = (...frames) => ({ ok: true, status: 200, body: (async function* () { for (const f of frames) yield frame(f); })() });
const leaseOf = (init) => { const h = init?.headers || {}; return typeof h.get === 'function' ? h.get('X-Noevia-Lease') : h['X-Noevia-Lease']; };

async function turn(t, { gate = fakeGate(), toolRound = false, history = [], compactOnly = false, titles = true, stopWhileQueued = false, onQueued } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-2115-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], requests = [];
  const res = new EventEmitter(); res.writeHead = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  res.write = (chunk) => { for (const line of String(chunk).split('\n')) if (line.startsWith('data:')) { try { events.push(JSON.parse(line.slice(5))); } catch { /* not json */ } } };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body, lease: leaseOf(init) ?? null, at: events.length });
    if (body.stream === false) return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: body.max_tokens <= 64 ? 'Synthetic Title' : 'Synthetic summary of earlier turns.' } }] }), { status: 200 });
    if (toolRound && requests.filter((r) => r.body.stream).length === 1) return stream({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_synthetic_1', type: 'function', function: { name: 'synthetic_read', arguments: '{}' } }] } }] });
    return stream({ choices: [{ delta: { content: 'Synthetic answer.' } }] });
  };
  const controller = { aborted: false };
  const manager = {
    enabled: true,
    health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: MODEL, loaded: true, recipe_options: { ctx_size: 32768 } }] } }),
    inferenceBusy: () => gate.waiting() > 0,
    acquireLease: (model, options) => gate.acquire(model, { ...options, onQueued: (q) => { options.onQueued?.(q); onQueued?.(q); if (stopWhileQueued) { controller.aborted = true; res.emit('close'); } } }),
  };
  const { handleChat } = createChatHandler({
    modelManager: manager, reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 40, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', model: MODEL, assets: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: toolRound ? [{ type: 'function', function: { name: 'synthetic_read', parameters: { type: 'object' } } }] : [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (text) => ({ text: String(text) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => 'synthetic result', awaitApproval: async () => 'approve', stepSupervision: null,
    ...(titles ? { chatTitles: { save: () => true } } : {}),
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'QA-SYNTH-2115 Read it.', history, ...(compactOnly ? { compactOnly: true } : {}) });
  // The release runs on the response's finish/close; let it settle.
  await new Promise((resolve) => setImmediate(resolve));
  return { events, requests, gate, errors: events.filter((e) => e.type === 'error') };
}

test('noevia#2115: every request of a turn carries its lease: each round, then the title; the lease is given back at the end', async (t) => {
  const out = await turn(t, { toolRound: true });
  assert.deepEqual(out.errors, []);
  const rounds = out.requests.filter((r) => r.body.stream), title = out.requests.filter((r) => r.body.stream === false);
  assert.equal(rounds.length, 2, 'a tool round, then the answer');
  assert.equal(title.length, 1, 'the title');
  const token = rounds[0].lease;
  assert.match(String(token), /^[0-9a-f]{32}$/);
  for (const r of out.requests) assert.equal(r.lease, token, `${r.body.stream ? 'round' : 'title'} carries the turn's lease`);
  assert.deepEqual(out.gate.log.acquired, [MODEL], 'one lease for the whole turn');
  assert.deepEqual(out.gate.log.released, [MODEL], 'given back once the turn ended');
  assert.equal(out.events.some((e) => e.type === 'status' && e.id === 'waitingForModel'), false, 'no wait when the model is free');
});

test('noevia#2115: a turn waiting for another chat\'s model says so, then answers under its lease', async (t) => {
  const gate = fakeGate({ hold: true });
  const pending = turn(t, { gate, titles: false, onQueued: () => setTimeout(() => gate.grant(), 20) });
  const out = await pending;
  assert.deepEqual(out.errors, []);
  const waiting = out.events.find((e) => e.type === 'status' && e.id === 'waitingForModel');
  assert.ok(waiting, 'the waiting status is shown');
  assert.deepEqual(waiting.detail, { model: MODEL, position: 1, waitedSeconds: 0 });
  assert.match(waiting.text, /Waiting for another chat to finish with the local model/);
  const first = out.requests[0];
  assert.ok(first.at > out.events.indexOf(waiting), 'nothing was sent to the engine before the lease was granted');
  assert.match(String(first.lease), /^[0-9a-f]{32}$/);
  assert.deepEqual(out.gate.log.released, [MODEL]);
});

test('noevia#2115: a refusal from the gate ends the turn with its code and retryable flag, and nothing is sent', async (t) => {
  const refuse = { code: 'inference_queue_timeout', status: 503, retryable: true, message: 'Another chat was still using the local model. Try again when it has finished.' };
  const out = await turn(t, { gate: fakeGate({ refuse }) });
  assert.deepEqual(out.requests, []);
  assert.deepEqual(out.errors, [{ type: 'error', text: refuse.message, code: 'inference_queue_timeout', retryable: true }]);
  const full = await turn(t, { gate: fakeGate({ refuse: { code: 'inference_queue_full', status: 503, retryable: true, message: 'Too many requests are waiting for the local model. Try again shortly.' } }) });
  assert.equal(full.errors[0].code, 'inference_queue_full');
});

test('noevia#2115: Stop while waiting leaves the gate\'s queue; nothing is sent and no lease is left behind', async (t) => {
  const out = await turn(t, { gate: fakeGate({ hold: true }), stopWhileQueued: true });
  assert.deepEqual(out.requests, []);
  assert.deepEqual(out.gate.log.aborted, [MODEL], 'the wait was cancelled');
  assert.deepEqual(out.gate.log.acquired, []);
  assert.equal(out.gate.waiting(), 0);
});

test('noevia#2115: the compaction summary is part of the turn and carries its lease', async (t) => {
  const history = [];
  for (let i = 0; i < 12; i++) history.push({ role: 'user', content: `QA-SYNTH-2115 earlier question ${i} ` + 'x'.repeat(400) }, { role: 'assistant', content: `Synthetic earlier answer ${i} ` + 'y'.repeat(400) });
  const out = await turn(t, { history, compactOnly: true, titles: false });
  assert.deepEqual(out.errors, []);
  const summaries = out.requests.filter((r) => r.body.stream === false);
  assert.ok(summaries.length >= 1, 'a summary was asked for');
  for (const r of summaries) assert.match(String(r.lease), /^[0-9a-f]{32}$/);
  assert.deepEqual(out.gate.log.released, [MODEL]);
});

test('noevia#2115: a provider without a lease (no gate in front of the engine) runs the turn as before', async (t) => {
  const out = await turn(t, { gate: fakeGate({ absent: true }) });
  assert.deepEqual(out.errors, []);
  assert.ok(out.requests.length >= 1);
  for (const r of out.requests) assert.equal(r.lease, null);
});
