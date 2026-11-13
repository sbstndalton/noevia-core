'use strict';
// Track R8 (rust-chat-native.cjs): the hand-off of a prepared turn to the front's native executor, and its tool bridges.
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const native = require('./rust-chat-native.cjs');
const { createChatHandler } = require('./chat.cjs');
const { createToolboxes } = require('./toolboxes.cjs');
const { createDriveTools } = require('./gdrive-tools.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const grantFixture = require('../tests/server/chat-grant-fixture.cjs');

const SECRET = 'qa-front-secret-0123456789abcdef';

// One synthetic turn through the real handleChat: a manual project, the local default provider, a scripted engine.
async function runTurn(t, { handoff = null, requested = false, supervising = false, frames, headersFor = () => ({}), project: extra = {}, before = () => {}, headers = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-native-handoff-'));
  before(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const user = { id: 'qa-user', role: 'admin' };
  const project = { id: 'qa-project', name: 'QA Project', model: 'qa-model', routing: 'manual', toolboxes: ['core'], files: [], ...extra };
  const workspace = { userId: user.id, dir, assertActive() {}, transcripts: { appendIfLast: async () => 'saved' } };
  const store = { workspace: { userId: user.id }, authn: { user } };
  const requestScope = { getStore: () => store, run: (_s, fn) => fn() };
  const accounts = { forUser: () => ({ drive: { state: () => ({ state: 'connected' }) } }) };
  const driveTools = { ...createDriveTools({ accounts }), execute: async () => 'QA Drive result' };
  const toolbox = createToolboxes({ boxes: [driveTools.box], driveTools, offered: (id) => id !== 'gdrive', mcpBoxes: () => [], mcpTools: () => new Map(),
    prefill: { budgetFor: () => null, rateFor: () => 0 }, requestScope, scope: requestScope, documentSources: { notice: () => '' }, workspace: () => ({ dir }) });
  const events = [], requests = [];
  const res = new EventEmitter();
  res.writeHead = () => {};
  res.write = (line) => { if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); return true; };
  res.end = () => { if (res.writableEnded) return; res.writableEnded = true; process.nextTick(() => { res.emit('finish'); res.emit('close'); }); };
  const fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const handler = createChatHandler({
    fs, path, crypto, fetch, reasoningEffort: require('./reasoning-effort.cjs'), createToolExchange,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: require('./tool-result-reduce.cjs').reduceToolResult,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', DIARY_BASE: 'http://qa-diary.invalid', TOOL_RESULT_CAP: 8000,
    authService: { audit() {}, diaryEnabled: () => false }, toolPolicy: { mode: (_u, _t, write) => (write ? 'ask' : 'allow') },
    modelManager: { enabled: true, load: async () => ({ ok: true }), health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'qa-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    requestScope, currentWorkspace: () => workspace, json() {}, getProject: (id) => (id === project.id ? project : null),
    getProvider: () => ({ id: 'default', baseUrl: 'http://qa-engine.invalid', label: 'QA engine' }), providerHeaders: (p) => ({ 'Content-Type': 'application/json', ...headersFor(p) }),
    saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}), diaryExtras: require('./diary-extras.cjs'),
    autoRoles: () => null, lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [],
    missingRoles: () => [], staleRolesError: () => null, visionProbe: async () => ({ supported: false, reason: 'none' }), visionDescriptions: new Map(), skillsIndexFor: () => [],
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, chatToolRouter: { select: async (ids) => ({ ids, routed: false }) },
    ...toolbox, oauthServerIds: () => new Set(), accountReady: () => true,
    grantContext: async (raw) => grantFixture.context(raw, { holder: { kind: 'absent' } }), chatWideApproved: () => false, awaitApproval: async () => 'approve',
    recordUsage() {}, recordToolUse() {}, sourceWaitMs: 0,
    nativeHandoff: handoff || (requested ? { requested: () => true, supervising: () => supervising } : null),
  });
  const req = { headers: { ...headers } };
  await handler.handleChat(req, res, { message: 'QA hello', projectId: project.id, chatId: 'qa-chat-1', history: [] }, { user });
  await new Promise((resolve) => setImmediate(resolve));
  return { events, requests, req };
}
// The context meter and the first-token time carry the clock; everything else must match exactly.
const stable = (events) => events.map(({ updatedAt: _clock, timeToFirstToken: _first, ...rest }) => rest);
const answer = [{ choices: [{ delta: { content: 'QA answer.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];

test('the hand-off header is honoured only on a relayed turn with the per-start secret, and removed either way', () => {
  const handoff = native.createHandoff({ secret: SECRET, relayed: () => true });
  const asked = (value) => { const req = { headers: value === undefined ? {} : { [native.HANDOFF_HEADER]: value } }; return [handoff.requested(req), native.HANDOFF_HEADER in req.headers]; };
  assert.deepEqual(asked(SECRET), [true, false]);
  assert.deepEqual(asked(`${SECRET}x`), [false, false]);
  assert.deepEqual(asked('1'), [false, false]);
  assert.deepEqual(asked(undefined), [false, false]);
  assert.deepEqual(native.createHandoff({ secret: '' }).requested({ headers: { [native.HANDOFF_HEADER]: '' } }), false);
  // A request that did not come through the front's relay (rust-chat-turn.cjs) never hands off, whatever it carries.
  const direct = { headers: { [native.HANDOFF_HEADER]: SECRET } };
  assert.equal(native.createHandoff({ secret: SECRET }).requested(direct), false);
  assert.equal(native.HANDOFF_HEADER in direct.headers, false);
  // A browser's copy joined to the front's ("a, b") is not the secret.
  assert.equal(handoff.requested({ headers: { [native.HANDOFF_HEADER]: `x, ${SECRET}` } }), false);
  assert.equal(native.createHandoff({ secret: SECRET, supervising: () => { throw Error('unreadable'); } }).supervising(), true, 'an unreadable flag counts as on');
});

test('a turn the native executor can run ends after its preparation with the prepared state, and asks the engine nothing', async (t) => {
  const plain = await runTurn(t, { frames: answer });
  const handed = await runTurn(t, { requested: true, frames: answer });
  assert.equal(handed.requests.length, 0);
  const last = handed.events[handed.events.length - 1];
  assert.equal(last.type, 'prepared');
  assert.equal(last.v, native.PREPARED_VERSION);
  // The events before it are the ones Node sends before its rounds, in the same order.
  const before = handed.events.slice(0, -1).map((e) => e.type);
  assert.deepEqual(before, plain.events.slice(0, before.length).map((e) => e.type));
  assert.deepEqual(before, ['meta', 'telemetry', 'status', 'status', 'tools_scope']);
  // The wire is what the engine got in the same turn without the hand-off.
  assert.deepEqual(last.messages, plain.requests[0].messages);
  assert.deepEqual(last.tools, plain.requests[0].tools);
  assert.equal(last.model, 'qa-model');
  assert.equal(last.upstreamUrl, 'http://qa-engine.invalid/v1/chat/completions');
  assert.deepEqual(last.provider, { id: 'default', label: 'QA engine', localEngine: false, capabilities: null });
  assert.equal(JSON.stringify(last).includes('apiKey'), false);
  assert.ok(last.writes.includes('drive_trash_file') && !last.writes.includes('drive_read_file'));
  assert.deepEqual(last.chat.title, { chatId: 'qa-chat-1', listId: 'qa-project', firstMessage: 'QA hello', firstReply: true, enabled: false });
  assert.deepEqual(last.turn, { message: 'QA hello', spaceId: null, projectId: 'qa-project', declineEndsReply: true, record: true, streamIdleMs: 120000 });
  assert.equal(last.chat.grantScope, 'project:qa-project');
  assert.ok(Number.isFinite(last.startedAt) && last.startedAt <= Date.now());
});

test('a turn it cannot run goes on in Node, exactly as without the request', async (t) => {
  const plain = await runTurn(t, { frames: answer });
  const egress = require('./provider-egress.cjs');
  const guarded = { before: () => { egress.__setStreamGuardEnabledForTests(true); egress.setToolArgumentSchema('drive_read_file', { type: 'object' }); } };
  t.after(() => { egress.setToolArgumentSchema('drive_read_file', null); egress.__setStreamGuardEnabledForTests(false); });
  for (const [why, options] of [['step-supervision', { supervising: true }], ['provider-key', { headersFor: () => ({ Authorization: 'Bearer qa-key' }) }],
    ['deleted', { before: (dir) => require('./chat-lists.cjs').addTombstone(dir, 'qa-chat-1') }], ['stream-guard', guarded]]) {
    const logged = [];
    const log = console.log;
    console.log = (line) => logged.push(String(line));
    let kept;
    try { kept = await runTurn(t, { requested: true, frames: answer, ...options }); } finally { console.log = log; }
    assert.deepEqual(stable(kept.events), stable(plain.events), why);
    if (why === 'stream-guard') { egress.setToolArgumentSchema('drive_read_file', null); egress.__setStreamGuardEnabledForTests(false); }
    assert.equal(kept.requests.length, 1, why);
    assert.ok(logged.includes(`[chat] native executor not used for this turn: ${why}`), why);
  }
  // Not asked, or asked with the wrong value: nothing differs either, and the header is gone.
  for (const headers of [{}, { [native.HANDOFF_HEADER]: 'qa-guess' }]) {
    const asked = await runTurn(t, { handoff: native.createHandoff({ secret: SECRET, relayed: () => true }), frames: answer, headers });
    assert.deepEqual(stable(asked.events), stable(plain.events));
    assert.equal(native.HANDOFF_HEADER in asked.req.headers, false);
  }
});

test('refusal names the first part of the turn the native executor does not do yet', () => {
  const base = { diary: false, compactOnly: false, providerId: 'default', defaultProviderId: 'default', machine: false, external: false, chatgpt: false,
    routeTarget: false, authorized: false, images: false, messages: [{ role: 'user', content: 'x' }], skills: false, provenance: false,
    framingReasoner: false, narrowed: false, gate: false, supervision: false, injected: false, editTools: false };
  assert.equal(native.refusal(base), null);
  const cases = [['diary', { diary: true }], ['compact', { compactOnly: true }], ['provider', { providerId: 'qa-cloud' }], ['provider', { machine: true }],
    ['provider', { external: true }], ['provider', { chatgpt: true }], ['provider', { routeTarget: true }], ['provider-key', { authorized: true }],
    ['images', { images: true }], ['images', { messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }], ['skills', { skills: true }],
    ['provenance', { provenance: true }], ['framing-reasoner', { framingReasoner: true }], ['narrowed-tools', { narrowed: true }], ['tool-gate', { gate: true }],
    ['step-supervision', { supervision: true }], ['injected-sources', { injected: true }], ['edit-tools', { editTools: true }],
    ['deleted', { deleted: true }], ['stream-guard', { streamGuard: true }]];
  for (const [why, change] of cases) assert.equal(native.refusal({ ...base, ...change }), why, JSON.stringify(change));
});

// The bridges, through a fake loopback request.
function bridge(overrides = {}) {
  const calls = [];
  const handle = native.createToolBridge({
    secret: SECRET, json: (res, status, body) => { res.status = status; res.body = body; },
    readJson: async (req) => req.body, asUser: async (userId, fn) => { calls.push(['asUser', userId]); return fn(); },
    getProject: (id) => (id === 'qa-project' ? { id } : null),
    executeToolCall: async (project, name, args, allowed, signal, outcome, options) => {
      calls.push(['execute', project?.id || null, name, args, [...allowed], options.chatKey, options.exchangeKey, [...options.routes]]);
      if (name === 'qa_fails') outcome.failed = true;
      return `QA ${name} result`;
    },
    writeTargetFor: async (name, args, { user, chatKey }) => { calls.push(['target', name, args, user, chatKey]); return name === 'qa_write' ? { target: 'QA file', kind: 'drive' } : null; },
    recordToolUse: (ws, name) => calls.push(['recordToolUse', ws, name]), currentWorkspace: () => 'qa-ws', currentUser: () => ({ id: 'qa-user' }),
    ...overrides,
  });
  const call = async (url, body, { trusted = true, method = 'POST' } = {}) => {
    const req = new EventEmitter();
    Object.assign(req, { url, method, body, socket: { remoteAddress: trusted ? '127.0.0.1' : '10.0.0.9' }, headers: { 'x-noevia-store-token': SECRET } });
    const res = new EventEmitter();
    const handled = await handle(req, res);
    return { handled, status: res.status, body: res.body };
  };
  return { call, calls };
}

test('the execute bridge runs one call as the user and says whether it failed', async () => {
  const { call, calls } = bridge();
  const body = { user: 'qa-user', projectId: 'qa-project', name: 'drive_read_file', args: '{"fileId":"qa"}', allowed: ['drive_read_file'], routes: [['qa_mcp', 'qa-server']], chatKey: 'qa-chat-1', exchangeKey: 'qa-x' };
  assert.deepEqual(await call(native.EXECUTE_PATH, body), { handled: true, status: 200, body: { text: 'QA drive_read_file result', failed: false } });
  assert.deepEqual(calls, [['asUser', 'qa-user'], ['execute', 'qa-project', 'drive_read_file', '{"fileId":"qa"}', ['drive_read_file'], 'qa-chat-1', 'qa-x', [['qa_mcp', 'qa-server']]], ['recordToolUse', 'qa-ws', 'drive_read_file']]);
  assert.deepEqual((await call(native.EXECUTE_PATH, { ...body, name: 'qa_fails' })).body, { text: 'QA qa_fails result', failed: true });
  assert.deepEqual((await call(native.EXECUTE_PATH, { ...body, projectId: null })).status, 200);
  assert.deepEqual(await call(native.EXECUTE_PATH, { ...body, projectId: 'qa-gone' }), { handled: true, status: 404, body: { error: 'no such project' } });
  for (const bad of [{ user: '' }, { name: 3 }, { args: null }, { allowed: 'x' }, { routes: [['a']] }]) assert.equal((await call(native.EXECUTE_PATH, { ...body, ...bad })).status, 400, JSON.stringify(bad));
});

test('the target bridge describes a write, and neither bridge answers anyone but the front', async () => {
  const { call, calls } = bridge();
  const body = { user: 'qa-user', name: 'qa_write', args: '{}', chatKey: 'qa-chat-1' };
  assert.deepEqual((await call(native.TARGET_PATH, body)).body, { target: 'QA file', kind: 'drive' });
  assert.deepEqual(calls.at(-1), ['target', 'qa_write', '{}', { id: 'qa-user' }, 'qa-chat-1']);
  assert.deepEqual((await call(native.TARGET_PATH, { ...body, name: 'qa_read' })).body, {});
  assert.deepEqual(await call(native.TARGET_PATH, body, { trusted: false }), { handled: true, status: 404, body: { error: 'Not found' } });
  assert.equal((await call(native.EXECUTE_PATH, body, { method: 'GET' })).status, 404);
  assert.deepEqual(await call('/internal/chat/other', body), { handled: false, status: undefined, body: undefined });
  const thrown = bridge({ writeTargetFor: async () => { throw Error('QA Drive down'); } });
  assert.deepEqual((await thrown.call(native.TARGET_PATH, body)).body, { error: 'The file this would change could not be looked up' });
  const gone = bridge({ asUser: async () => { throw Object.assign(Error('no such account'), { status: 404 }); } });
  assert.deepEqual(await gone.call(native.TARGET_PATH, body), { handled: true, status: 404, body: { error: 'no such account' } });
  assert.deepEqual((await gone.call(native.EXECUTE_PATH, { ...body, allowed: [], routes: [] })).status, 404);
  assert.equal((await call(native.TARGET_PATH, { ...body, chatKey: 'x'.repeat(201) })).status, 400);
  const failing = bridge({ executeToolCall: async () => { throw Error('QA engine down'); } });
  assert.deepEqual((await failing.call(native.EXECUTE_PATH, { user: 'qa-user', name: 'x', args: '{}', allowed: [], routes: [] })), { handled: true, status: 500, body: { error: 'QA engine down' } });
});
