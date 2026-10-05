'use strict';
// The chat loop's tool-round paths as production runs them (no durable-turn recorder; #846 removed
// that dormant seam). Every assertion here held before the removal, with the seam not wired, and
// still holds after it. Synthetic provider, tool and approval gate only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { createStepSupervision } = require('./step-supervision.cjs');

const toolCallFrame = { choices: [{ delta: { content: 'Preamble', tool_calls: [{ index: 0, id: 'call-fixture', function: { name: 'synthetic_write', arguments: '{}' } }] } }] };
const stream = (...frames) => ({ ok: true, body: (async function* () { for (const f of frames) yield Buffer.from('data: ' + JSON.stringify(f) + '\n\n'); })() });

async function run(t, { second = 'text', toolThrows = false, stepSupervision = null, providerId = 'default', decision = 'approve_all' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-tool-round-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6))); res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [], decisions = [];
  let executions = 0;
  const baseUrl = `http://${providerId}.invalid`;
  const fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    if (requests.length === 1) return stream(toolCallFrame);
    if (second === 'stream-error') return stream({ error: { message: 'synthetic provider overload' } });
    if (second === 'throw') throw Error('mock model died');
    return stream({ choices: [{ delta: { content: 'synthetic final answer' } }] });
  };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', model: 'answer-model', assets: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: providerId, baseUrl }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [],
    toolPolicy: { mode: (_user, _name, write) => (write ? 'ask' : 'allow') }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [{ type: 'function', function: { name: 'synthetic_write', parameters: { type: 'object' } } }], dropped: [] }), isWriteTool: () => true,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => { executions++; if (toolThrows) throw Error('connection lost after write'); return 'complete synthetic result'; },
    awaitApproval: async (args) => { decisions.push(Object.keys(args).sort()); return decision === 'approve_all' ? 'approve' : decision; },
    stepSupervision,
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'synthetic write' });
  return { events, requests, decisions, executions };
}
const errors = (r) => r.events.filter((e) => e.type === 'error');
const supervisor = (action) => createStepSupervision({ enabled: () => true, provider: { decide: async () => ({ action }) } });

test('an approved write runs once, the next round carries its framed, reduced result, and the reply completes', async (t) => {
  const r = await run(t);
  assert.equal(r.executions, 1); assert.equal(r.requests.length, 2);
  assert.equal(r.decisions.length, 1, 'one approval card');
  for (const key of ['abortSignal', 'chatId', 'id', 'userId']) assert.ok(r.decisions[0].includes(key), key);
  assert.match(r.requests[1].body.messages.at(-1).content, /^<untrusted kind="tool result"[^\n]*\nreduced\n<\/untrusted>$/);
  assert.ok(r.events.some((e) => e.type === 'done')); assert.deepEqual(errors(r), []);
});

test('a provider stream error after a tool round ends the reply with that error and nothing else runs', async (t) => {
  const r = await run(t, { second: 'stream-error' });
  assert.equal(r.executions, 1); assert.equal(r.requests.length, 2);
  assert.equal(errors(r).length, 1); assert.match(errors(r)[0].text, /The model stream failed/);
});

test('a model request that throws after a tool round reports the error without re-running the write', async (t) => {
  const r = await run(t, { second: 'throw' });
  assert.equal(r.executions, 1); assert.equal(r.requests.length, 2);
  assert.ok(errors(r).length >= 1);
});

test('a write whose execution throws is not retried: its chip gets the error and the model gets one more round', async (t) => {
  const r = await run(t, { toolThrows: true });
  assert.equal(r.executions, 1); assert.equal(r.requests.length, 2);
  assert.match(r.events.find((e) => e.type === 'tool_result').text, /^ERROR calling synthetic_write: connection lost after write/);
  assert.equal(r.requests[1].body.messages.at(-1).role, 'tool');
  assert.ok(r.events.some((e) => e.type === 'done'));
});

test('a declined write is not executed', async (t) => {
  const r = await run(t, { decision: 'deny' });
  assert.equal(r.executions, 0);
});

test('step supervision: verify adds a round on the same provider; escalate pauses after one; neither repeats the write', async (t) => {
  for (const providerId of ['default', 'openrouter-fixture', 'openai-fixture']) {
    const v = await run(t, { stepSupervision: supervisor('verify'), providerId });
    assert.equal(v.executions, 1); assert.equal(v.requests.length, 2);
    for (const req of v.requests) assert.ok(req.url.startsWith(`http://${providerId}.invalid`), `${providerId}: ${req.url}`);
    assert.match(v.requests[1].body.messages.at(-1).content, /Check the preceding/);
  }
  const e = await run(t, { stepSupervision: supervisor('escalate') });
  assert.equal(e.executions, 1); assert.equal(e.requests.length, 1);
  assert.equal(e.events.find((x) => x.type === 'paused')?.reason, 'supervision');
});

test('a thrown write still reaches step supervision once, and escalation stops before another round', async (t) => {
  let calls = 0;
  const counting = createStepSupervision({ enabled: () => true, provider: { decide: async () => { calls++; return { action: 'escalate' }; } } });
  const r = await run(t, { toolThrows: true, stepSupervision: counting });
  assert.equal(r.executions, 1); assert.equal(r.requests.length, 1); assert.equal(calls, 1);
  assert.equal(r.events.find((x) => x.type === 'paused')?.reason, 'supervision');
});
