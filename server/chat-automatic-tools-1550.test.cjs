'use strict';
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}

// #1550 end to end: in Tools: Automatic, a turn asking for current web information is given the Web search
// tools, and a turn naming Nextcloud is given the Nextcloud Files tools, when those are offered on this server
// and usable by the account. That holds on the Fast route and on the Smart route, for a free chat and for an
// Automatic project. Before the fix, Automatic carried only the default box (core) plus connected connectors, so
// the model was never offered a web or Nextcloud tool and answered "I can't browse" / "Nextcloud is not enabled".
//
// The real toolbox resolver (createToolboxes) and the real tool gate (rules only, the decision service answers
// "none") run here; the MCP boxes, their tools, the model and the provider are synthetic. Nothing is loaded and
// no network is used.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { createToolboxes } = require('./toolboxes.cjs');
const { createToolGate } = require('./tool-gate.cjs');
const { estimateToolTokens } = require('./toolboxes.cjs');

const fn = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
// Synthetic MCP boxes shaped like the curated manifest (an id, its server, its tools and which are reads).
const WEB = { id: 'web-search', server: 'synthetic-search', label: 'Web search', description: 'Search the web.', source: 'mcp',
  tools: [fn('tavily_search', 'Search the web.', { query: { type: 'string' } }, ['query']), fn('tavily_extract', 'Read a page.', { urls: { type: 'array', items: { type: 'string' } } }, ['urls'])],
  reads: ['tavily_search', 'tavily_extract'] };
const NC_FILES = { id: 'nextcloud-files', server: 'nextcloud', label: 'Nextcloud Files', description: 'Browse files.', source: 'mcp',
  tools: [fn('nc_webdav_list_directory', 'List a folder.', { path: { type: 'string' } }), fn('nc_webdav_delete_resource', 'Delete a file.', { path: { type: 'string' } }, ['path'])],
  reads: ['nc_webdav_list_directory'] };
const NC_NOTES = { id: 'nextcloud-notes', server: 'nextcloud', label: 'Nextcloud Notes', description: 'Notes.', source: 'mcp',
  tools: [fn('nc_notes_search_notes', 'Search notes.', { query: { type: 'string' } })], reads: ['nc_notes_search_notes'] };
// A box the message "check my mail inbox" names (nextcloud-mail) but that holds writes only: Automatic never adds it.
const MAIL_WRITES_ONLY = { id: 'nextcloud-mail', server: 'nextcloud', label: 'Nextcloud Mail', description: 'Mail.', source: 'mcp',
  tools: [fn('nc_mail_send_message', 'Send an email.', { to: { type: 'string' } }, ['to'])], reads: [] };
const DRIVE_BOX = { id: 'gdrive', label: 'Google Drive', description: 'Drive.', source: 'builtin', tools: [fn('drive_search_files', 'Search Drive.', { query: { type: 'string' } })], reads: ['drive_search_files'] };

const ROLES = { fast: 'fast-model', smart: 'smart-model' };
const toolCall = (name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
const AUTO_PROJECT = { id: 'fixture-project', name: 'Synthetic', routing: 'auto', toolsMode: 'auto', toolboxes: ['core'], assets: [], files: [] };
const MANUAL_PROJECT = { ...AUTO_PROJECT, toolsMode: 'manual', toolboxes: ['core'] };

const stream = (...frames) => ({ ok: true, body: (async function* () { for (const f of frames) yield Buffer.from('data: ' + JSON.stringify(f) + '\n\n'); })() });

/**
 * One chat turn. `route` is what Auto picks (fast or smart); `project` null is a free chat with no attachments;
 * `nextcloudReady` is whether this account's Nextcloud connection is usable; `driveConnected` whether its Drive is.
 */
async function run(t, { message, route = 'fast', project = AUTO_PROJECT, nextcloudReady = true, driveConnected = false,
  boxes = [WEB, NC_FILES, NC_NOTES, MAIL_WRITES_ONLY], router = null, provider = { id: 'default', baseUrl: 'http://default.invalid' },
  roles = ROLES, toolBudget = null, gateOn = true, chatWide = false, replies = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-automatic-tools-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => { if (String(line).startsWith('data: ')) events.push(JSON.parse(String(line).slice(6))); };
  res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [], ran = [], gateOffered = [], approvals = [];
  // `replies`: the model's answer per request (a frame); after the list, plain text.
  const fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    const scripted = replies && replies[requests.length - 1];
    return stream(scripted || { choices: [{ delta: { content: 'synthetic reply' } }] });
  };
  const toolboxes = createToolboxes({
    boxes: [DRIVE_BOX],
    driveTools: { names: new Set(['drive_search_files']), connected: () => driveConnected, execute: async () => 'synthetic drive result' },
    mcpBoxes: () => boxes, mcpTools: () => new Map(), offered: () => true,
    prefill: { budgetFor: () => toolBudget, rateFor: () => 1 },
  });
  const gate = createToolGate({ enabled: () => true, decide: async () => ({ selected: 'none' }), isWriteTool: toolboxes.isWriteTool, warn: () => {} });
  const toolGate = !gateOn ? null : { ...gate, evaluate: async (text, tools, ...rest) => { gateOffered.push(tools.map((x) => x.function.name)); return gate.evaluate(text, tools, ...rest); } };
  const user = { id: 'synthetic-user', role: 'member' };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: Object.values(roles).map((name) => ({ model_name: name, loaded: true, backend_alive: true, recipe_options: { ctx_size: 32768 } })) } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {}, diaryEnabled: () => false }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange, toolGate,
    currentWorkspace: () => ({ userId: user.id, dir, assetDir: () => '/synthetic-only' }),
    getProject: () => project, getProvider: () => provider, providerHeaders: () => ({}),
    // A ChatGPT connection that this account owns and that is connected (the provider egress rules decide the rest).
    chatgptOAuth: { status: () => ({ state: 'connected' }), fetchFor: () => fetch }, chatgptEnabled: () => true,
    autoRoles: () => ({ ...roles }), classifyFastOrSmart: async () => route, servedCatalogue: async () => [], modelsInstalled: async () => [],
    missingRoles: () => [], staleRolesError: () => null, lastLoadedModel: () => roles.fast,
    skillsIndexFor: () => [], visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: router || { select: async (ids) => ({ ids, routed: false }) },
    DEFAULT_TOOLBOXES: toolboxes.DEFAULT_TOOLBOXES, CONNECTOR_BOXES: toolboxes.CONNECTOR_BOXES, connectedBoxes: toolboxes.connectedBoxes,
    allToolboxes: toolboxes.allToolboxes, resolveTools: toolboxes.resolveTools, isWriteTool: toolboxes.isWriteTool,
    automaticToolsReady: () => (box) => box.server !== 'nextcloud' || nextcloudReady,
    // As the real policy with nothing stored (tool-policy.cjs): a read runs, a write asks.
    toolPolicy: { mode: (_user, _name, isWrite) => (isWrite ? 'ask' : 'allow') }, requestScope: { getStore: () => ({ authn: { user } }) },
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (text) => ({ text: String(text) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    chatWideApproved: () => chatWide, recordUsage() {}, recordToolUse() {},
    executeToolCall: async (_project, name) => { ran.push(name); return `synthetic result of ${name}`; },
    awaitApproval: async (request) => { approvals.push(request); return 'decline'; },
  });
  await handleChat({}, res, project
    ? { projectId: project.id, chatId: 'fixture-chat', message }
    : { spaceId: 'free', chatId: 'fixture-free-chat', message }, { user });
  const first = requests[0]?.body || {};
  return {
    events, requests, ran, gateOffered, approvals,
    pending: events.filter((e) => e.type === 'tool_pending').map((e) => e.name),
    model: first.model,
    tools: (first.tools || []).map((x) => x.function.name),
    toolChoice: first.tool_choice?.function?.name || null,
    route: events.find((e) => e.type === 'meta')?.route,
    scope: events.find((e) => e.type === 'tools_scope'),
    system: (first.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
  };
}

const WEB_QUESTION = 'What are the latest stable versions of Rust and Node LTS? Cite sources.';
const NC_QUESTION = 'List my Nextcloud top-level folders.';

for (const route of ['fast', 'smart']) {
  test(`#1550: an Automatic web question on the ${route} route is given the Web search tools, and the gate runs the search`, async (t) => {
    const r = await run(t, { message: WEB_QUESTION, route });
    assert.equal(r.route, route);
    assert.equal(r.model, ROLES[route]);
    assert.ok(r.tools.includes('tavily_search'), `the model is offered tavily_search (got ${r.tools.join(', ')})`);
    assert.ok(r.tools.includes('get_current_time'), 'the default box stays');
    assert.deepEqual(r.gateOffered[0], ['get_current_time', 'read_project_file', 'tavily_search', 'tavily_extract'], 'the default box first, then the added box');
    assert.deepEqual(r.ran, ['tavily_search'], 'the tool gate prefetches the search on the synthetic tool');
    assert.deepEqual(r.scope.boxes.map((b) => b.id), ['core', 'web-search'], 'the reply says which tools it was given');
    assert.doesNotMatch(r.system, /Web search is off|could not be used/, 'no "web search is off" note when it is on');
  });

  test(`#1550: an Automatic Nextcloud question on the ${route} route is given the Nextcloud Files tools, and the gate requires one`, async (t) => {
    const r = await run(t, { message: NC_QUESTION, route });
    assert.equal(r.route, route);
    assert.ok(r.tools.includes('nc_webdav_list_directory'), `the model is offered nc_webdav_list_directory (got ${r.tools.join(', ')})`);
    assert.ok(r.tools.includes('nc_webdav_delete_resource'), 'the whole box is offered; its write still stops at the approval card');
    assert.equal(r.toolChoice, 'nc_webdav_list_directory', 'the tool gate forces the Nextcloud read on the first turn');
    assert.ok(!r.tools.includes('tavily_search'), 'a Nextcloud question does not add the web');
    assert.match(r.system, /The user named Nextcloud Files\. Answer that request with the Nextcloud Files tools/);
    assert.doesNotMatch(r.system, /not available in this chat/);
  });
}

test('#1550: a free chat with no attachments (no project) is Automatic too, and gets the tools its message needs', async (t) => {
  const web = await run(t, { message: WEB_QUESTION, project: null });
  assert.ok(web.tools.includes('tavily_search'));
  const nc = await run(t, { message: NC_QUESTION, project: null, route: 'smart' });
  assert.ok(nc.tools.includes('nc_webdav_list_directory'));
});

test('#1550: chit-chat in Automatic adds nothing: the default box only, no scope line, no search', async (t) => {
  const r = await run(t, { message: 'Thanks, that helps a lot.' });
  assert.deepEqual(r.tools, ['get_current_time', 'read_project_file']);
  assert.deepEqual(r.ran, []);
  assert.equal(r.scope.text, '');
});

test('#1550: Manual tools are unchanged: a hand-picked list without Web search or Nextcloud gets neither', async (t) => {
  const web = await run(t, { message: WEB_QUESTION, project: MANUAL_PROJECT });
  assert.ok(!web.tools.includes('tavily_search'));
  assert.match(web.system, /Web search is off for this chat/);
  const nc = await run(t, { message: NC_QUESTION, project: MANUAL_PROJECT });
  assert.ok(!nc.tools.some((n) => n.startsWith('nc_')));
});

test('#1550: Nextcloud is not added for an account whose Nextcloud connection is not usable; the reply is told to say so', async (t) => {
  const r = await run(t, { message: NC_QUESTION, nextcloudReady: false });
  assert.ok(!r.tools.some((n) => n.startsWith('nc_')));
  assert.match(r.system, /Nextcloud Files is not available in this chat \(connect it under Settings > Connectors/);
});

test('#1550: a box of writes only is never added by Automatic, even when the message names it', async (t) => {
  const r = await run(t, { message: 'Check my mail inbox and send a reply to the synthetic team.' });
  assert.ok(!r.tools.includes('nc_mail_send_message'));
  assert.ok(!r.scope.boxes || !r.scope.boxes.some((b) => b.id === 'nextcloud-mail'));
});

test('#1550: an Automatic project resolves its whole selection: a connected Drive is no longer dropped', async (t) => {
  // resolveTools used to re-read an Automatic project as the default set and drop the connector the request carried.
  const r = await run(t, { message: 'Find the synthetic budget sheet in Google Drive.', driveConnected: true });
  assert.ok(r.tools.includes('drive_search_files'), `the connected Drive reaches the model (got ${r.tools.join(', ')})`);
});

test('#1550: tool routing may narrow the rest, but never drops the box the message asked for', async (t) => {
  const router = { select: async () => ({ ids: ['core'], routed: true, narrowed: true }) };
  const r = await run(t, { message: WEB_QUESTION, router });
  assert.ok(r.tools.includes('tavily_search'), 'the Web search box survives routing');
  assert.deepEqual(r.scope.boxes.map((b) => b.id), ['core', 'web-search']);
});

test('#1550: a box this server does not offer is never added', async (t) => {
  const r = await run(t, { message: WEB_QUESTION, boxes: [NC_FILES] });
  assert.ok(!r.tools.includes('tavily_search'));
  assert.match(r.system, /Web search is not available on this server/);
});

// ── Review fixes (core#84) ──────────────────────────────────────────────────

const CHATGPT = { id: 'chatgpt-synthetic', kind: 'chatgpt-oauth', label: 'ChatGPT', baseUrl: 'https://chatgpt.example.invalid' };
const MEMBER_CLOUD = { id: 'member-cloud', label: 'Synthetic cloud', baseUrl: 'https://cloud.example.invalid', external: true };
const ON_PROVIDER = (provider) => ({ ...AUTO_PROJECT, routing: 'manual', provider: provider.id, model: 'synthetic-cloud-model' });

for (const provider of [CHATGPT, MEMBER_CLOUD]) {
  test(`#1550 review: Automatic never adds the user's Nextcloud for an external provider (${provider.label})`, async (t) => {
    const r = await run(t, { message: 'List my Nextcloud folders', provider, project: ON_PROVIDER(provider) });
    assert.ok(r.requests.length > 0, 'the turn reached the provider');
    assert.equal(r.model, 'synthetic-cloud-model');
    assert.ok(!r.tools.some((n) => n.startsWith('nc_')), `no nc_* tool reaches ${provider.label} (got ${r.tools.join(', ')})`);
    assert.match(r.system, /your own files are only offered to a local model/);
    // Web search holds no user data: it may still be added for a cloud model.
    const web = await run(t, { message: WEB_QUESTION, provider, project: ON_PROVIDER(provider) });
    assert.ok(web.tools.includes('tavily_search'));
  });
}

test('#1550 review: a write reachable only through an added box asks per call, even under "Allow for this chat"', async (t) => {
  const del = toolCall('nc_webdav_delete_resource', { path: '/synthetic.txt' });
  const r = await run(t, { message: 'Delete synthetic.txt from my Nextcloud files', chatWide: true, gateOn: false, replies: [del] });
  assert.ok(r.tools.includes('nc_webdav_delete_resource'));
  assert.deepEqual(r.pending, ['nc_webdav_delete_resource'], 'the approval card is shown');
  assert.equal(r.approvals.length, 1);
  assert.ok(!r.ran.includes('nc_webdav_delete_resource'), 'declined: nothing ran');
  // The same write from the chat's own (Manual) list is covered by the chat-wide grant, as before.
  const manual = await run(t, { message: 'Delete synthetic.txt from my Nextcloud files', chatWide: true, gateOn: false, replies: [del],
    project: { ...MANUAL_PROJECT, toolboxes: ['core', 'nextcloud-files'] } });
  assert.deepEqual(manual.pending, [], 'a granted chat-list write runs without a card');
  assert.ok(manual.ran.includes('nc_webdav_delete_resource'));
});

test('#1550 review: without a grant, a write in an added box stops at the approval card (writes ask, as in the real policy)', async (t) => {
  const r = await run(t, { message: 'Delete synthetic.txt from my Nextcloud files', gateOn: false, replies: [toolCall('nc_webdav_delete_resource', { path: '/synthetic.txt' })] });
  assert.deepEqual(r.pending, ['nc_webdav_delete_resource']);
  assert.ok(!r.ran.includes('nc_webdav_delete_resource'));
});

/** A synthetic box of `count` tools that together take the whole `room` of the token budget (to within a few tokens). */
function budgetFillingBox(id, count, room) {
  const each = Math.floor(room / count);
  const tools = [];
  for (let i = 0; i < count; i++) {
    let description = 'Synthetic calendar read.';
    const make = () => fn(`nc_calendar_synthetic_${i}`, description, { day: { type: 'string' } });
    while (estimateToolTokens([make()]) < each) description += ' pad';
    while (estimateToolTokens([make()]) > each) description = description.slice(0, -1);
    tools.push(make());
  }
  return { id, server: 'nextcloud', label: 'Nextcloud Calendar', description: 'Calendar.', source: 'mcp', tools, reads: tools.map((x) => x.function.name) };
}

test('#1550 review: an added box never pushes the core tools out of a small model\'s cap and token budget', async (t) => {
  const budget = 4000;
  // Nine calendar tools that alone fill the budget after the fixed preamble: resolved first, they would leave no room for core.
  const calendar = budgetFillingBox('nextcloud-calendar', 9, budget - 240);
  const r = await run(t, { message: "What's on my calendar this week?", roles: { fast: 'synthetic-9b-model', smart: 'synthetic-9b-smart' },
    toolBudget: budget, boxes: [WEB, NC_FILES, calendar], gateOn: false });
  assert.ok(r.tools.includes('get_current_time'), `core stays (got ${r.tools.join(', ')})`);
  assert.ok(r.tools.includes('read_project_file'));
  assert.ok(r.tools.includes('nc_calendar_synthetic_0'), 'the added box follows, as far as the budget goes');
  assert.ok(!r.tools.includes('tavily_search'), '"this week" beside a Nextcloud box does not add the web');
});
