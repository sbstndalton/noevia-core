'use strict';
// #1574: a local reply that goes silent after its first output is ended with a named error after the idle
// limit, instead of sitting until the browser reports "network error" minutes later. Nothing is limited before
// the first output, nor for a cloud provider. Synthetic provider stream only; no model is loaded.

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler, withIdleLimit } = require('./chat.cjs');

const frame = (text) => Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const forever = () => new Promise(() => {});

async function run(t, { providerId = 'default', streamIdleMs, body }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-stream-idle-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6))); res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body), signal: init.signal });
    return { ok: true, body: body() };
  };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange: () => async () => 'unused',
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', model: 'answer-model', assets: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: providerId, baseUrl: `http://${providerId}.invalid` }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: async () => ({ supported: false, reason: 'synthetic' }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {}, executeToolCall: async () => 'unused', awaitApproval: async () => 'deny',
    ...(streamIdleMs === undefined ? {} : { streamIdleMs }),
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'synthetic question' });
  return { events, requests };
}
const errors = (r) => r.events.filter((e) => e.type === 'error');

test('a local reply that goes silent after its first output is ended with a named error, and no second round runs', async (t) => {
  const r = await run(t, {
    streamIdleMs: 100,
    body: () => (async function* () { yield frame('Thinking about it'); await forever(); })(),
  });
  assert.equal(errors(r).length, 1, JSON.stringify(r.events));
  assert.match(errors(r)[0].text, /^The model sent no output for 0\.1 s after it started, so the reply was ended\. No tool ran for this step\./);
  assert.equal(r.requests.length, 1, 'no second round starts after the error');
});

test('the wait before the first output is not limited (a long prefill is not a stall)', async (t) => {
  const r = await run(t, {
    streamIdleMs: 100,
    body: () => (async function* () { await pause(250); yield frame('late but fine'); })(),
  });
  assert.deepEqual(errors(r), [], JSON.stringify(r.events));
  assert.ok(r.events.some((e) => e.type === 'delta' && e.text === 'late but fine'));
});

test('a cloud provider is not limited by the local idle limit', async (t) => {
  const r = await run(t, {
    providerId: 'cloud-fixture', streamIdleMs: 100,
    body: () => (async function* () { yield frame('first'); await pause(250); yield frame(' second'); })(),
  });
  assert.deepEqual(errors(r), [], JSON.stringify(r.events));
  assert.equal(r.events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'first second');
});

test('withIdleLimit passes every chunk through when the limit is 0 and ends with the source', async () => {
  const seen = [];
  for await (const chunk of withIdleLimit((async function* () { yield 'a'; yield 'b'; })(), 0)) seen.push(chunk);
  assert.deepEqual(seen, ['a', 'b']);
});

test('withIdleLimit throws once the source is silent past the limit, after output has started', async () => {
  const gen = withIdleLimit((async function* () { yield 'a'; await forever(); })(), 100);
  const seen = [];
  await assert.rejects(async () => { for await (const chunk of gen) seen.push(chunk); }, (err) => err.name === 'StreamIdleError' && err.ms === 100);
  assert.deepEqual(seen, ['a']);
});

test('a stalled local stream aborts the upstream request, so the engine slot is released (#1584)', async (t) => {
  const r = await run(t, {
    streamIdleMs: 100,
    body: () => (async function* () { yield frame('Thinking about it'); await forever(); })(),
  });
  assert.equal(errors(r).length, 1, JSON.stringify(r.events));
  assert.match(errors(r)[0].text, /^The model sent no output for 0\.1 s/);
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].signal.aborted, true, 'the request signal was aborted when the reply was ended');
});

test('a healthy local stream leaves its request signal alone (#1584)', async (t) => {
  const r = await run(t, { streamIdleMs: 100, body: () => (async function* () { yield frame('fine'); })() });
  assert.deepEqual(errors(r), [], JSON.stringify(r.events));
  assert.equal(r.requests[0].signal.aborted, false);
});

test('withIdleLimit calls onIdle before it throws, and not when the source ends on time (#1584)', async () => {
  const order = [];
  const gen = withIdleLimit((async function* () { yield 'a'; await forever(); })(), 80, () => order.push('idle'));
  await assert.rejects(async () => { for await (const _ of gen) order.push('chunk'); }, (err) => { order.push(err.name); return true; });
  assert.deepEqual(order, ['chunk', 'idle', 'StreamIdleError']);
  const quiet = [];
  for await (const _ of withIdleLimit((async function* () { yield 'a'; yield 'b'; })(), 80, () => quiet.push('idle'))) quiet.push('chunk');
  assert.deepEqual(quiet, ['chunk', 'chunk']);
});
