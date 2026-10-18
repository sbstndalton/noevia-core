'use strict';
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}

// #1550 end to end through the chat handler. In Automatic tools mode, a turn that the tool gate says needs a
// tool, routed to a model whose chat template cannot take tools, goes to the first tool-capable role model with
// its tools. Chit-chat, a gate that says no tool, an unavailable gate, Manual tools mode and a pinned model keep
// the routed model (the template gate then says the tools are off). Synthetic models, template gate, tool gate
// and provider only; nothing is loaded.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const templateCaps = require('./chat-template-caps.cjs');

const SYNTHETIC_TOOL = { type: 'function', function: { name: 'synthetic_search', description: 'Search synthetic notes.', parameters: { type: 'object', properties: {} } } };
const ROLES = { fast: 'fast-model', smart: 'smart-model', code: 'code-model' };
const streamOk = () => ({ ok: true, body: (async function* () { yield Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\n'); })() });

// Verdicts as tool-gate.cjs evaluate() returns them.
const NEEDS_TOOL = { decision: { tool: 'synthetic_search', mode: 'require' }, source: 'decision', elapsedMs: 0 };
const NO_TOOL = { decision: 'none', source: 'none', elapsedMs: 0 };
const UNAVAILABLE = { decision: 'none', source: 'none', reason: 'deadline', elapsedMs: 0 };

/**
 * One chat turn. `project` is the stored record; `incapable` are the models whose template cannot take tools;
 * `verdict` is what the tool gate answers (null: no gate at all, as with the feature off).
 */
async function run(t, { project, incapable = [], verdict = null, message = 'Synthetic question' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-tools-mode-route-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6))); res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [], gateCalls = [], resolvedFor = [];
  const fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return streamOk(); };
  const gate = { allowsTools: async (_manager, model) => !incapable.includes(model), markUnsupported() {}, forget() {}, size: () => 0 };
  const toolGate = verdict === null ? null : {
    evaluate: async (text, tools) => { gateCalls.push({ message: text, offered: tools.map((x) => x.function.name) }); return verdict; },
    record() {},
  };
  const { handleChat } = createChatHandler({
    // Every role model reports as loaded, so the context check does not try to load one (a real switch would).
    modelManager: { enabled: true, props: async () => ({ ok: false, status: 404 }), health: async () => ({ ok: true, body: { all_models_loaded: Object.values(ROLES).map((name) => ({ model_name: name, loaded: true, backend_alive: true, recipe_options: { ctx_size: 32768 } })) } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange, templateToolsGate: gate, toolGate,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => project, getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), providerHeaders: () => ({}),
    autoRoles: () => ({ ...ROLES }), classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [],
    missingRoles: () => [], staleRolesError: () => null, lastLoadedModel: () => null,
    skillsIndexFor: () => [], visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: (_project, m) => { resolvedFor.push(m); return { tools: [SYNTHETIC_TOOL], dropped: [], routes: [] }; }, isWriteTool: () => false, allToolboxes: () => [],
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    chatWideApproved: () => false, recordUsage() {}, recordToolUse() {}, executeToolCall: async () => 'unused', awaitApproval: async () => 'decline',
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message });
  return {
    events, requests, gateCalls, resolvedFor,
    route: events.find((e) => e.type === 'meta')?.route,
    warnings: events.filter((e) => e.type === 'warning').map((e) => e.text),
  };
}

const automatic = { id: 'fixture-project', name: 'Synthetic', routing: 'auto', toolsMode: 'auto', assets: [], files: [] };
const manual = { ...automatic, toolsMode: 'manual', toolboxes: ['core'] };

test('#1550: a tool-needing Automatic turn on a Fast model that cannot take tools moves to Smart, with its tools', async (t) => {
  const r = await run(t, { project: automatic, incapable: [ROLES.fast], verdict: NEEDS_TOOL });
  assert.equal(r.requests[0].body.model, ROLES.smart, 'the turn is answered by the tool-capable role');
  assert.equal(r.route, 'smart', 'the client is told the route it really got');
  assert.deepEqual(r.requests[0].body.tools.map((x) => x.function.name), ['synthetic_search'], 'tools are sent, not dropped');
  assert.deepEqual(r.warnings, [], 'no "answers without tools" notice when the turn kept its tools');
  assert.equal(r.gateCalls.length, 1, 'the verdict comes from the gate, once');
  assert.deepEqual(r.gateCalls[0].offered, ['synthetic_search'], 'the gate judged the tools offered on the routed model');
  assert.equal(r.resolvedFor.at(-1), ROLES.smart, 'the offered tools are resolved again for the model that answers');
});

test('#1550: chit-chat on a Fast model that cannot take tools stays on Fast: no swap, the notice as before', async (t) => {
  const r = await run(t, { project: automatic, incapable: [ROLES.fast], verdict: NO_TOOL, message: 'hello again' });
  assert.equal(r.route, 'fast');
  assert.ok(r.requests.every((q) => q.body.model === ROLES.fast), 'no request goes to Smart');
  assert.equal(r.requests[0].body.tools, undefined);
  assert.deepEqual(r.warnings, [templateCaps.TOOLS_OFF_NOTICE]);
});

test('#1550: an unavailable gate (timed out, errored or off) does not re-route: the routed model and the notice stay', async (t) => {
  const timedOut = await run(t, { project: automatic, incapable: [ROLES.fast], verdict: UNAVAILABLE });
  assert.equal(timedOut.route, 'fast');
  assert.ok(timedOut.requests.every((q) => q.body.model === ROLES.fast));
  assert.deepEqual(timedOut.warnings, [templateCaps.TOOLS_OFF_NOTICE]);
  const off = await run(t, { project: automatic, incapable: [ROLES.fast], verdict: null });
  assert.equal(off.route, 'fast', 'no gate at all: no verdict that a tool is needed');
  assert.deepEqual(off.warnings, [templateCaps.TOOLS_OFF_NOTICE]);
});

test('#1550: Automatic tools where Fast can take tools stay on Fast, unchanged', async (t) => {
  const r = await run(t, { project: automatic, incapable: [], verdict: NEEDS_TOOL });
  assert.equal(r.requests[0].body.model, ROLES.fast);
  assert.equal(r.requests[0].body.tools.length, 1);
  assert.deepEqual(r.warnings, []);
});

test('#1550: Manual tools mode is unchanged: a tool-needing turn on a Fast model that cannot take tools stays, with the notice', async (t) => {
  const r = await run(t, { project: manual, incapable: [ROLES.fast], verdict: NEEDS_TOOL });
  assert.equal(r.requests[0].body.model, ROLES.fast, 'a hand-picked project is not re-routed');
  assert.equal(r.requests[0].body.tools, undefined, 'the template still gets no tools');
  assert.deepEqual(r.warnings, [templateCaps.TOOLS_OFF_NOTICE]);
});

test('#1550: Automatic with no tool-capable role keeps the routed model and shows the notice, not a silent answer', async (t) => {
  const r = await run(t, { project: automatic, incapable: [ROLES.fast, ROLES.smart, ROLES.code], verdict: NEEDS_TOOL });
  assert.equal(r.requests[0].body.model, ROLES.fast);
  assert.equal(r.requests[0].body.tools, undefined);
  assert.deepEqual(r.warnings, [templateCaps.TOOLS_OFF_NOTICE]);
});
