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
async function runTurn(t, { handoff = null, requested = false, caps = [], supervising = false, frames, headersFor = () => ({}), project: extra = {}, before = () => {}, headers = {}, deps = {}, history = [], boxes = {}, body: extraBody = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-native-handoff-'));
  before(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const user = { id: 'qa-user', role: 'admin' };
  const project = { id: 'qa-project', name: 'QA Project', model: 'qa-model', routing: 'manual', toolboxes: ['core'], files: [], ...extra };
  const workspace = { userId: user.id, dir, assertActive() {}, assetDir: () => path.join(dir, 'assets'), transcripts: { appendIfLast: async () => 'saved' } };
  const store = { workspace: { userId: user.id }, authn: { user } };
  const requestScope = { getStore: () => store, run: (_s, fn) => fn() };
  const accounts = { forUser: () => ({ drive: { state: () => ({ state: 'connected' }) } }) };
  const driveTools = { ...createDriveTools({ accounts }), execute: async () => 'QA Drive result' };
  const toolbox = createToolboxes({ boxes: [driveTools.box], driveTools, offered: (id) => id !== 'gdrive', mcpBoxes: () => [], mcpTools: () => new Map(),
    prefill: { budgetFor: () => null, rateFor: () => 0 }, requestScope, scope: requestScope, documentSources: { notice: () => '' }, workspace: () => ({ dir }), ...boxes });
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
    nativeHandoff: handoff || (requested ? { requested: () => true, capabilities: () => new Set(caps), supervising: () => supervising } : null),
    ...deps,
  });
  const req = { headers: { ...headers } };
  await handler.handleChat(req, res, { message: 'QA hello', projectId: project.id, chatId: 'qa-chat-1', history, ...extraBody }, { user });
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
  assert.deepEqual(last.turn, { message: 'QA hello', spaceId: null, projectId: 'qa-project', declineEndsReply: true, record: true, streamIdleMs: 120000,
    sources: { reply: [], injected: [] }, compactOnly: false });
  assert.equal(last.chat.grantScope, 'project:qa-project');
  assert.ok(Number.isFinite(last.startedAt) && last.startedAt <= Date.now());
  assert.equal(last.managerEnabled, true);
  assert.equal(last.modelLease, false, 'this test manager grants no lease');
});

test('a turn with injected knowledge files hands off with what the attribution after the reply needs (#1793)', async (t) => {
  const files = [{ name: 'qa-notes.txt', content: 'QA ORCHID-42 notes', attachment: { id: 'qa-att-1' } }, { name: 'qa-placed.txt', content: 'QA placed' },
    { name: 'qa-unread.txt', content: '', document: { state: 'failed' } }];
  const placed = [{ file: 'qa-placed.txt', body: '[Page 3]\nQA placed text', kind: 'excerpt', score: 0.51234 }];
  const injected = [{ file: 'qa-placed.txt', body: 'QA placed text', kind: 'file' }, { file: 'qa-notes.txt', body: 'QA ORCHID-42 notes', kind: 'file' },
    { file: 'qa-unread.txt', body: 'QA unread', kind: 'file' }, { file: 'qa-notes.txt', body: 'QA excerpt', kind: 'excerpt' }, { file: 'qa-notes.txt', body: null, kind: 'file' }];
  const rag = { filesContext: async (_id, _readable, _q, _u, onPlaced) => { onPlaced(placed, injected); return 'QA files block'; } };
  const handed = await runTurn(t, { requested: true, frames: answer, project: { files }, deps: { rag } });
  const last = handed.events[handed.events.length - 1];
  assert.equal(last.type, 'prepared', 'injected sources no longer keep the turn in Node');
  const sources = require('./chat-sources.cjs');
  assert.deepEqual(last.turn.sources.reply, sources.buildSources(placed, files));
  assert.equal(last.turn.sources.reply[0].page, 3);
  assert.deepEqual(last.turn.sources.injected, [
    { file: 'qa-notes.txt', text: 'QA ORCHID-42 notes', item: sources.buildSources([injected[1]], files)[0] },
    { file: 'qa-unread.txt', text: 'QA unread', item: null },
    { file: 'qa-notes.txt', text: '', item: sources.buildSources([injected[4]], files)[0] },
  ]);
  // The reply's first `sources` event went out before the cut, as without the hand-off.
  assert.deepEqual(handed.events.find((e) => e.type === 'sources')?.sources, last.turn.sources.reply);
});

// A project image source (chat.cjs projectImages): a synthetic 1x1 PNG in the project's asset directory.
const QA_PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000' + '01f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c10000000049454e44ae426082', 'hex');
const imageProject = { assets: [{ id: 'qa-asset-1', name: 'qa-image.png', mime: 'image/png' }] };
const withImage = (bytes = QA_PNG) => (dir) => { fs.mkdirSync(path.join(dir, 'assets'), { recursive: true }); fs.writeFileSync(path.join(dir, 'assets', 'qa-asset-1'), bytes); };
const statusIds = (events) => events.filter((e) => e.type === 'status').map((e) => e.id);

test('a turn whose attached image the answering model can see hands off with the image parts on its last user message', async (t) => {
  const deps = { visionProbe: async () => ({ supported: true }) };
  const plain = await runTurn(t, { frames: answer, project: imageProject, before: withImage(), deps });
  const handed = await runTurn(t, { requested: true, frames: answer, project: imageProject, before: withImage(), deps });
  const last = handed.events.at(-1);
  assert.equal(last.type, 'prepared', 'attached images no longer keep the turn in Node');
  assert.equal(handed.requests.length, 0);
  assert.deepEqual(last.messages, plain.requests[0].messages, 'the wire is what the engine got without the hand-off');
  assert.deepEqual(last.messages.at(-1), { role: 'user', content: [
    { type: 'text', text: `QA hello\n\n(Attached images: ${require('./quoted-name.cjs').quotedNames(['qa-image.png'])})` },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${QA_PNG.toString('base64')}` } }] });
  assert.deepEqual(handed.events.slice(0, -1).map((e) => e.type), ['meta', 'telemetry', 'status', 'status', 'tools_scope']);
  assert.deepEqual(statusIds(handed.events), ['readingImages', 'generating']);
});

test('a turn whose attached image the model cannot see hands off without it, with the warning and the note sent before the cut', async (t) => {
  const deps = { visionProbe: async () => ({ supported: false, reason: 'QA engine has no image input.' }) };
  const plain = await runTurn(t, { frames: answer, project: imageProject, before: withImage(), deps });
  const handed = await runTurn(t, { requested: true, frames: answer, project: imageProject, before: withImage(), deps });
  const last = handed.events.at(-1);
  assert.equal(last.type, 'prepared');
  assert.deepEqual(last.messages, plain.requests[0].messages);
  assert.ok(last.messages.every((m) => typeof m.content === 'string'), 'Node cleared the image');
  assert.match(last.messages[0].content, /image input is currently unavailable for qa-model: QA engine has no image input\./);
  assert.deepEqual(handed.events.filter((e) => e.type === 'warning').map((e) => e.text), ['Images were not read. QA engine has no image input.']);
  assert.deepEqual(handed.events.slice(0, -1).map((e) => e.type), plain.events.slice(0, handed.events.length - 1).map((e) => e.type));
});

test('a turn whose prepared frame would be longer than the front reads stays in Node (frame-size)', async (t) => {
  const deps = { visionProbe: async () => ({ supported: true }) };
  // Base64 makes 3 bytes 4: these bytes alone make the frame longer than PREPARED_CAP.
  const big = Buffer.alloc(Math.ceil(native.PREPARED_CAP * 0.75) + 64, 0x51);
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(String(line));
  let kept;
  try { kept = await runTurn(t, { requested: true, frames: answer, project: imageProject, before: withImage(big), deps }); } finally { console.log = log; }
  assert.notEqual(kept.events.at(-1).type, 'prepared');
  assert.equal(kept.requests.length, 1, 'Node ran the turn');
  assert.equal(kept.requests[0].messages.at(-1).content[1].image_url.url.length, 'data:image/png;base64,'.length + Math.ceil(big.length / 3) * 4);
  assert.ok(logged.includes('[chat] native executor not used for this turn: frame-size'));
});

test('injectedSources keeps the part of a file the attribution reads, and refuses a name that is not text', () => {
  const long = 'é'.repeat(30000) + '😀';
  const out = native.injectedSources({ injected: [{ file: 'qa-a.txt', body: long, kind: 'file' }], placed: [], readable: [{ name: 'qa-a.txt', content: 'x' }], reply: [] });
  assert.equal(out.injected[0].text.length, require('./chat-sources.cjs').ATTRIBUTE_MAX);
  assert.deepEqual(native.injectedSources({}), { reply: [], injected: [] });
  const base = { chatIdNotText: false, deleted: false, diary: false, compactOnly: false, providerId: 'default', defaultProviderId: 'default', machine: false, external: false,
    chatgpt: false, routeTarget: false, authorized: false, images: false, messages: [], skills: false, provenance: false, framingReasoner: false, narrowed: false, gate: false,
    supervision: false, injected: false, pageSave: false };
  assert.equal(native.refusal(base), null);
  assert.equal(native.refusal({ ...base, injected: true }), 'injected-sources');
});

test('an injected entry whose name is not text keeps the turn in Node', async (t) => {
  const rag = { filesContext: async (_id, _r, _q, _u, onPlaced) => { onPlaced([], [{ file: 42, body: 'QA AA-11', kind: 'file' }]); return 'QA block'; } };
  const handed = await runTurn(t, { requested: true, frames: answer, project: { files: [{ name: 'qa-a.txt', content: 'QA' }] }, deps: { rag } });
  assert.notEqual(handed.events[handed.events.length - 1].type, 'prepared');
  assert.equal(handed.requests.length, 1, 'Node ran the turn');
});

test('a turn whose text holds a character the executor cannot read (U+10F800..U+10FFFF) stays in Node', async (t) => {
  assert.equal(native.reservedText(JSON.stringify({ a: 'QA \u{10F800}' })), true);
  assert.equal(native.reservedText(JSON.stringify({ a: 'QA \u{10FFFF}' })), true);
  assert.equal(native.reservedText(JSON.stringify({ a: 'QA \u{10F7FF} \ud83d\ude00 \udbfe' })), false, 'a lone surrogate is readable');
  assert.equal(native.reservedText(undefined), true);
  const rag = { filesContext: async (_id, _r, _q, _u, onPlaced) => { onPlaced([], [{ file: 'qa-a.txt', body: 'QA \u{10FABC} text', kind: 'file' }]); return 'QA block \u{10FABC}'; } };
  const handed = await runTurn(t, { requested: true, frames: answer, project: { files: [{ name: 'qa-a.txt', content: 'QA' }] }, deps: { rag } });
  assert.notEqual(handed.events[handed.events.length - 1].type, 'prepared');
  assert.equal(handed.requests.length, 1, 'Node ran the turn');
  const plain = await runTurn(t, { requested: true, frames: answer, project: { files: [{ name: 'qa-a.txt', content: 'QA' }] } });
  assert.equal(plain.events[plain.events.length - 1].type, 'prepared');
});

test('a compaction-only turn (the Compact action) is handed off with its flag and no turn record', async (t) => {
  const history = [{ role: 'user', content: 'QA earlier question' }, { role: 'assistant', content: 'QA earlier answer' }];
  const handed = await runTurn(t, { requested: true, frames: answer, history, body: { compactOnly: true } });
  const last = handed.events[handed.events.length - 1];
  assert.equal(last.type, 'prepared');
  assert.equal(last.turn.compactOnly, true);
  assert.equal(last.turn.record, false, 'chat.cjs keeps no turn record for a compaction');
  assert.equal(handed.requests.length, 0);
});

test('the prepared frame says the front holds the model lease and runs the title, and Node takes no lease of its own', async (t) => {
  const leases = [];
  const manager = { enabled: true, load: async () => ({ ok: true }), acquireLease: async (model) => { leases.push(model); return null; },
    health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'qa-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) };
  const titles = { save() { throw Error('Node must not save the title of a handed-off turn'); }, autoNamed: () => true };
  const history = [{ role: 'user', content: 'QA first question' }, { role: 'assistant', content: 'QA first answer' }];
  const handed = await runTurn(t, { requested: true, frames: answer, history, deps: { modelManager: manager, chatTitles: titles } });
  const last = handed.events.at(-1);
  assert.equal(last.type, 'prepared');
  assert.equal(last.modelLease, true);
  assert.equal(last.managerEnabled, true);
  assert.deepEqual(last.chat.title, { chatId: 'qa-chat-1', listId: 'qa-project', firstMessage: 'QA first question', firstReply: false, enabled: true });
  assert.deepEqual(leases, [], 'the lease is the front\'s from the cut: this process asked the gate for none');
  assert.equal(handed.requests.length, 0);
  // The same turn without the hand-off takes the lease here, as always.
  await runTurn(t, { frames: answer, history, deps: { modelManager: manager } });
  assert.deepEqual(leases, ['qa-model']);
});

test('a refusal input that throws keeps the turn in Node instead of failing it', async (t) => {
  const plain = await runTurn(t, { frames: answer });
  const egress = require('./provider-egress.cjs');
  const validate = egress.validateToolArguments;
  t.after(() => { egress.validateToolArguments = validate; });
  const throwing = [
    ['supervising', { handoff: { requested: () => true, supervising: () => { throw Error('QA flag store down'); } } }],
    ['stream guard', { requested: true, before: () => { egress.validateToolArguments = () => { throw Error('QA schema broken'); }; } }],
  ];
  for (const [what, options] of throwing) {
    const logged = [], warned = [];
    const log = console.log, warn = console.warn;
    console.log = (line) => logged.push(String(line));
    console.warn = (...a) => warned.push(a.join(' '));
    let kept;
    try { kept = await runTurn(t, { frames: answer, ...options }); } finally { console.log = log; console.warn = warn; egress.validateToolArguments = validate; }
    assert.deepEqual(stable(kept.events), stable(plain.events), what);
    assert.equal(kept.requests.length, 1, what);
    assert.ok(logged.includes('[chat] native executor not used for this turn: refusal-input'), what);
    assert.ok(warned.some((line) => line.startsWith('[chat] native executor refusal inputs could not be read: QA ')), what);
  }
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
    routeTarget: false, authorized: false, attachedImages: 0, retrievedImages: false, messages: [{ role: 'user', content: 'x' }], provenance: false,
    framingReasoner: false, narrowed: false, gate: false, supervision: false, injected: false, pageSave: false };
  assert.equal(native.refusal(base), null);
  const cases = [['diary', { diary: true }], ['provider', { providerId: 'qa-cloud' }], ['provider', { machine: true }],
    ['provider', { external: true }], ['provider', { chatgpt: true }], ['provider', { routeTarget: true }], ['provider-key', { authorized: true }],
    ['retrieved-images', { retrievedImages: true }], ['retrieved-images', { retrievedImages: true, attachedImages: 1 }],
    ['images', { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'QA' } }] }] }],
    ['images', { messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: 'data:image/png;base64,QQ==' }] }] }],
    ['images', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 42 } }] }] }],
    ['images', { messages: [{ role: 'user', content: [{ type: 'text', text: null }] }] }],
    ['images', { messages: [{ role: 'user', content: [null] }] }], ['images', { messages: [{ role: 'user', content: [['x']] }] }],
    ['images', { messages: [{ role: 'assistant', content: null }] }], ['images', { messages: [{ role: 'user', content: { type: 'text', text: 'x' } }] }],
    ['skills', { skills: true }],
    ['provenance', { provenance: true }], ['framing-reasoner', { framingReasoner: true }], ['narrowed-tools', { narrowed: true }], ['tool-gate', { gate: true }],
    ['step-supervision', { supervision: true }], ['injected-sources', { injected: true }], ['page-save', { pageSave: true }],
    ['deleted', { deleted: true }], ['stream-guard', { streamGuard: true }], ['chat-id', { chatIdNotText: true }]];
  for (const [why, change] of cases) assert.equal(native.refusal({ ...base, ...change }), why, JSON.stringify(change));
  // Attached images the answering model is handed (text and image parts on the last user message) are the executor's.
  const parts = [{ type: 'text', text: 'QA hello\n\n(Attached images: "qa-image.png")' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } }];
  assert.equal(native.refusal({ ...base, attachedImages: 1, messages: [{ role: 'system', content: 'QA' }, { role: 'user', content: parts }] }), null);
  assert.equal(native.refusal({ ...base, messages: [{ role: 'user', content: [] }] }), null, 'an empty list carries nothing the executor cannot');
});

test('refusals lists every reason in refusal\'s order; refusal is its first', () => {
  const base = { providerId: 'default', defaultProviderId: 'default', messages: [{ role: 'user', content: 'x' }] };
  assert.deepEqual(native.refusals(base), []);
  const all = { ...base, provenance: true, narrowed: true, supervision: true, skills: true };
  assert.deepEqual(native.refusals(all), ['skills', 'provenance', 'narrowed-tools', 'step-supervision']);
  assert.equal(native.refusal(all), 'skills');
  // A check that throws (no messages list) is left out of the log's list; refusal() still answers as before.
  assert.deepEqual(native.refusals({ providerId: 'default', defaultProviderId: 'default', chatIdNotText: true }), ['chat-id']);
  assert.equal(native.refusal({ chatIdNotText: true }), 'chat-id');
});

test('a provenance policy turn hands off only to a front naming provenance, and its frame says so (#769, R15)', async (t) => {
  const on = { provenancePolicy: { enabled: () => true } };
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(String(line));
  let kept, both;
  try {
    kept = await runTurn(t, { requested: true, caps: ['skills', 'once'], frames: answer, deps: on });
    both = await runTurn(t, { requested: true, caps: ['skills', 'once'], supervising: true, frames: answer, deps: on });
  } finally { console.log = log; }
  assert.notEqual(kept.events.at(-1).type, 'prepared');
  assert.equal(kept.requests.length, 1, 'Node ran the turn');
  assert.ok(logged.includes('[chat] native executor not used for this turn: provenance'));
  // What else would keep it here is logged on its own line (names only); nothing else for a plain turn.
  assert.equal(logged.filter((l) => l.startsWith('[chat] native executor would also need:')).length, 1);
  assert.ok(logged.includes('[chat] native executor would also need: step-supervision'));
  assert.equal(both.requests.length, 1);
  const handed = await runTurn(t, { requested: true, caps: ['skills', 'once', 'provenance'], frames: answer, deps: on });
  assert.equal(handed.events.at(-1).type, 'prepared');
  assert.equal(handed.events.at(-1).provenance, true);
  assert.equal(handed.requests.length, 0, 'the front runs the rounds');
  // A flag read that throws counts as on (as chat.cjs's own taint store reads it).
  const threw = await runTurn(t, { requested: true, caps: ['provenance'], frames: answer, deps: { provenancePolicy: { enabled: () => { throw new Error('QA flag'); } } } });
  assert.equal(threw.events.at(-1).provenance, true);
  // Off (or no policy): no key, so the frame is the one earlier executors read; the capability alone changes nothing.
  for (const deps of [{}, { provenancePolicy: { enabled: () => false } }]) {
    const off = await runTurn(t, { requested: true, caps: ['provenance'], frames: answer, deps });
    assert.equal(off.events.at(-1).type, 'prepared');
    assert.equal('provenance' in off.events.at(-1), false);
  }
  // Still in Node with a step supervisor even for a front naming provenance (the next reason, R15's table).
  const supervised = await runTurn(t, { requested: true, caps: ['provenance'], supervising: true, frames: answer, deps: on });
  assert.equal(supervised.requests.length, 1);
});

test('a turn whose routed tools were narrowed hands off only to a front naming more-tools, with what more_tools widens to (R15)', async (t) => {
  // The router keeps the first selected box only (chat-tool-routing.cjs answers narrowed when it drops some).
  const narrow = { chatToolRouter: { select: async (ids) => ({ ids: ids.slice(0, 1), routed: true, narrowed: ids.length > 1 }) } };
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(String(line));
  let kept;
  try { kept = await runTurn(t, { requested: true, caps: ['skills', 'once', 'provenance'], frames: answer, deps: narrow }); } finally { console.log = log; }
  assert.equal(kept.requests.length, 1, 'Node ran the turn');
  assert.ok(logged.includes('[chat] native executor not used for this turn: narrowed-tools'));
  assert.ok(kept.requests[0].tools.some((tool) => tool.function.name === 'more_tools'));
  const handed = await runTurn(t, { requested: true, caps: ['more-tools'], frames: answer, deps: narrow });
  const frame = handed.events.at(-1);
  assert.equal(frame.type, 'prepared');
  const offered = frame.tools.map((tool) => tool.function.name);
  assert.ok(offered.includes('more_tools'), 'the narrowed list carries more_tools');
  assert.ok(!offered.some((n) => n.startsWith('drive_')), 'the Drive box was routed away');
  const widened = frame.widen.tools.map((tool) => tool.function.name);
  assert.ok(widened.includes('drive_read_file') && widened.includes('drive_create_file') && !widened.includes('more_tools'));
  assert.deepEqual(frame.widen.writes, widened.filter((n) => ['drive_create_file', 'drive_update_file', 'drive_trash_file'].includes(n)));
  assert.deepEqual(Object.keys(frame.widen), ['tools', 'routes', 'writes', 'public', 'editTools', 'onceTools', 'asked']);
  // Every name the resolution read the policy for, in order, with its write class and answer (none blocked here).
  assert.deepEqual(frame.widen.asked.map(([n]) => n), widened);
  assert.ok(frame.widen.asked.every(([n, write, blocked]) => write === frame.widen.writes.includes(n) && blocked === false));
  assert.deepEqual(frame.widen.routes, []);
  // A tool only the widened list offers counts for the checks on what the turn may offer (here the stream guard's).
  const egress = require('./provider-egress.cjs');
  egress.__setStreamGuardEnabledForTests(true);
  egress.setToolArgumentSchema('drive_read_file', { type: 'object' });
  const guardLog = [];
  console.log = (line) => guardLog.push(String(line));
  let guarded;
  try { guarded = await runTurn(t, { requested: true, caps: ['more-tools'], frames: answer, deps: narrow }); }
  finally { console.log = log; egress.setToolArgumentSchema('drive_read_file', null); egress.__setStreamGuardEnabledForTests(false); }
  assert.equal(guarded.requests.length, 1, 'Node ran the turn');
  assert.ok(guardLog.includes('[chat] native executor not used for this turn: stream-guard'));
  // Not narrowed (or the router off): no `widen` key, the frame earlier executors read.
  const plain = await runTurn(t, { requested: true, caps: ['more-tools'], frames: answer });
  assert.equal(plain.events.at(-1).type, 'prepared');
  assert.equal('widen' in plain.events.at(-1), false);
});

test('frameTooLarge refuses a prepared line longer than the front reads (PREPARED_CAP bytes of UTF-8)', () => {
  assert.equal(native.PREPARED_CAP, 40 * 1024 * 1024);
  assert.equal(native.frameTooLarge('x'.repeat(native.PREPARED_CAP)), false);
  assert.equal(native.frameTooLarge('x'.repeat(native.PREPARED_CAP + 1)), true);
  assert.equal(native.frameTooLarge('é'.repeat(native.PREPARED_CAP / 2) + 'x'), true, 'counted in bytes, not characters');
  assert.equal(native.frameTooLarge(null), true);
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
    recordUsage: (ws, model, reported) => calls.push(['recordUsage', ws, model, reported]), recordSample: (...a) => calls.push(['recordSample', ...a]),
    ...overrides,
  });
  const call = async (url, body, { trusted = true, method = 'POST' } = {}) => {
    const req = new EventEmitter();
    Object.assign(req, { url, method, body, socket: { remoteAddress: trusted ? '127.0.0.1' : '10.0.0.9' }, headers: { 'x-noevia-store-token': SECRET } });
    const res = new EventEmitter();
    res.end = () => {};
    const handled = await handle(req, res);
    return { handled, status: res.status ?? res.statusCode, body: res.body };
  };
  return { call, calls };
}

test('the busy bridge counts what the asking turn holds; a bad count is one', async () => {
  const seen = [];
  const { call } = bridge({ modelManager: { enabled: true, inferenceBusy: (n) => { seen.push(n); return n < 2; } } });
  const p = `${native.NATIVE_PREFIX}busy`;
  assert.deepEqual((await call(p, { user: 'qa-user', own: 2 })).body, { busy: false });
  for (const own of [0, 9, 1.5, '2', null]) assert.deepEqual((await call(p, { user: 'qa-user', own })).body, { busy: true });
  assert.deepEqual(seen, [2, 1, 1, 1, 1, 1]);
});

test('the abort bridge aborts the running calls of an exchange, which still answer', async () => {
  const started = [];
  const { call } = bridge({
    executeToolCall: async (project, name, args, allowed, signal) => {
      started.push(name);
      await new Promise((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true })));
      return `QA ${name} stopped`;
    },
  });
  const body = { user: 'qa-user', projectId: 'qa-project', name: 'drive_read_file', args: '{}', allowed: ['drive_read_file'], routes: [], chatKey: 'qa-chat-1', exchangeKey: 'qa-x' };
  const running = call(native.EXECUTE_PATH, body);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['drive_read_file']);
  // Another user's or another exchange's abort reaches nothing.
  assert.equal((await call(native.ABORT_PATH, { user: 'qa-other', exchangeKey: 'qa-x' })).status, 204);
  assert.equal((await call(native.ABORT_PATH, { user: 'qa-user', exchangeKey: 'qa-y' })).status, 204);
  let done = false;
  running.then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  assert.equal((await call(native.ABORT_PATH, { user: 'qa-user', exchangeKey: 'qa-x' })).status, 204);
  assert.deepEqual((await running).body, { text: 'QA drive_read_file stopped', failed: false });
  assert.equal((await call(native.ABORT_PATH, { user: 'qa-user' })).status, 400);
  assert.equal((await call(native.ABORT_PATH, { user: 'qa-user', exchangeKey: 'qa-x' }, { trusted: false })).status, 404);
});

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
  assert.equal((await call(native.TARGET_PATH, { ...body, chatKey: 'x'.repeat(401) })).status, 400);
  assert.equal((await call(native.TARGET_PATH, { ...body, chatKey: 'x'.repeat(400) })).status, 200, 'the chat id cap of the title bridges');
  const failing = bridge({ executeToolCall: async () => { throw Error('QA engine down'); } });
  assert.deepEqual((await failing.call(native.EXECUTE_PATH, { user: 'qa-user', name: 'x', args: '{}', allowed: [], routes: [] })), { handled: true, status: 500, body: { error: 'QA engine down' } });
});

test('the usage and prefill bridges record what a native reply used, in this process', async () => {
  const { call, calls } = bridge();
  const reported = { promptTokens: 40, completionTokens: 4, totalTokens: 44, tokensPerSecond: null };
  assert.deepEqual(await call(native.USAGE_PATH, { user: 'qa-user', model: 'qa-model', reported }), { handled: true, status: 204, body: undefined });
  assert.deepEqual(calls.at(-1), ['recordUsage', 'qa-ws', 'qa-model', reported]);
  for (const bad of [{ reported: { ...reported, promptTokens: -1 } }, { reported: { ...reported, tokensPerSecond: 'x' } }, { model: '' }, { reported: [] }]) {
    assert.equal((await call(native.USAGE_PATH, { user: 'qa-user', model: 'qa-model', reported, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(await call(native.PREFILL_PATH, { user: 'qa-user', model: 'qa-model', promptTokens: 52, firstTokenMs: 310 }), { handled: true, status: 204, body: undefined });
  assert.deepEqual(calls.at(-2), ['asUser', 'qa-user']);
  assert.deepEqual(calls.at(-1), ['recordSample', 'qa-model', 52, 310]);
  for (const bad of [{ promptTokens: 0 }, { user: undefined }, { model: 'qa\u0000model' }]) {
    assert.equal((await call(native.PREFILL_PATH, { user: 'qa-user', model: 'qa-model', promptTokens: 52, firstTokenMs: 310, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call(native.USAGE_PATH, { user: 'qa-user', model: 'qa\nmodel', reported })).status, 400, 'a control character in model');
  const gone = bridge({ asUser: async () => { throw Object.assign(Error('no such account'), { status: 404 }); } });
  assert.deepEqual(await gone.call(native.PREFILL_PATH, { user: 'qa-gone', model: 'qa-model', promptTokens: 52, firstTokenMs: 310 }), { handled: true, status: 404, body: { error: 'no such account' } });
  assert.deepEqual(await gone.call(native.USAGE_PATH, { user: 'qa-gone', model: 'qa-model', reported }), { handled: true, status: 404, body: { error: 'no such account' } });
  assert.equal((await call(native.USAGE_PATH, { user: 'qa-user', model: 'qa-model', reported }, { trusted: false })).status, 404);
});

test('the native fact bridges answer through the functions chat.cjs calls, as the user', async () => {
  const seen = [];
  const { call, calls } = bridge({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'qa-model', loaded: true }] } }),
      load: async (...a) => { seen.push(['load', ...a]); return { ok: true }; }, inferenceBusy: (n) => { seen.push(['busy', n]); return true; } },
    templateToolsGate: { allowsTools: async (manager, model) => { seen.push(['allows', model]); return model !== 'qa-no-tools'; }, markUnsupported: (model) => seen.push(['unsupported', model]) },
    chatTitles: { autoNamed: (list, chat, first) => { seen.push(['autoNamed', list, chat, first]); return true; }, save: (...a) => seen.push(['save', ...a]) },
  });
  const p = (op) => `${native.NATIVE_PREFIX}${op}`;
  const user = 'qa-user', token = '0123456789abcdef0123456789abcdef';
  assert.deepEqual((await call(p('health'), { user })).body, { ok: true, body: { all_models_loaded: [{ model_name: 'qa-model', loaded: true }] } });
  assert.deepEqual((await call(p('load'), { user, model: 'qa-model', lease: token })).body, { ok: true });
  assert.deepEqual((await call(p('tools-allowed'), { user, model: 'qa-model' })).body, { allowed: true });
  assert.deepEqual((await call(p('tools-allowed'), { user, model: 'qa-no-tools' })).body, { allowed: false });
  assert.equal((await call(p('tools-unsupported'), { user, model: 'qa-model' })).status, 204);
  assert.deepEqual((await call(p('busy'), { user })).body, { busy: true });
  const title = { user, listId: 'qa-project', chatId: 'qa-chat-1', firstMessage: 'QA hello' };
  assert.deepEqual((await call(p('title-auto-named'), title)).body, { autoNamed: true });
  assert.equal((await call(p('title-save'), { ...title, title: 'QA Title' })).status, 204);
  assert.equal(calls.filter(([what, who]) => what === 'asUser' && who === user).length, 8, 'every fact ran as the user');
  // The load runs inside the front's lease (no second lease from the gate), with the caller's abort signal.
  const [, model, options, signal, extra] = seen[0];
  assert.deepEqual([seen[0][0], model, options], ['load', 'qa-model', {}]);
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.deepEqual(Object.keys(extra), ['lease']);
  assert.deepEqual(extra.lease.headers(), { 'X-Noevia-Lease': token });
  assert.deepEqual(seen.slice(1), [['allows', 'qa-model'], ['allows', 'qa-no-tools'], ['unsupported', 'qa-model'], ['busy', 1],
    ['autoNamed', 'qa-project', 'qa-chat-1', 'QA hello'], ['save', 'qa-project', 'qa-chat-1', 'QA Title', 'QA hello']]);
  // With no gate the front holds no lease (null): chat.cjs's load without one.
  seen.length = 0;
  assert.deepEqual((await call(p('load'), { user, model: 'qa-model', lease: null })).body, { ok: true });
  assert.equal(seen[0].length, 4, 'no lease argument');
  assert.ok(seen[0][3] instanceof AbortSignal);
  const bad = [['load', { user, model: 'qa-model' }], ['load', { user, model: 'qa-model', lease: '' }], ['load', { user, model: 'qa-model', lease: 'a b' }],
    ['load', { user, model: 'qa-model', lease: 'x'.repeat(201) }], ['load', { user, model: 'qa-model', lease: 7 }], ['load', { user, lease: token }],
    ['tools-allowed', { user, model: 'qa\u0000model' }], ['tools-unsupported', { user, model: 'qa\u001fmodel' }], ['load', { user, model: 'qa\u007fmodel', lease: token }],
    ['title-save', title], ['title-auto-named', { ...title, chatId: '' }], ['title-auto-named', { ...title, chatId: 'x'.repeat(401) }]];
  for (const op of ['health', 'load', 'tools-allowed', 'tools-unsupported', 'busy', 'title-auto-named', 'title-save']) bad.push([op, { model: 'qa-model', lease: token, ...title, title: 'QA', user: undefined }]);
  seen.length = 0;
  for (const [op, b] of bad) assert.equal((await call(p(op), b)).status, 400, `${op} ${JSON.stringify(b)}`);
  assert.deepEqual(seen, [], 'nothing ran for a refused request');
  assert.equal((await call(p('title-auto-named'), { ...title, chatId: 'x'.repeat(400), firstMessage: 'x'.repeat(2 * 1024 * 1024) })).status, 200, 'the caps of a chat request');
  assert.equal((await call(p('health'), { user }, { trusted: false })).status, 404);
  assert.deepEqual(await call(`${native.NATIVE_PREFIX}other`, { user }), { handled: false, status: undefined, body: undefined });
});

test('the tool-used bridge counts a call the front answered, as the user (track R13)', async () => {
  const p = `${native.NATIVE_PREFIX}tool-used`;
  const { call, calls } = bridge();
  assert.equal((await call(p, { user: 'qa-user', name: 'read_project_file' })).status, 204);
  assert.deepEqual(calls, [['asUser', 'qa-user'], ['recordToolUse', 'qa-ws', 'read_project_file']]);
  calls.length = 0;
  for (const b of [{ user: 'qa-user' }, { user: 'qa-user', name: '' }, { user: 'qa-user', name: 7 }, { user: 'qa-user', name: 'x'.repeat(201) }, { name: 'read_project_file' }]) {
    assert.equal((await call(p, b)).status, 400, JSON.stringify(b));
  }
  assert.deepEqual(calls.filter(([what]) => what === 'recordToolUse'), [], 'nothing counted for a refused request');
  assert.equal((await call(p, { user: 'qa-user', name: 'read_project_file' }, { trusted: false })).status, 404);
  const gone = bridge({ asUser: async () => { throw Object.assign(Error('no such account'), { status: 404 }); } });
  assert.deepEqual(await gone.call(p, { user: 'qa-gone', name: 'read_project_file' }), { handled: true, status: 404, body: { error: 'no such account' } });
});

test('a fact bridge refuses a gone account, says when the manager is off, and never sends a failure\'s detail', async () => {
  const p = (op) => `${native.NATIVE_PREFIX}${op}`;
  const user = 'qa-user', token = '0123456789abcdef0123456789abcdef';
  const gone = bridge({ asUser: async () => { throw Object.assign(Error('no such account'), { status: 404 }); }, modelManager: { enabled: true, load: async () => ({ ok: true }) } });
  for (const [op, b] of [['health', { user }], ['load', { user, model: 'qa-model', lease: token }], ['tools-allowed', { user, model: 'qa-model' }],
    ['tools-unsupported', { user, model: 'qa-model' }], ['busy', { user }], ['title-auto-named', { user, chatId: 'qa-chat-1', firstMessage: 'QA' }]]) {
    assert.deepEqual(await gone.call(p(op), b), { handled: true, status: 404, body: { error: 'no such account' } }, op);
  }
  const off = bridge({ modelManager: { enabled: false, load: async () => { throw Error('must not load'); } } });
  assert.deepEqual(await off.call(p('health'), { user }), { handled: true, status: 409, body: { enabled: false } });
  assert.deepEqual(await off.call(p('load'), { user, model: 'qa-model', lease: token }), { handled: true, status: 409, body: { enabled: false } });
  const none = bridge({ modelManager: null });
  assert.deepEqual(await none.call(p('load'), { user, model: 'qa-model', lease: null }), { handled: true, status: 409, body: { enabled: false } });
  const logged = [];
  const failing = bridge({ log: (line) => logged.push(line),
    modelManager: { enabled: true, health: async () => { throw Error('fetch failed http://qa-manager.invalid:13305/health'); }, load: async () => { throw Error('QA load detail'); } } });
  assert.deepEqual(await failing.call(p('health'), { user }), { handled: true, status: 500, body: { error: 'the fact could not be read' } });
  assert.deepEqual(await failing.call(p('load'), { user, model: 'qa-model', lease: token }), { handled: true, status: 500, body: { error: 'the fact could not be read' } });
  assert.deepEqual(logged, ['[chat] native health bridge failed: fetch failed http://qa-manager.invalid:13305/health', '[chat] native load bridge failed: QA load detail']);
});

test('the load bridge stops the load when the front goes away', async () => {
  let signal;
  const handle = native.createToolBridge({ secret: SECRET, json: (res, status, body) => { res.status = status; res.body = body; }, readJson: async (req) => req.body,
    asUser: async (_u, fn) => fn(), log() {},
    modelManager: { enabled: true, load: (_m, _o, s) => { signal = s; return new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(s.reason), { once: true })); } } });
  const req = new EventEmitter();
  Object.assign(req, { url: `${native.NATIVE_PREFIX}load`, method: 'POST', body: { user: 'qa-user', model: 'qa-model', lease: null }, socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-noevia-store-token': SECRET } });
  const res = new EventEmitter();
  res.end = () => {};
  const done = handle(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, false);
  res.emit('close');
  await done;
  assert.equal(signal.aborted, true);
});

test('chatNativeAsUser (createAsUser) refuses a missing, disabled or removed account and runs a standing one', async (t) => {
  const { AsyncLocalStorage } = require('node:async_hooks');
  const { createWorkspaceStore } = require('./workspace.cjs');
  const { createStubStore } = require('../tests/server/project-store-stub.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-native-asuser-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const QA = '11111111-2222-4333-8444-000000000001', DISABLED = '11111111-2222-4333-8444-000000000002', REMOVED = '11111111-2222-4333-8444-000000000003';
  // The users table as index.cjs reads it, and the rows the workspace store believes in (the front removed REMOVED's).
  const rows = new Map([[QA, { id: QA, disabled_at: null }], [DISABLED, { id: DISABLED, disabled_at: '2026-11-01T00:00:00Z' }], [REMOVED, { id: REMOVED, disabled_at: null }]]);
  const live = new Set([QA, DISABLED]);
  const workspaceStore = createWorkspaceStore(root, { id: 'local', label: 'Local', baseUrl: '', apiKey: '' }, null, { projectStore: createStubStore(root), userExists: (id) => live.has(id) });
  const scope = new AsyncLocalStorage();
  // index.cjs diaryAsUser and currentWorkspace, over the real workspace store.
  const runAs = (userId, fn) => scope.run({ workspace: workspaceStore.get(userId) }, fn);
  const currentWorkspace = () => { const ws = scope.getStore()?.workspace; if (!ws) throw Error('authenticated workspace context required'); return ws; };
  const asUser = native.createAsUser({ userRow: (id) => rows.get(id), runAs, currentWorkspace });
  assert.equal(await asUser(QA, async () => currentWorkspace().userId), QA);
  const refused = (e) => e.status === 404 && e.message === 'no such account';
  for (const who of ['qa-nobody', DISABLED, REMOVED]) await assert.rejects(async () => asUser(who, async () => 'ran'), refused, who);
  assert.throws(() => workspaceStore.get(REMOVED), (e) => e.status === 410, 'the store\'s own answer is 410');
  // A workspace revoked while held.
  const revoked = native.createAsUser({ userRow: (id) => rows.get(id), runAs: (_id, fn) => scope.run({ workspace: { revoked: true } }, fn), currentWorkspace });
  await assert.rejects(async () => revoked(QA, async () => 'ran'), refused);
  // A 410 from the call itself (a tool's own answer) is not the account's.
  await assert.rejects(async () => asUser(QA, async () => { throw Object.assign(Error('QA upstream gone'), { status: 410 }); }), (e) => e.status === 410 && e.message === 'QA upstream gone');
  // Through the bridge: the refusal is the 404, not a 500.
  const { call } = bridge({ asUser, recordSample() {} });
  assert.deepEqual(await call(native.PREFILL_PATH, { user: REMOVED, model: 'qa-model', promptTokens: 52, firstTokenMs: 310 }), { handled: true, status: 404, body: { error: 'no such account' } });
  assert.equal((await call(native.PREFILL_PATH, { user: QA, model: 'qa-model', promptTokens: 52, firstTokenMs: 310 })).status, 204);
});

// A Project documents box as MCP discovery offers it (noevia's own server): the two edit tools and a read.
const DOCS_TOOL = (name) => ({ type: 'function', function: { name, description: `QA ${name}`, parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } });
const DOCS_BOX = { id: 'qa-docs', label: 'QA documents', source: 'mcp', server: 'qa-internal',
  tools: ['project_read_file', 'project_append_file', 'project_replace_text'].map(DOCS_TOOL), reads: ['project_read_file'] };
const docsBoxes = { mcpBoxes: () => [DOCS_BOX], mcpTools: () => new Map(DOCS_BOX.tools.map((t) => [t.function.name, { readOnly: t.function.name === 'project_read_file', serverId: 'qa-internal' }])) };

test('a turn offering the project edit tools hands off and names them; one offering the coworker page save hands off only to a front naming once', async (t) => {
  const handed = await runTurn(t, { requested: true, frames: answer, project: { toolboxes: ['core', 'qa-docs'] }, boxes: docsBoxes });
  const last = handed.events.at(-1);
  assert.equal(last.type, 'prepared', 'the edit tools no longer keep the turn in Node');
  assert.deepEqual(last.editTools, ['project_append_file', 'project_replace_text']);
  assert.ok(last.writes.includes('project_append_file') && last.writes.includes('project_replace_text') && !last.writes.includes('project_read_file'));
  assert.deepEqual(last.routes.filter(([n]) => n.startsWith('project_')).map(([, s]) => s), ['qa-internal', 'qa-internal', 'qa-internal']);
  // As chat.cjs decides (index.cjs wires projectEditTool to noevia's own server): a name it does not count is not listed.
  const narrowed = await runTurn(t, { requested: true, frames: answer, project: { toolboxes: ['core', 'qa-docs'] }, boxes: docsBoxes, deps: { projectEditTool: (n) => n === 'project_replace_text' } });
  assert.deepEqual(narrowed.events.at(-1).editTools, ['project_replace_text']);
  const plain = await runTurn(t, { requested: true, frames: answer });
  assert.deepEqual(plain.events.at(-1).editTools, []);
  // The coworker page save: still Node's.
  const pageSave = require('./specialist-page-save.cjs').createPageSave({ store: { specialistPageSave: async () => ({ status: 500 }) } });
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(String(line));
  let kept;
  try { kept = await runTurn(t, { requested: true, frames: answer, project: { id: 'specialist-qa' }, boxes: { specialistTools: pageSave } }); } finally { console.log = log; }
  assert.notEqual(kept.events.at(-1).type, 'prepared');
  assert.equal(kept.requests.length, 1, 'Node ran the turn');
  assert.ok(kept.requests[0].tools.some((tool) => tool.function.name === 'space_page_save'));
  assert.ok(logged.includes('[chat] native executor not used for this turn: page-save'));
  // A front that runs the page save's card (#2446: asked every time, `once`) gets the turn, the tool named in onceTools.
  const once = await runTurn(t, { requested: true, caps: ['once'], frames: answer, project: { id: 'specialist-qa' }, boxes: { specialistTools: pageSave } });
  const frame = once.events.at(-1);
  assert.equal(frame.type, 'prepared');
  assert.deepEqual(frame.onceTools, ['space_page_save']);
  assert.ok(frame.writes.includes('space_page_save'), 'the page save is always a write');
  assert.equal('onceTools' in plain.events.at(-1), false, 'a frame without such tools has no onceTools');
});

test('the edit-target bridge resolves a project edit as the user, with its storage account and the digest the call is pinned to', async () => {
  const edits = require('./project-edit-target.cjs');
  const project = { id: 'qa-project', reservedFolder: 'QA Folder', files: [{ name: 'qa-notes.txt', content: 'QA notes' }, { name: 'qa-doc.pdf', content: 'x', document: { state: 'ready' } }] };
  const accounts = [];
  const { call, calls } = bridge({ getProject: (id) => (id === 'qa-project' ? project : null), editStorageAccount: (who) => { accounts.push(who); return null; } });
  const body = { user: 'qa-user', projectId: 'qa-project', name: 'project_append_file', args: '{"name":"qa-notes.txt","text":"QA more"}' };
  assert.deepEqual(await call(native.EDIT_TARGET_PATH, body), { handled: true, status: 200, body: { path: 'qa-notes.txt', account: null, digest: edits.targetDigest('qa-notes.txt', null) } });
  assert.deepEqual(calls, [['asUser', 'qa-user']]);
  assert.deepEqual(accounts, ['qa-user']);
  // Connected storage: a plain-named file is moved into the project folder, and the move is bound to the account.
  const account = 'a'.repeat(64);
  const connected = bridge({ getProject: () => project, editStorageAccount: () => account });
  assert.deepEqual((await connected.call(native.EDIT_TARGET_PATH, { ...body, name: 'project_replace_text' })).body,
    { path: 'QA Folder/Text/qa-notes.txt', account, digest: edits.targetDigest('QA Folder/Text/qa-notes.txt', account) });
  assert.notEqual(edits.targetDigest('QA Folder/Text/qa-notes.txt', account), edits.targetDigest('QA Folder/Text/qa-notes.txt', null));
  // resolveEditTarget's own refusals, as chat.cjs gets them (it adds the final period and the tool's sentence).
  const answered = async (b) => (await call(native.EDIT_TARGET_PATH, { ...body, ...b })).body;
  assert.deepEqual(await answered({ args: '{"name":"qa-doc.pdf"}' }), { error: '"qa-doc.pdf" is an extracted document, not an editable text file.' });
  assert.deepEqual(await answered({ args: '{"name":"qa-gone.txt"}' }), edits.resolveEditTarget(project, '{"name":"qa-gone.txt"}'));
  assert.deepEqual(await answered({ args: 'not json' }), { error: 'the tool arguments were not valid JSON.' });
  assert.deepEqual(await answered({ args: '[]' }), { error: 'the tool arguments must be a JSON object.' });
  // No project, or one that is gone: chat.cjs's getProject answers nothing either.
  for (const b of [{ projectId: null }, { projectId: undefined }, { projectId: 'qa-gone' }]) {
    assert.deepEqual(await answered(b), { error: 'this chat is not in a project, so there are no project files to edit.' }, JSON.stringify(b));
  }
  // A project that cannot be read: refused as a target lookup that throws; the detail is logged, never sent.
  const logged = [];
  const failing = bridge({ log: (line) => logged.push(line), getProject: () => { throw Error('QA store down'); } });
  assert.deepEqual((await failing.call(native.EDIT_TARGET_PATH, body)).body, { error: 'The file this would change could not be looked up' });
  assert.deepEqual(logged, ['[chat] native edit-target bridge failed: QA store down']);
  const gone = bridge({ asUser: async () => { throw Object.assign(Error('no such account'), { status: 404 }); } });
  assert.deepEqual(await gone.call(native.EDIT_TARGET_PATH, body), { handled: true, status: 404, body: { error: 'no such account' } });
  assert.deepEqual(await call(native.EDIT_TARGET_PATH, body, { trusted: false }), { handled: true, status: 404, body: { error: 'Not found' } });
  assert.equal((await call(native.EDIT_TARGET_PATH, body, { method: 'GET' })).status, 404);
  const before = calls.length;
  for (const bad of [{ name: 'drive_trash_file' }, { name: 'space_page_save' }, { projectId: '' }, { projectId: 7 }, { user: '' }, { args: null }, { projectId: 'x'.repeat(201) }]) {
    assert.equal((await call(native.EDIT_TARGET_PATH, { ...body, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal(calls.length, before, 'nothing ran for a refused request');
});

test('the execute bridge passes an approved edit\'s pinned file in the call\'s options, as chat.cjs does', async () => {
  const seen = [];
  const { call } = bridge({ executeToolCall: async (_p, name, _a, _al, _s, _o, options) => { seen.push(Object.keys(options).includes('editTarget') ? options.editTarget : 'none'); return `QA ${name}`; } });
  const digest = require('./project-edit-target.cjs').targetDigest('qa-notes.txt', null);
  const body = { user: 'qa-user', projectId: 'qa-project', name: 'project_append_file', args: '{}', allowed: ['project_append_file'], routes: [], chatKey: 'qa-chat-1', exchangeKey: 'qa-x' };
  assert.equal((await call(native.EXECUTE_PATH, { ...body, editTarget: digest })).status, 200);
  assert.equal((await call(native.EXECUTE_PATH, body)).status, 200);
  assert.equal((await call(native.EXECUTE_PATH, { ...body, editTarget: null })).status, 200);
  assert.deepEqual(seen, [digest, 'none', 'none'], 'no key at all without one');
  for (const bad of ['qa-notes.txt', digest.toUpperCase(), digest.slice(1), 7, '']) assert.equal((await call(native.EXECUTE_PATH, { ...body, editTarget: bad })).status, 400, String(bad));
  assert.equal(seen.length, 3);
});

// Instruction skills (#272, #546): synthetic QA skills, one reviewed and enabled, one enabled beside it.
const skills = require('./instruction-skills.cjs');
const SKILL = 'qa-skill/SKILL.md', OTHER = 'qa-other/SKILL.md';
const skillBody = (name, line) => `---\nname: ${name}\ndescription: A synthetic QA skill.\n---\n${line}\nQA second line of the synthetic skill body.\n`;
const skillFiles = [{ name: SKILL, content: skillBody('QA Skill', 'QA first line that names the synthetic check steps.') },
  { name: OTHER, content: skillBody('QA Other', 'QA other line about a second synthetic procedure.') }];
const H = skills.hash(skillFiles[0].content), H2 = skills.hash(skillFiles[1].content);
const skillProject = (enabled = { [SKILL]: true, [OTHER]: true }) => ({ id: 'qa-project', files: skillFiles,
  instructionSkills: Object.fromEntries(skillFiles.map((f) => [f.name, { enabled: enabled[f.name] === true, reviewedHash: skills.hash(f.content) }])) });

test('a project turn with instruction skills hands off with the loaded and enabled skills; a pinned one is loaded (#571)', async (t) => {
  const project = { files: skillFiles, instructionSkills: skillProject().instructionSkills };
  const pin = `${skills.skillId({ id: 'qa-project' }, SKILL)}@${H}`;
  const handed = await runTurn(t, { requested: true, caps: ['skills'], frames: answer, project, body: { skill: pin } });
  const last = handed.events.at(-1);
  assert.equal(last.type, 'prepared', 'a project with skills no longer stays in Node');
  assert.deepEqual(last.skills, { loaded: [{ file: SKILL, hash: H, name: 'QA Skill' }],
    enabled: [{ file: SKILL, hash: H, name: 'QA Skill' }, { file: OTHER, hash: H2, name: 'QA Other' }], revokedInHistory: [], imageWarning: '', coverageWarning: '' });
  assert.ok(handed.events.some((e) => e.type === 'skills_scope' && e.text === 'QA Skill'), 'the pin is shown before the cut');
  const unpinned = await runTurn(t, { requested: true, caps: ['skills'], frames: answer, project });
  assert.deepEqual(unpinned.events.at(-1).skills.loaded, []);
  // A skill an earlier turn used and that is disabled now is taken out of the history before the cut, and named.
  const off = { ...project, instructionSkills: skillProject({ [OTHER]: true }).instructionSkills };
  const history = [{ role: 'user', content: 'QA earlier' }, { role: 'assistant', content: `QA earlier reply.\nIt followed SHA-256 ${H} closely.` }];
  const scrubbed = (await runTurn(t, { requested: true, caps: ['skills'], frames: answer, project: off, history })).events;
  assert.deepEqual(scrubbed.at(-1).skills.revokedInHistory, ['QA Skill']);
  assert.ok(!JSON.stringify(scrubbed.at(-1).messages).includes(H));
  assert.ok(scrubbed.some((e) => e.type === 'warning' && e.text.startsWith('Earlier replies in this chat used Skill "QA Skill"')));
  // A project with no skills carries empty lists.
  const none = (await runTurn(t, { requested: true, frames: answer })).events.at(-1).skills;
  assert.deepEqual(none, { loaded: [], enabled: [], revokedInHistory: [], imageWarning: '', coverageWarning: '' });
});

test('the skill bridges check, note and scrub a turn\'s skills as the user, against the project as stored now', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-native-skills-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = require('./skill-history.cjs').createSkillHistory({ fs, path });
  let stored = skillProject();
  const { call, calls } = bridge({ getProject: (id) => (id === 'qa-project' ? stored : null), currentWorkspace: () => ({ dir, assertActive() {} }), skillLedger: ledger });
  const at = (op) => `${native.SKILLS_PREFIX}${op}`;
  const loaded = [{ file: SKILL, hash: H, name: 'QA Skill' }];
  const base = { user: 'qa-user', projectId: 'qa-project', chatId: 'qa-chat-1' };
  // revoked: what chat.cjs revokedSkills finds, against the project as stored when asked.
  assert.deepEqual(await call(at('revoked'), { ...base, loaded }), { handled: true, status: 200, body: { gone: [] } });
  assert.deepEqual(calls, [['asUser', 'qa-user']]);
  // read: a call naming the skill file loads it, and the version is recorded in the ledger for the chat.
  const candidates = [{ file: SKILL, hash: H, name: 'QA Skill' }, { file: OTHER, hash: H2, name: 'QA Other' }];
  const read = await call(at('read'), { ...base, candidates, args: '{"name":"qa-skill/SKILL.md"}', result: 'QA unrelated text' });
  assert.deepEqual(read.body, { loaded: [{ file: SKILL, hash: H, name: 'QA Skill' }] });
  const entry = JSON.parse(fs.readFileSync(path.join(dir, 'skill-history.json'), 'utf8')).projects['qa-project'];
  assert.deepEqual(entry.map((e) => [e.file, e.hash, e.name, e.chats]), [[SKILL, H, 'QA Skill', ['qa-chat-1']]]);
  assert.ok(entry[0].lines.length > 0, 'recorded with the version\'s text');
  // A result carrying a skill's SHA-256 (the reader's heading) loads it too; one naming none loads nothing.
  assert.deepEqual((await call(at('read'), { ...base, candidates: candidates.slice(1), args: '{}', result: `Loaded instruction skill "QA Other" (SHA-256 ${H2}).` })).body, { loaded: [candidates[1]] });
  assert.deepEqual((await call(at('read'), { ...base, candidates, args: 'not json', result: 'QA nothing' })).body, { loaded: [] });
  // The same decision as chat.cjs noteSkillRead: skill-reads.cjs.
  assert.deepEqual(require('./skill-reads.cjs').matchedReads(stored, candidates, '{"name":"SKILL.md"}', ''), [], 'an ambiguous bare name resolves to nothing');
  // Disabled now: the loaded skill is gone; a project that is gone revokes them all.
  stored = skillProject({ [OTHER]: true });
  assert.deepEqual((await call(at('revoked'), { ...base, loaded })).body, { gone: [{ file: SKILL, name: 'QA Skill' }] });
  assert.deepEqual((await call(at('revoked'), { ...base, projectId: 'qa-gone', loaded })).body, { gone: [{ file: SKILL, name: 'QA Skill' }] });
  // scrub: the revoked version's text out of the round's messages (the ledger knows it from the read above).
  const messages = [null, { role: 'assistant', content: `QA reply.\nIt used SHA-256 ${H} here.` }, { role: 'assistant', content: 'QA unrelated reply.' }];
  const scrub = await call(at('scrub'), { ...base, messages });
  assert.equal(scrub.status, 200);
  assert.deepEqual(scrub.body.removed, ['QA Skill']);
  assert.deepEqual(scrub.body.changed, [[1, 'QA reply.\n[Skill "QA Skill" was disabled or changed, and its instructions were removed]']]);
  stored = skillProject();
  assert.deepEqual((await call(at('scrub'), { ...base, messages })).body, { changed: [], removed: [] }, 'enabled again: nothing to take out');
  assert.deepEqual((await call(at('scrub'), { ...base, projectId: 'qa-gone', messages })).body, { changed: [], removed: [] });
  // Refusals: not the front, not POST, a gone account, bad input; a failure's detail is logged, never sent.
  assert.deepEqual(await call(at('revoked'), { ...base, loaded }, { trusted: false }), { handled: true, status: 404, body: { error: 'Not found' } });
  assert.equal((await call(at('scrub'), { ...base, messages }, { method: 'GET' })).status, 404);
  assert.equal((await call(`${native.SKILLS_PREFIX}other`, base)).handled, false);
  const before = calls.length;
  for (const [op, bad] of [['revoked', { loaded: [{ file: SKILL, hash: 'x', name: 'QA' }] }], ['revoked', { loaded: null }], ['revoked', { projectId: '' }], ['revoked', { user: '' }],
    ['read', { candidates, args: '{}' }], ['read', { candidates: [{ file: '', hash: H, name: 'QA' }], args: '{}', result: '' }], ['read', { chatId: 7, candidates, args: '{}', result: '' }],
    ['scrub', { messages: [{ role: 'assistant', content: null }] }], ['scrub', { messages: 'x' }], ['scrub', { chatId: 'x'.repeat(401), messages }]]) {
    assert.equal((await call(at(op), { ...base, loaded, ...bad })).status, 400, `${op} ${JSON.stringify(bad)}`);
  }
  assert.equal(calls.filter(([c]) => c === 'asUser').length - before, 9, 'every request naming a user runs as that user before its body is read');
  const gone = bridge({ asUser: async () => { throw Object.assign(Error('no such account'), { status: 404 }); } });
  assert.deepEqual(await gone.call(at('read'), { ...base, candidates, args: '{}', result: '' }), { handled: true, status: 404, body: { error: 'no such account' } });
  const logged = [];
  const failing = bridge({ log: (line) => logged.push(line), getProject: () => { throw Error('QA store down'); } });
  assert.deepEqual(await failing.call(at('revoked'), { ...base, loaded }), { handled: true, status: 500, body: { error: 'the skills could not be checked' } });
  assert.deepEqual(logged, ['[chat] native skills revoked bridge failed: QA store down']);
});

test('the capabilities header is read only with the secret, and removed either way', () => {
  const handoff = native.createHandoff({ secret: SECRET, relayed: () => true });
  const ask = (headers) => { const req = { headers }; const ok = handoff.requested(req); return [ok, [...handoff.capabilities(req)], native.CAPS_HEADER in req.headers]; };
  assert.deepEqual(ask({ [native.HANDOFF_HEADER]: SECRET, [native.CAPS_HEADER]: 'skills, qa-later ,' }), [true, ['skills', 'qa-later'], false]);
  assert.deepEqual(ask({ [native.HANDOFF_HEADER]: SECRET }), [true, [], false]);
  // A client's own header without the secret (or with a wrong one) names nothing and does not reach the turn.
  assert.deepEqual(ask({ [native.CAPS_HEADER]: 'skills' }), [false, [], false]);
  assert.deepEqual(ask({ [native.HANDOFF_HEADER]: 'qa-guess', [native.CAPS_HEADER]: 'skills' }), [false, [], false]);
  const direct = native.createHandoff({ secret: SECRET });
  const req = { headers: { [native.HANDOFF_HEADER]: SECRET, [native.CAPS_HEADER]: 'skills' } };
  assert.equal(direct.requested(req), false, 'not relayed by the front');
  assert.deepEqual([...direct.capabilities(req)], []);
  assert.deepEqual([...handoff.capabilities(null)], []);
});

test('a project with instruction skills stays in Node unless the front names the skills capability', async (t) => {
  const project = { files: skillFiles, instructionSkills: skillProject().instructionSkills };
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(String(line));
  let kept, enabledOnly;
  try {
    kept = await runTurn(t, { requested: true, frames: answer, project });
    enabledOnly = await runTurn(t, { requested: true, caps: ['qa-other'], frames: answer, project });
  } finally { console.log = log; }
  for (const turn of [kept, enabledOnly]) {
    assert.notEqual(turn.events.at(-1).type, 'prepared');
    assert.equal(turn.requests.length, 1, 'Node ran the turn');
  }
  assert.equal(logged.filter((l) => l === '[chat] native executor not used for this turn: skills').length, 2);
  assert.equal((await runTurn(t, { requested: true, caps: ['skills'], frames: answer, project })).events.at(-1).type, 'prepared');
  // Through the real hand-off: the header from the front, with the secret.
  const handoff = native.createHandoff({ secret: SECRET, relayed: () => true });
  const real = await runTurn(t, { handoff, frames: answer, project, headers: { [native.HANDOFF_HEADER]: SECRET, [native.CAPS_HEADER]: 'skills' } });
  assert.equal(real.events.at(-1).type, 'prepared');
  assert.equal(native.CAPS_HEADER in real.req.headers, false);
  // A project with no skills needs no capability.
  assert.equal((await runTurn(t, { requested: true, frames: answer })).events.at(-1).type, 'prepared');
});

// The chat-wide grants (R8): the grant, redeem and revoke bridges over the real approval registry (S9) and a scripted
// front. The executor below is a write executor as toolboxes.cjs runs one: inside the call's write fence, sending its
// outbound write through tool-write-fence.cjs send.
const { createApprovalRegistry, REGISTRY_PROTOCOL } = require('./rust-approval-registry.cjs');
const writeFence = require('./tool-write-fence.cjs');
// As chat.cjs permissionContext sends it: chat-grant-context.cjs binding over the chat's context from this start.
const QA_BINDING = require('./chat-grant-context.cjs').binding('qa-user', 'qa-chat-1', 'qa-scope',
  { canonicalChatId: 'qa-chat-1', holder: { kind: 'free' }, generation: '1', start: require('./chat-partial.cjs').START_ID, tombstoned: false });
const grantAsk = { user: 'qa-user', chat: 'qa-chat-1', scope: 'qa-scope', binding: QA_BINDING, exchangeKey: 'qa-x' };
const grantCall = (handle, extra = {}, grant = {}) => ({ user: 'qa-user', projectId: 'qa-project', name: 'qa_write', args: '{"name":"qa"}', allowed: ['qa_write'], routes: [],
  chatKey: 'qa-chat-1', exchangeKey: 'qa-x', grant: { handle, chat: 'qa-chat-1', scope: 'qa-scope', binding: QA_BINDING, ...grant }, ...extra });
const redeemed = () => ({ status: 200, body: { redeemed: true, protocol: REGISTRY_PROTOCOL, window_ms: 2000 } });

function grantBridge({ redeem = redeemed, registryParts = null, overrides = {} } = {}) {
  const { AsyncLocalStorage } = require('node:async_hooks');
  const as = new AsyncLocalStorage();
  const asked = [];
  let tickets = 0;
  const registry = createApprovalRegistry({ approvals: async (op, payload) => {
    asked.push([op, payload]);
    if (op === 'granted') return { status: 200, body: { granted: true, ticket: `qa-ticket-${tickets += 1}` } };
    if (op === 'redeem') return redeem(payload);
    if (op === 'revoke') return { status: 200, body: { revoked: true } };
    return { status: 404, body: {} };
  } });
  const clock = { t: 1_800_000_000_000 };
  const ctl = { hold: null, entered: null, workspaceUser: null };
  const writes = [], fences = [];
  const b = bridge({
    asUser: async (userId, fn) => as.run(userId, fn),
    currentWorkspace: () => ({ userId: ctl.workspaceUser || as.getStore(), revoked: false }),
    recordToolUse: (ws, name) => b.calls.push(['recordToolUse', ws.userId, name]),
    executeToolCall: async (project, name, args, allowed, signal, outcome, options) => {
      fences.push(options.writeFence || null);
      ctl.signal = signal;
      try {
        return await writeFence.run(options.writeFence, async () => {
          ctl.entered?.();
          if (ctl.hold) await ctl.hold;
          return writeFence.send(() => { writes.push([name, args, options.writeFence ? options.writeFence.open() : null]); return `QA ${name} wrote`; });
        });
      } catch (e) {
        if (e?.code !== writeFence.CODE) throw e;
        outcome.notRun = true; outcome.failed = true;
        return `ERROR: ${e.message}`;
      }
    },
    ...(registryParts ? registryParts(registry) : { chatWideApproved: registry.chatWideApproved, redeemChatGrant: registry.redeemChatGrant, revokeChatGrant: registry.revokeChatGrant }),
    now: () => clock.t,
    ...overrides,
  });
  const grant = async (extra = {}) => (await b.call(native.GRANT_PATH, { ...grantAsk, ...extra })).body;
  return { ...b, registry, asked, clock, ctl, writes, fences, grant, recorded: () => b.calls.filter(([k]) => k === 'recordToolUse') };
}

test('a grant handle is redeemed by its execute call, which writes inside the open fence and is counted once', async () => {
  const g = grantBridge();
  const got = await g.grant();
  assert.equal(got.granted, true);
  assert.match(got.handle, /^[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(QA_BINDING).sort(), ['canonicalChatId', 'context', 'scope', 'user']);
  assert.deepEqual(g.asked, [['granted', { user: 'qa-user', chat: 'qa-chat-1', scope: 'qa-scope', binding: QA_BINDING, protocol: REGISTRY_PROTOCOL }]]);
  assert.deepEqual(await g.call(native.EXECUTE_PATH, grantCall(got.handle, {}, { binding: JSON.parse(JSON.stringify(QA_BINDING)) })),
    { handled: true, status: 200, body: { text: 'QA qa_write wrote', failed: false } });
  assert.deepEqual(g.writes, [['qa_write', '{"name":"qa"}', true]], 'the write ran with the fence open');
  assert.deepEqual(g.asked.map(([op]) => op), ['granted', 'redeem']);
  assert.equal(g.asked[1][1].ticket, 'qa-ticket-1');
  assert.deepEqual(g.asked[1][1].binding, JSON.parse(JSON.stringify(QA_BINDING)), 'redeemed with the call\'s final binding');
  assert.deepEqual(g.recorded(), [['recordToolUse', 'qa-user', 'qa_write']]);
  assert.equal(g.fences[0].open(), false, 'the fence is retired when the call ends');
  // Single use: the same handle again runs nothing and asks the front nothing.
  assert.deepEqual((await g.call(native.EXECUTE_PATH, grantCall(got.handle))).body, { redeem: 'refused' });
  assert.equal(g.writes.length, 1);
  assert.equal(g.asked.length, 2);
  assert.equal(g.recorded().length, 1);
  // A well-formed handle nobody was given.
  assert.deepEqual((await g.call(native.EXECUTE_PATH, grantCall('0'.repeat(32)))).body, { redeem: 'refused' });
});

test('a handle named by another user, chat, scope or exchange is refused, and is gone afterwards', async () => {
  const g = grantBridge();
  for (const [extra, grant] of [[{ user: 'qa-other' }, {}], [{}, { chat: 'qa-chat-2' }], [{}, { scope: 'qa-scope-2' }], [{ exchangeKey: 'qa-y' }, {}]]) {
    const { handle } = await g.grant();
    assert.deepEqual((await g.call(native.EXECUTE_PATH, grantCall(handle, extra, grant))).body, { redeem: 'refused' }, JSON.stringify([extra, grant]));
    assert.deepEqual((await g.call(native.EXECUTE_PATH, grantCall(handle))).body, { redeem: 'refused' }, 'single use, whatever happened');
  }
  assert.deepEqual(g.writes, []);
  assert.equal(g.asked.filter(([op]) => op === 'redeem').length, 0);
  assert.deepEqual(g.recorded(), []);
});

test('a once-only tool (the coworker page save) never runs under a grant handle, and the handle is spent', async () => {
  const g = grantBridge();
  const { handle } = await g.grant();
  assert.deepEqual((await g.call(native.EXECUTE_PATH, grantCall(handle, { name: 'space_page_save', allowed: ['space_page_save'] }))).body, { redeem: 'refused' });
  assert.deepEqual((await g.call(native.EXECUTE_PATH, grantCall(handle))).body, { redeem: 'refused' }, 'single use');
  assert.deepEqual(g.writes, []);
  assert.equal(g.asked.filter(([op]) => op === 'redeem').length, 0);
});

test('a grant handle expires after five minutes', async () => {
  const g = grantBridge();
  const late = (await g.grant()).handle, inTime = (await g.grant()).handle;
  g.clock.t += native.GRANT_HANDLE_TTL_MS - 1;
  assert.deepEqual((await g.call(native.EXECUTE_PATH, grantCall(inTime))).body, { text: 'QA qa_write wrote', failed: false });
  g.clock.t += 1;
  assert.deepEqual((await g.call(native.EXECUTE_PATH, grantCall(late))).body, { redeem: 'refused' });
  assert.equal(g.writes.length, 1);
});

test('grant handles are bounded per account and in all; a live one is never evicted, an expired one is swept', async () => {
  const g = grantBridge();
  const mine = [];
  for (let i = 0; i < 64; i += 1) { const got = await g.grant(); assert.equal(got.granted, true); mine.push(got.handle); }
  assert.deepEqual(await g.grant(), { granted: false });
  assert.equal(g.asked.length, 64, 'a full account does not ask the front');
  assert.equal((await g.grant({ user: 'qa-other' })).granted, true, 'other accounts are unaffected');
  // The oldest is still there.
  assert.deepEqual((await g.call(native.EXECUTE_PATH, grantCall(mine[0]))).body, { text: 'QA qa_write wrote', failed: false });
  assert.equal((await g.grant()).granted, true, 'a redeemed handle frees its place');
  // 1024 in all: fill with more accounts.
  for (let u = 0; u < 15; u += 1) for (let i = 0; i < (u === 14 ? 63 : 64); i += 1) assert.equal((await g.grant({ user: `qa-user-${u}` })).granted, true);
  assert.deepEqual(await g.grant({ user: 'qa-third' }), { granted: false }, 'the whole map is full');
  g.clock.t += native.GRANT_HANDLE_TTL_MS;
  assert.equal((await g.grant({ user: 'qa-third' })).granted, true, 'expired handles are swept first');
  assert.equal((await g.grant()).granted, true);
});

test('a redeem the front refuses runs nothing (refused); one it cannot answer runs nothing (unavailable)', async () => {
  let answer = () => ({ status: 200, body: { redeemed: false, protocol: REGISTRY_PROTOCOL, window_ms: 2000 } });
  const g = grantBridge({ redeem: () => answer() });
  assert.deepEqual((await g.call(native.EXECUTE_PATH, grantCall((await g.grant()).handle))).body, { redeem: 'refused' });
  answer = () => ({ status: 503, body: { error: 'QA front unavailable' } });
  assert.deepEqual((await g.call(native.EXECUTE_PATH, grantCall((await g.grant()).handle))).body, { redeem: 'unavailable' });
  answer = () => { throw Object.assign(Error('QA connection refused'), { code: 'ECONNREFUSED' }); };
  assert.deepEqual((await g.call(native.EXECUTE_PATH, grantCall((await g.grant()).handle))).body, { redeem: 'unavailable' });
  assert.deepEqual(g.writes, []);
  assert.deepEqual(g.fences, [], 'the executor was never called');
  assert.deepEqual(g.recorded(), []);
});

test('a revoke at the front between the grant and the call refuses it before the redeem', async () => {
  const g = grantBridge();
  const { handle } = await g.grant();
  assert.equal(g.registry.frontRevoked('qa-user', 'qa-chat-1'), true);
  assert.deepEqual((await g.call(native.EXECUTE_PATH, grantCall(handle))).body, { redeem: 'refused' });
  assert.deepEqual(g.asked.map(([op]) => op), ['granted']);
  assert.deepEqual(g.writes, []);
});

test('a revoke while the call runs, before its outbound write, stops the write: notRun, not counted', async () => {
  const g = grantBridge();
  const { handle } = await g.grant();
  let release;
  g.ctl.hold = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { g.ctl.entered = resolve; });
  const running = g.call(native.EXECUTE_PATH, grantCall(handle));
  await entered;
  assert.equal(g.fences[0].open(), true);
  g.registry.frontRevoked('qa-user', 'qa-chat-1');
  release();
  const { status, body } = await running;
  assert.equal(status, 200);
  assert.equal(body.notRun, true);
  assert.equal(body.failed, true);
  assert.match(body.text, /^ERROR: The permission changed before the write was sent/);
  assert.deepEqual(g.writes, []);
  assert.deepEqual(g.recorded(), [], 'a call that did not run is not counted');
});

test('the abort bridge reaches a call running under a grant', async () => {
  const g = grantBridge();
  const { handle } = await g.grant();
  let release;
  g.ctl.hold = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { g.ctl.entered = resolve; });
  const running = g.call(native.EXECUTE_PATH, grantCall(handle));
  await entered;
  assert.equal(g.ctl.signal.aborted, false);
  assert.equal((await g.call(native.ABORT_PATH, { user: 'qa-user', exchangeKey: 'qa-x' })).status, 204);
  assert.equal(g.ctl.signal.aborted, true);
  release();
  assert.equal((await running).status, 200);
});

test('without a grant, a call the executor reports as not run answers notRun and is not counted', async () => {
  const { call, calls } = bridge({ executeToolCall: async (_p, name, _a, _al, _s, outcome) => { outcome.notRun = true; outcome.failed = true; return `ERROR: QA ${name} not sent`; } });
  const body = { user: 'qa-user', projectId: 'qa-project', name: 'qa_write', args: '{}', allowed: ['qa_write'], routes: [], chatKey: 'qa-chat-1', exchangeKey: 'qa-x' };
  assert.deepEqual((await call(native.EXECUTE_PATH, body)).body, { text: 'ERROR: QA qa_write not sent', failed: true, notRun: true });
  assert.deepEqual(calls.filter(([k]) => k === 'recordToolUse'), []);
});

test('without the registry no grant is found, and a grant is never run unfenced', async () => {
  const none = grantBridge({ registryParts: () => ({}) });
  assert.deepEqual(await none.grant(), { granted: false });
  assert.equal((await none.call(native.REVOKE_PATH, { user: 'qa-user', chat: 'qa-chat-1' })).status, 503);
  const noRedeem = grantBridge({ registryParts: (r) => ({ chatWideApproved: r.chatWideApproved }) });
  const { handle } = await noRedeem.grant();
  assert.deepEqual((await noRedeem.call(native.EXECUTE_PATH, grantCall(handle))).body, { redeem: 'unavailable' });
  assert.deepEqual((await noRedeem.call(native.EXECUTE_PATH, grantCall(handle))).body, { redeem: 'refused' }, 'the handle was used up');
  assert.deepEqual(noRedeem.writes, []);
  // The front says no grant; and a workspace that is not the user's never gets one.
  const g = grantBridge({ registryParts: (r) => ({ chatWideApproved: async () => false, redeemChatGrant: r.redeemChatGrant }) });
  assert.deepEqual(await g.grant(), { granted: false });
  const other = grantBridge();
  other.ctl.workspaceUser = 'qa-other';
  assert.deepEqual(await other.grant(), { granted: false });
  assert.deepEqual(other.asked, []);
});

test('the revoke bridge revokes the chat\'s grant at the front, as the user', async () => {
  const g = grantBridge();
  const { handle } = await g.grant();
  assert.deepEqual(await g.call(native.REVOKE_PATH, { user: 'qa-user', chat: 'qa-chat-1' }), { handled: true, status: 200, body: { revoked: true } });
  assert.deepEqual(g.asked.at(-1), ['revoke', { user: 'qa-user', chat: 'qa-chat-1' }]);
  // Node's epoch moved first: the handle found before it no longer redeems.
  assert.deepEqual((await g.call(native.EXECUTE_PATH, grantCall(handle))).body, { redeem: 'refused' });
  const gone = grantBridge({ overrides: { asUser: async () => { throw Object.assign(Error('no such account'), { status: 404 }); } } });
  assert.deepEqual(await gone.call(native.REVOKE_PATH, { user: 'qa-user', chat: 'qa-chat-1' }), { handled: true, status: 404, body: { error: 'no such account' } });
  assert.deepEqual(await gone.call(native.GRANT_PATH, grantAsk), { handled: true, status: 404, body: { error: 'no such account' } });
});

test('the grant bridges refuse malformed requests (400) and anyone but the front (404)', async () => {
  const g = grantBridge();
  for (const bad of [{ user: '' }, { user: 7 }, { chat: '' }, { chat: 'x'.repeat(401) }, { scope: '' }, { scope: 'x'.repeat(201) }, { scope: 3 },
    { binding: null }, { binding: [] }, { binding: 'qa' }, { exchangeKey: '' }, { exchangeKey: undefined }, { exchangeKey: 'x'.repeat(201) }]) {
    assert.equal((await g.call(native.GRANT_PATH, { ...grantAsk, ...bad })).status, 400, JSON.stringify(bad));
  }
  for (const bad of [{ user: '' }, { chat: '' }, { chat: 3 }]) assert.equal((await g.call(native.REVOKE_PATH, { user: 'qa-user', chat: 'qa-chat-1', ...bad })).status, 400, JSON.stringify(bad));
  assert.equal(g.asked.length, 0);
  const { handle } = await g.grant();
  const call = grantCall(handle);
  for (const grant of [handle.toUpperCase(), 7, [], 'qa', { ...call.grant, handle: handle.toUpperCase() }, { ...call.grant, handle: handle.slice(1) }, { ...call.grant, handle: 1 },
    { ...call.grant, chat: '' }, { ...call.grant, scope: undefined }, { ...call.grant, binding: [] }, { ...call.grant, binding: null }]) {
    assert.equal((await g.call(native.EXECUTE_PATH, { ...call, grant })).status, 400, JSON.stringify(grant));
  }
  assert.equal((await g.call(native.EXECUTE_PATH, { ...call, exchangeKey: undefined })).status, 400, 'a grant call names its exchange');
  assert.equal((await g.call(native.GRANT_PATH, grantAsk, { trusted: false })).status, 404);
  assert.equal((await g.call(native.REVOKE_PATH, { user: 'qa-user', chat: 'qa-chat-1' }, { trusted: false })).status, 404);
  assert.equal((await g.call(native.EXECUTE_PATH, call, { trusted: false })).status, 404);
  // A malformed request leaves the handle in place.
  assert.deepEqual((await g.call(native.EXECUTE_PATH, call)).body, { text: 'QA qa_write wrote', failed: false });
});

test('an exchange stopped while the front redeems runs nothing (aborted), and the fence is retired', async () => {
  let release, askedRedeem;
  const redeemAsked = new Promise((resolve) => { askedRedeem = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const fences = [];
  const g = grantBridge({ redeem: async () => { askedRedeem(); await held; return redeemed(); },
    registryParts: (r) => ({ chatWideApproved: r.chatWideApproved, revokeChatGrant: r.revokeChatGrant,
      redeemChatGrant: async (...a) => { const f = await r.redeemChatGrant(...a); fences.push(f); return f; } }) });
  const { handle } = await g.grant();
  const running = g.call(native.EXECUTE_PATH, grantCall(handle));
  await redeemAsked;
  assert.equal((await g.call(native.ABORT_PATH, { user: 'qa-user', exchangeKey: 'qa-x' })).status, 204);
  release();
  assert.deepEqual(await running, { handled: true, status: 200, body: { redeem: 'aborted' } });
  assert.deepEqual(g.writes, []);
  assert.deepEqual(g.fences, [], 'the executor was never called');
  assert.deepEqual(g.recorded(), []);
  assert.equal(fences.length, 1);
  assert.equal(typeof fences[0].open, 'function', 'the front redeemed it');
  assert.equal(fences[0].open(), false, 'the fence is retired (started)');
});

test('a redeemed fence already closed is retired once (unavailable); a workspace no longer the user\'s is refused before the redeem', async () => {
  let started = 0;
  const closed = grantBridge({ registryParts: (r) => ({ chatWideApproved: r.chatWideApproved, redeemChatGrant: async () => ({ open: () => false, started: () => { started += 1; } }) }) });
  assert.deepEqual((await closed.call(native.EXECUTE_PATH, grantCall((await closed.grant()).handle))).body, { redeem: 'unavailable' });
  assert.equal(started, 1);
  assert.deepEqual(closed.writes, []);
  assert.deepEqual(closed.fences, []);
  const g = grantBridge();
  const { handle } = await g.grant();
  g.ctl.workspaceUser = 'qa-other';
  assert.deepEqual((await g.call(native.EXECUTE_PATH, grantCall(handle))).body, { redeem: 'refused' });
  assert.deepEqual(g.asked.map(([op]) => op), ['granted'], 'the front was not asked to redeem');
  assert.deepEqual(g.writes, []);
  assert.deepEqual(g.recorded(), []);
});

// Requiring index.cjs starts the whole server, so this reads its source: the bridge gets the grant functions of the
// one approval registry chat.cjs gets (the epochs frontRevoked moves), not another registry or a wrapper.
test('index.cjs hands the tool bridge the approval registry\'s own grant functions', () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.equal(src.match(/createApprovalRegistry\(/g).length, 1, 'one registry');
  const destructured = src.match(/^const \{([^}]*)\} = approvalRegistry;$/m);
  assert.ok(destructured, 'the registry functions are destructured from approvalRegistry');
  const names = destructured[1].split(',').map((n) => n.trim());
  const start = src.indexOf("require('./rust-chat-native.cjs').createToolBridge({");
  assert.ok(start > src.indexOf('const approvalRegistry = '), 'the bridge is made after the registry');
  const call = src.slice(start, src.indexOf('});', start));
  for (const fn of ['chatWideApproved', 'redeemChatGrant', 'revokeChatGrant']) {
    assert.ok(names.includes(fn), `${fn} is the registry's`);
    assert.match(call, new RegExp(`[{,\\s]${fn}\\s*,`), `${fn} is passed to createToolBridge as is`);
    assert.doesNotMatch(call, new RegExp(`${fn}\\s*:`), `${fn} is not replaced in the call`);
    assert.equal(src.match(new RegExp(`(?:const|let|var|function)\\s+${fn}\\b`, 'g')), null, `${fn} is declared nowhere else`);
  }
});
