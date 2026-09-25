'use strict';
// The tool gate inside handleChat: prefetch, require (tool_choice), retry-once, and flag off.
// Synthetic fixtures only; the model is a scripted fake, the decision service is a fake decide(),
// and executeToolCall is a fake. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { createToolGate } = require('./tool-gate.cjs');

const fn = (name, properties = {}, required = []) => ({ type: 'function', function: { name, description: `${name} (synthetic)`, parameters: { type: 'object', properties, required } } });
const BOXES = [
  { id: 'web-search', tools: [fn('tavily_search', { query: { type: 'string' } }, ['query'])] },
  { id: 'files', tools: [fn('nc_webdav_search_files', { path: { type: 'string' } }, ['path']), fn('nc_webdav_write_file', { path: { type: 'string' } }, ['path'])] },
];
const sse = (...frames) => ({ ok: true, status: 200, body: (async function* () { for (const f of frames) yield Buffer.from(`data: ${JSON.stringify(f)}\n\n`); })() });
const text = (t) => sse({ choices: [{ delta: { content: t } }] });
const call = (name, args) => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name, arguments: JSON.stringify(args) } }] } }] });

async function run(t, { message, replies, gate, policy = () => 'allow', execute = async () => 'SYNTHETIC RESULT', durableChat = null, boxes = BOXES }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-tool-gate-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [];
  const res = new EventEmitter(); res.writeHead = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  res.write = (chunk) => { for (const line of String(chunk).split('\n')) if (line.startsWith('data:')) { try { events.push(JSON.parse(line.slice(5))); } catch { /* not json */ } } };
  const bodies = [], executed = [];
  const queue = [...replies];
  const fetch = async (url, init) => {
    if (!String(url).endsWith('/chat/completions')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    bodies.push(JSON.parse(init.body));
    const next = queue.shift();
    return typeof next === 'function' ? next() : next || text('fallback reply');
  };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {}, diaryEnabled: () => false },
    crypto: require('node:crypto'), path, fs, fetch, HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', model: 'answer-model', assets: [], toolboxes: boxes.map((b) => b.id) }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid' }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => false,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: (_u, name, write) => (write ? 'ask' : policy(name)) },
    requestScope: { getStore: () => ({ authn: { user: { id: 'synthetic-user', role: 'member' } }, workspace: { userId: 'synthetic-user' } }) },
    resolveTools: (project, _model, blocked) => ({ tools: boxes.filter((b) => project.toolboxes.includes(b.id)).flatMap((b) => b.tools).filter((x) => !blocked(x.function.name)), dropped: [] }),
    isWriteTool: (name) => name === 'nc_webdav_write_file',
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (r) => ({ text: String(r) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => boxes, chatWideApproved: () => false, awaitApproval: async () => 'deny', recordUsage() {}, recordToolUse() {},
    executeToolCall: async (_p, name, args, _allowed, _signal, outcome) => { executed.push({ name, args: JSON.parse(args) }); return execute(name, outcome); },
    ...(gate === undefined ? {} : { toolGate: gate }), ...(durableChat ? { durableChat } : {}),
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message });
  return { bodies, executed, events, dir };
}

function fakeGate({ enabled = true, decide = async () => ({ selected: 'none', scores: { none: 1 }, source: 'configured' }) } = {}) {
  const logs = [];
  const gate = createToolGate({ enabled: () => enabled, decide, isWriteTool: (n) => n === 'nc_webdav_write_file', log: (e) => logs.push(e) });
  return { gate, logs };
}

test('flag off: the model request is byte-identical to a chat with no gate at all', async (t) => {
  const message = 'Search the latest synthetic widget news';
  const without = await run(t, { message, replies: [text('plain')] });
  let decided = 0;
  const { gate, logs } = fakeGate({ enabled: false, decide: async () => { decided++; throw Error('must not run'); } });
  const off = await run(t, { message, replies: [text('plain')], gate });
  const vague = await run(t, { message: 'Take care of the synthetic thing', replies: [text('plain')], gate });
  assert.equal(decided, 0, 'the decision service is never called with the flag off');
  assert.equal(vague.executed.length, 0);
  assert.equal(JSON.stringify(off.bodies), JSON.stringify(without.bodies));
  assert.equal(off.bodies.length, 1);
  assert.equal(off.executed.length, 0);
  assert.equal(logs.length, 0);
  assert.equal('tool_choice' in off.bodies[0], false);
});

test('prefetch: the read runs first and the model turn sees it as a tool exchange plus the note', async (t) => {
  const { gate, logs } = fakeGate();
  const r = await run(t, { message: 'Can you search for the latest synthetic widget news?', replies: [text('answer from results')], gate });
  assert.deepEqual(r.executed, [{ name: 'tavily_search', args: { query: 'the latest synthetic widget news' } }]);
  assert.equal(r.bodies.length, 1);
  const msgs = r.bodies[0].messages;
  const tool = msgs.at(-1), asked = msgs.at(-2);
  assert.equal(tool.role, 'tool'); assert.match(tool.content, /SYNTHETIC RESULT/);
  assert.equal(asked.role, 'assistant'); assert.equal(asked.tool_calls[0].function.name, 'tavily_search'); assert.equal(asked.tool_calls[0].id, tool.tool_call_id);
  assert.ok(msgs.some((m) => m.role === 'system' && String(m.content).includes('The following was fetched for you; use it.')));
  assert.equal('tool_choice' in r.bodies[0], false);
  // The chip gets a call and its result, like any other tool.
  assert.ok(r.events.some((e) => e.type === 'tool' && e.name === 'tavily_search'));
  assert.ok(r.events.some((e) => e.type === 'tool_result' && e.name === 'tavily_search'));
  assert.equal(logs[0].mode, 'prefetch');
});

test('prefetch failure falls through to require, and a read the account asks about is not pre-run', async (t) => {
  const failing = fakeGate();
  const r = await run(t, { message: 'Search the latest synthetic news', gate: failing.gate, execute: async (_n, outcome) => { outcome.failed = true; return 'ERROR: synthetic outage'; },
    replies: [call('tavily_search', { query: 'synthetic' }), text('done')] });
  assert.deepEqual(r.bodies[0].tool_choice, { type: 'function', function: { name: 'tavily_search' } });
  assert.ok(failing.logs.some((e) => e.event === 'prefetch.failed'));
  const asking = fakeGate();
  const a = await run(t, { message: 'Search the latest synthetic news', gate: asking.gate, policy: () => 'ask', replies: [text('prose')] , });
  assert.equal(a.executed.length, 0, 'an "ask" read is never run without the approval card');
  assert.equal(a.bodies[0].tool_choice.function.name, 'tavily_search');
});

test('require: tool_choice forces the tool on the first model turn only', async (t) => {
  const { gate } = fakeGate();
  const r = await run(t, { message: 'Find the synthetic report in my Nextcloud folder', gate,
    replies: [call('nc_webdav_search_files', { path: '/Synthetic' }), text('found it')] });
  assert.equal(r.bodies.length, 2);
  assert.deepEqual(r.bodies[0].tool_choice, { type: 'function', function: { name: 'nc_webdav_search_files' } });
  assert.equal('tool_choice' in r.bodies[1], false);
  assert.deepEqual(r.executed, [{ name: 'nc_webdav_search_files', args: { path: '/Synthetic' } }]);
});

test('require: a miss is retried once with tool_choice, then the chat continues normally and logs gate.miss', async (t) => {
  const once = fakeGate();
  const r1 = await run(t, { message: 'Find the synthetic report in my Nextcloud folder', gate: once.gate,
    replies: [text('I think it is somewhere.'), call('nc_webdav_search_files', { path: '/Synthetic' }), text('found it')] });
  assert.equal(r1.bodies.length, 3);
  assert.ok(r1.bodies[0].tool_choice && r1.bodies[1].tool_choice); assert.equal('tool_choice' in r1.bodies[2], false);
  assert.ok(r1.events.some((e) => e.type === 'preamble' && e.text === 'I think it is somewhere.'), 'the missed prose becomes narration');
  assert.ok(once.logs.some((e) => e.event === 'gate.retry'));
  assert.equal(once.logs.some((e) => e.event === 'gate.miss'), false);
  const twice = fakeGate();
  const r2 = await run(t, { message: 'Find the synthetic report in my Nextcloud folder', gate: twice.gate, replies: [text('no.'), text('still no.')] });
  assert.equal(r2.bodies.length, 2, 'exactly one retry');
  assert.deepEqual(twice.logs.filter((e) => e.event !== 'decision').map((e) => e.event), ['gate.retry', 'gate.miss']);
  assert.ok(r2.events.some((e) => e.type === 'done'));
});

test('a server that rejects the named tool_choice gets the tool alone with tool_choice "required"', async (t) => {
  const { gate } = fakeGate();
  const rejected = () => { const r = { ok: false, status: 400, body: null, text: async () => '{"error":"Invalid tool_choice: object"}' }; r.clone = () => r; return r; };
  const r = await run(t, { message: 'Find the synthetic report in my Nextcloud folder', gate,
    replies: [rejected, call('nc_webdav_search_files', { path: '/S' }), text('ok')] });
  assert.equal(r.bodies[1].tool_choice, 'required');
  assert.deepEqual(r.bodies[1].tools.map((x) => x.function.name), ['nc_webdav_search_files']);
});

test('decision stage: a write chosen by the service is never forced; an error falls open to a normal chat', async (t) => {
  const write = fakeGate({ decide: async () => ({ selected: 'nc_webdav_write_file', scores: { nc_webdav_write_file: 1 }, source: 'configured' }) });
  const w = await run(t, { message: 'Take care of the synthetic thing', gate: write.gate, replies: [text('ok')] });
  assert.equal('tool_choice' in w.bodies[0], false);
  const broken = fakeGate({ decide: async () => { throw Error('synthetic outage'); } });
  const b = await run(t, { message: 'Take care of the synthetic thing', gate: broken.gate, replies: [text('ok')] });
  assert.equal(b.bodies.length, 1); assert.equal('tool_choice' in b.bodies[0], false);
  assert.ok(b.events.some((e) => e.type === 'done'));
});

test('decision stage: a read the account asks about is required, never pre-run', async (t) => {
  const boxes = [...BOXES, { id: 'synthetic-diary-reads', tools: [fn('diary_read_today')] }];
  const { gate, logs } = fakeGate({ decide: async () => ({ selected: 'diary_read_today', scores: { diary_read_today: 0.95, none: 0.05 }, source: 'configured' }) });
  const r = await run(t, { message: 'What was on for the synthetic plan', gate, boxes, policy: (name) => (name === 'diary_read_today' ? 'ask' : 'allow'), replies: [text('prose'), text('prose again')] });
  assert.equal(logs[0].mode, 'prefetch', 'the gate proposed a prefetch');
  assert.equal(r.executed.length, 0, 'but an "ask" tool is never run without the approval card');
  assert.deepEqual(r.bodies[0].tool_choice, { type: 'function', function: { name: 'diary_read_today' } });
});

test('a tool offered by two boxes is sent once in the forced choice and runs once', async (t) => {
  const search = fn('tavily_search', { query: { type: 'string' } }, ['query']);
  const boxes = [...BOXES, { id: 'research', tools: [search] }];
  const { gate } = fakeGate();
  const r = await run(t, { message: 'latest news on synthetic widgets', gate, boxes, replies: [text('answer')] });
  assert.deepEqual(r.executed, [{ name: 'tavily_search', args: { query: 'latest news on synthetic widgets' } }]);
});

test('durable journal: the prefetched call is recorded like a model call and comes back on restore', async (t) => {
  const { createChatTurns } = require('./chat-turns.cjs');
  const real = createChatTurns({ enabled: true });
  let started = null;
  const durableChat = { enabled: true, start: (...args) => (started = real.start(...args)) };
  const { gate } = fakeGate();
  const r = await run(t, { message: 'latest news on synthetic widgets', gate, durableChat, replies: [text('answer from results')] });
  const restored = createChatTurns({ enabled: true }).restore({ userId: 'synthetic-user', dir: r.dir }, started.id);
  const call = restored.state.calls.find((c) => c.name === 'tavily_search');
  assert.ok(call, 'prefetched call journaled');
  assert.equal(call.status, 'completed');
  assert.match(call.result, /SYNTHETIC RESULT/);
  const toolMsg = restored.state.messages.find((m) => m.role === 'tool' && m.tool_call_id === call.id);
  assert.ok(toolMsg, 'the tool_result message is rebuilt from the journal');
  const asked = restored.state.messages.find((m) => m.tool_calls?.[0]?.id === call.id);
  assert.equal(asked.tool_calls[0].function.name, 'tavily_search');
  assert.equal(restored.next, 'completed');
});
