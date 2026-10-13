'use strict';

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
// A box of writes only: Automatic never adds it, whatever the message says.
const MAIL_SEND = { id: 'nextcloud-mail-send', server: 'nextcloud', label: 'Send mail', description: 'Send email.', source: 'mcp',
  tools: [fn('nc_mail_send_message', 'Send an email.', { to: { type: 'string' } }, ['to'])], reads: [] };
const DRIVE_BOX = { id: 'gdrive', label: 'Google Drive', description: 'Drive.', source: 'builtin', tools: [fn('drive_search_files', 'Search Drive.', { query: { type: 'string' } })], reads: ['drive_search_files'] };

const ROLES = { fast: 'fast-model', smart: 'smart-model' };
const AUTO_PROJECT = { id: 'fixture-project', name: 'Synthetic', routing: 'auto', toolsMode: 'auto', toolboxes: ['core'], assets: [], files: [] };
const MANUAL_PROJECT = { ...AUTO_PROJECT, toolsMode: 'manual', toolboxes: ['core'] };

const stream = (...frames) => ({ ok: true, body: (async function* () { for (const f of frames) yield Buffer.from('data: ' + JSON.stringify(f) + '\n\n'); })() });

/**
 * One chat turn. `route` is what Auto picks (fast or smart); `project` null is a free chat with no attachments;
 * `nextcloudReady` is whether this account's Nextcloud connection is usable; `driveConnected` whether its Drive is.
 */
async function run(t, { message, route = 'fast', project = AUTO_PROJECT, nextcloudReady = true, driveConnected = false,
  boxes = [WEB, NC_FILES, NC_NOTES, MAIL_SEND], router = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-automatic-tools-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => { if (String(line).startsWith('data: ')) events.push(JSON.parse(String(line).slice(6))); };
  res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [], ran = [], gateOffered = [];
  const fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return stream({ choices: [{ delta: { content: 'synthetic reply' } }] }); };
  const toolboxes = createToolboxes({
    boxes: [DRIVE_BOX],
    driveTools: { names: new Set(['drive_search_files']), connected: () => driveConnected, execute: async () => 'synthetic drive result' },
    mcpBoxes: () => boxes, mcpTools: () => new Map(), offered: () => true,
    prefill: { budgetFor: () => null, rateFor: () => 0 },
  });
  const gate = createToolGate({ enabled: () => true, decide: async () => ({ selected: 'none' }), isWriteTool: toolboxes.isWriteTool, warn: () => {} });
  const toolGate = { ...gate, evaluate: async (text, tools, ...rest) => { gateOffered.push(tools.map((x) => x.function.name)); return gate.evaluate(text, tools, ...rest); } };
  const user = { id: 'synthetic-user', role: 'member' };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: Object.values(ROLES).map((name) => ({ model_name: name, loaded: true, backend_alive: true, recipe_options: { ctx_size: 32768 } })) } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {}, diaryEnabled: () => false }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange, toolGate,
    currentWorkspace: () => ({ userId: user.id, dir, assetDir: () => '/synthetic-only' }),
    getProject: () => project, getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), providerHeaders: () => ({}),
    autoRoles: () => ({ ...ROLES }), classifyFastOrSmart: async () => route, servedCatalogue: async () => [], modelsInstalled: async () => [],
    missingRoles: () => [], staleRolesError: () => null, lastLoadedModel: () => ROLES.fast,
    skillsIndexFor: () => [], visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: router || { select: async (ids) => ({ ids, routed: false }) },
    DEFAULT_TOOLBOXES: toolboxes.DEFAULT_TOOLBOXES, CONNECTOR_BOXES: toolboxes.CONNECTOR_BOXES, connectedBoxes: toolboxes.connectedBoxes,
    allToolboxes: toolboxes.allToolboxes, resolveTools: toolboxes.resolveTools, isWriteTool: toolboxes.isWriteTool,
    automaticToolsReady: (_user, box) => box.server !== 'nextcloud' || nextcloudReady,
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({ authn: { user } }) },
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (text) => ({ text: String(text) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async (_project, name) => { ran.push(name); return `synthetic result of ${name}`; }, awaitApproval: async () => 'decline',
  });
  await handleChat({}, res, project
    ? { projectId: project.id, chatId: 'fixture-chat', message }
    : { spaceId: 'free', chatId: 'fixture-free-chat', message });
  const first = requests[0]?.body || {};
  return {
    events, requests, ran, gateOffered,
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
    assert.deepEqual(r.gateOffered[0].slice(0, 2), ['tavily_search', 'tavily_extract'], 'the box the message needs is resolved first, so it wins the budget');
    assert.deepEqual(r.ran, ['tavily_search'], 'the tool gate prefetches the search on the synthetic tool');
    assert.deepEqual(r.scope.boxes.map((b) => b.id), ['web-search', 'core'], 'the reply says which tools it was given');
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

test('#1550: a box of writes only is never added by Automatic', async (t) => {
  const r = await run(t, { message: 'Send an email from my Nextcloud mail to the synthetic team.' });
  assert.ok(!r.tools.includes('nc_mail_send_message'));
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
  assert.deepEqual(r.scope.boxes.map((b) => b.id), ['web-search', 'core']);
});

test('#1550: a box this server does not offer is never added', async (t) => {
  const r = await run(t, { message: WEB_QUESTION, boxes: [NC_FILES] });
  assert.ok(!r.tools.includes('tavily_search'));
  assert.match(r.system, /Web search is not available on this server/);
});
