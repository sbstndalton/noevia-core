'use strict';
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}
// #1520 / #1521 end to end: the system text the provider receives carries the connector and Web search
// note for the message, and an ordinary message's system text gets no route note. Synthetic provider; no network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');

const stream = (...frames) => ({ ok: true, body: (async function* () { for (const f of frames) yield Buffer.from('data: ' + JSON.stringify(f) + '\n\n'); })() });

async function systemTextFor(t, message, { onServer = [{ id: 'nextcloud-files' }, { id: 'web-search' }, { id: 'core' }], body = {}, overrides = {}, all = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-route-note-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const res = new EventEmitter();
  res.writeHead = () => {}; res.write = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return stream({ choices: [{ delta: { content: 'synthetic reply' } }] });
  };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', model: 'answer-model', assets: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => onServer, grantContext: async raw => require('../tests/server/chat-grant-fixture.cjs').context(raw, { holder: { kind: 'absent' } }), chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => 'unused', awaitApproval: async () => 'approve',
    ...overrides,
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message, ...body });
  const system = requests[0].body.messages.find((m) => m.role === 'system');
  const text = system ? system.content : '';
  return all ? { text, requests } : text;
}

test('#1520: a Nextcloud request with Nextcloud Files off reaches the model with the not-available note', async (t) => {
  const sys = await systemTextFor(t, 'List the folders at the top of my Nextcloud files (names only).');
  assert.match(sys, /named Nextcloud Files, but Nextcloud Files is not available in this chat/);
  assert.match(sys, /Do not use another storage's tools in its place/);
});

// A project with its own list is Manual: Web search unticked there is a choice the note points back to.
const MANUAL_PROJECT = { id: 'fixture-project', model: 'answer-model', assets: [], toolsMode: 'manual', toolboxes: ['core'] };

test('#1521: a latest-version question with Web search off reaches the model with the cannot-verify note', async (t) => {
  const sys = await systemTextFor(t, 'What is the latest stable version of the Rust compiler?', { onServer: [{ id: 'web-search' }, { id: 'core' }],
    overrides: { getProject: () => MANUAL_PROJECT } });
  assert.match(sys, /Web search is off for this chat, so you cannot check current information/);
});

test('#1550: in Automatic, a Web search that could not be added is not blamed on a tick the user cannot see', async (t) => {
  // The fixture project has no list of its own, so it is Automatic; its Web search box has no tool to offer.
  const sys = await systemTextFor(t, 'What is the latest stable version of the Rust compiler?', { onServer: [{ id: 'web-search' }, { id: 'core' }] });
  assert.match(sys, /Web search could not be used for this message/);
  assert.doesNotMatch(sys, /\+ > Tools/);
});

test('#1550: in Automatic, a named Nextcloud that is not usable points at the connection, not at + > Tools', async (t) => {
  const sys = await systemTextFor(t, 'List the folders at the top of my Nextcloud files (names only).');
  assert.match(sys, /named Nextcloud Files, but Nextcloud Files is not available in this chat \(connect it under Settings > Connectors/);
  assert.doesNotMatch(sys, /\+ > Tools/);
});

test('an ordinary message gets no route note in its system text', async (t) => {
  const sys = await systemTextFor(t, 'Summarise the plan for the garden.');
  assert.doesNotMatch(sys, /named|Web search is|Connectors in this chat/);
});

const FILES_TOOL = { type: 'function', function: { name: 'nc_webdav_list', description: 'List files', parameters: { type: 'object', properties: {} } } };
const CORE_TOOL = { type: 'function', function: { name: 'core_clock', description: 'Time', parameters: { type: 'object', properties: {} } } };
const BOXES = [{ id: 'nextcloud-files', tools: [FILES_TOOL] }, { id: 'web-search', tools: [] }, { id: 'core', tools: [CORE_TOOL] }];
const NC_MESSAGE = 'List the folders at the top of my Nextcloud files (names only).';

test('#1586: with the Files tools really offered, the note names them (the baseline)', async (t) => {
  const sys = await systemTextFor(t, NC_MESSAGE, { onServer: BOXES, body: { turnToolboxes: ['nextcloud-files'] },
    overrides: { resolveTools: () => ({ tools: [FILES_TOOL, CORE_TOOL], dropped: [] }) } });
  assert.match(sys, /Answer that request with the Nextcloud Files tools/);
});

test('#1586: a requested toolbox whose tools were all removed by policy or budget is reported as not available', async (t) => {
  const sys = await systemTextFor(t, NC_MESSAGE, { onServer: BOXES, body: { turnToolboxes: ['nextcloud-files'] },
    overrides: { resolveTools: () => ({ tools: [CORE_TOOL], dropped: [] }) } });
  assert.doesNotMatch(sys, /Answer that request with the Nextcloud Files tools/);
  assert.match(sys, /named Nextcloud Files, but Nextcloud Files is not available in this chat/);
});

test('#1586: a template that cannot take tools gets the tools-off notice and no "use the Files tools" note', async (t) => {
  const { text, requests } = await systemTextFor(t, NC_MESSAGE, { onServer: BOXES, body: { turnToolboxes: ['nextcloud-files'] }, all: true,
    overrides: { resolveTools: () => ({ tools: [FILES_TOOL, CORE_TOOL], dropped: [] }),
      modelManager: { enabled: true, props: async () => ({}), health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
      templateToolsGate: { allowsTools: async () => false, markUnsupported() {} } } });
  assert.match(text, /No tools can run in this reply/);
  assert.doesNotMatch(text, /Answer that request with the Nextcloud Files tools|Connectors in this chat/);
  assert.equal(requests[0].body.tools, undefined);
});

test('#1586: when the engine refuses the tools and the round is retried without them, the connector note is taken out', async (t) => {
  const seen = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body); seen.push(body);
    if (body.tools) return new Response('Unable to generate parser for this template. Conversation roles must alternate', { status: 400 });
    return stream({ choices: [{ delta: { content: 'synthetic reply' } }] });
  };
  await systemTextFor(t, NC_MESSAGE, { onServer: BOXES, body: { turnToolboxes: ['nextcloud-files'] },
    overrides: { fetch, resolveTools: () => ({ tools: [FILES_TOOL, CORE_TOOL], dropped: [] }),
      modelManager: { enabled: true, props: async () => ({}), health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) } } }).catch(() => {});
  const retried = seen.find((b) => !b.tools);
  assert.ok(retried, 'a retry without tools was sent');
  const system = retried.messages.find((m) => m.role === 'system').content;
  assert.match(system, /No tools can run in this reply/);
  assert.doesNotMatch(system, /Answer that request with the Nextcloud Files tools/);
});
