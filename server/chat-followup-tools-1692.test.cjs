'use strict';

// #1692 / #1693 end to end with the real toolbox resolver and tool gate (rules only); the MCP boxes, model and
// provider are synthetic, nothing is loaded and no network is used. Harness copied from
// chat-automatic-tools-1550.test.cjs, with a turn history and a scripted tool executor.
//
// #1692: an Automatic follow-up on a chat that used Web search kept only core (+ Drive): "Using what your research
// tool just found, how many days ago..." names no web words, so #1550's per-message additions added nothing.
// #1693: the last tool round's results were never shown to the model, and the reply ended in an error.

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
  roles = ROLES, toolBudget = null, gateOn = true, chatWide = false, replies = null, history = undefined, execute = null } = {}) {
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
    executeToolCall: async (_project, name, args) => { ran.push(name); return execute ? execute(name, args, ran.length) : `synthetic result of ${name}`; },
    awaitApproval: async (request) => { approvals.push(request); return 'decline'; },
  });
  await handleChat({}, res, project
    ? { projectId: project.id, chatId: 'fixture-chat', message, ...(history ? { history } : {}) }
    : { spaceId: 'free', chatId: 'fixture-free-chat', message, ...(history ? { history } : {}) }, { user });
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

const FIRST = 'Search the web for the latest stable release of the Rust programming language and its release date. Cite your sources.';
const FOLLOW_UP = 'Using what your research tool just found, how many days ago was that release from today? Include the source link.';
const wireText = (r, i = 0) => (r.requests[i]?.body.messages || []).map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n');

for (const route of ['fast', 'smart']) {
  test(`#1692: an Automatic follow-up on the ${route} route keeps Web search from the turn that used it`, async (t) => {
    const history = [{ role: 'user', content: FIRST }, { role: 'assistant', content: 'Rust 1.99.0 was released on a synthetic date. Source: https://example.invalid/rust' }];
    const r = await run(t, { message: FOLLOW_UP, route, history });
    assert.ok(r.tools.includes('tavily_search'), `the follow-up keeps tavily_search (got ${r.tools.join(', ')})`);
    assert.deepEqual(r.scope.boxes.map((b) => b.id), ['core', 'web-search'], 'the reply says Web search is in use');
  });
}

test('#1692: the tool result a client sends back for a reply is carried, and keeps its box', async (t) => {
  // The previous reply failed before its answer (#1693): no assistant text, only its search result.
  const history = [{ role: 'user', content: 'Find that for me please.' }, { role: 'tool', name: 'tavily_search', content: 'synthetic: Rust 1.99.0, https://example.invalid/rust' }];
  const r = await run(t, { message: FOLLOW_UP, history });
  assert.ok(r.tools.includes('tavily_search'), 'a tool from the Web search box in history keeps the box');
  const text = wireText(r);
  assert.match(text, /ended before its answer/);
  assert.match(text, /Rust 1\.99\.0, https:\/\/example\.invalid\/rust/, 'the earlier search result is in context');
  assert.doesNotMatch(text, /No reply was kept/, 'the turn is not treated as abandoned');
});

test('#1692: a private box is never carried; Web search is not carried beside a Nextcloud request', async (t) => {
  const history = [{ role: 'user', content: 'List my Nextcloud top-level folders.' }, { role: 'assistant', content: 'Synthetic folders.' }];
  const r = await run(t, { message: 'Thanks. And which one is biggest?', history });
  assert.ok(!r.tools.some((n) => n.startsWith('nc_')), 'Nextcloud needs this message to ask');
  const both = await run(t, { message: 'Now list my Nextcloud files again.', history: [{ role: 'user', content: FIRST }, { role: 'assistant', content: 'Rust.' }] });
  assert.ok(both.tools.includes('nc_webdav_list_directory'));
  assert.ok(!both.tools.includes('tavily_search'), 'the web is not carried beside the user\'s Nextcloud data');
});

test('#1692: chit-chat with no web turn in history still adds nothing', async (t) => {
  const r = await run(t, { message: 'Thanks, that helps a lot.', history: [{ role: 'user', content: 'Hello there' }, { role: 'assistant', content: 'Hi.' }] });
  assert.deepEqual(r.tools, ['get_current_time', 'read_project_file']);
});

// ── #1693 ───────────────────────────────────────────────────────────────────

const reasoning = (text) => ({ choices: [{ delta: { reasoning_content: text } }] });
const callFrame = (name, id, args) => ({ choices: [{ delta: { reasoning_content: 'thinking', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });

test('#1693: when every tool round is spent, one no-tools round asks for the final answer from the results', async (t) => {
  // Gate off, so the three rounds are the model's own: two searches (rate limited) and one that succeeds.
  const replies = [callFrame('tavily_search', 'c1', { query: 'rust' }), callFrame('tavily_search', 'c2', { query: 'rust stable' }), callFrame('tavily_extract', 'c3', { urls: ['https://example.invalid/rust'] }),
    { choices: [{ delta: { content: 'Rust 1.99.0 (source: https://example.invalid/rust).' } }] }];
  const execute = (name, _args, n) => (n < 3 ? `ERROR: ${name} was rate limited by its provider (HTTP 429). This is retryable, but not now.` : 'synthetic page: Rust 1.99.0 https://example.invalid/rust');
  const r = await run(t, { message: FIRST, gateOn: false, replies, execute });
  assert.equal(r.requests.length, 4, 'one extra round after the three tool rounds');
  const last = r.requests[3].body;
  assert.equal(last.tools, undefined, 'the final round offers no tools');
  assert.equal(last.tool_choice, undefined);
  assert.match(last.messages.at(-1).content, /Write your final answer to the user now/);
  assert.ok(last.messages.some((m) => m.role === 'tool' && /Rust 1\.99\.0/.test(m.content)), 'the last tool result is shown to the model');
  const text = r.events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.match(text, /Rust 1\.99\.0/);
  assert.doesNotMatch(text, /reasoning without a final answer/);
});

const hasFinalNote = (req) => req.body.messages.some((m) => m.role === 'user' && /Write your final answer to the user now/.test(String(m.content)));

test('#1693: reasoning only after a tool result gets the final-answer round; if that is empty too, the reply keeps the sources', async (t) => {
  // Every reply after the search is reasoning only (including the engine-level "answer again" retry, #1585).
  const thinkOnly = reasoning('Still thinking about Rust 1.99.0.');
  const replies = [callFrame('tavily_search', 'c1', { query: 'rust' }), thinkOnly, thinkOnly, thinkOnly, thinkOnly, thinkOnly, thinkOnly];
  const r = await run(t, { message: FIRST, gateOn: false, replies, execute: () => 'synthetic: Rust 1.99.0 https://example.invalid/rust-release' });
  const finals = r.requests.filter(hasFinalNote);
  assert.ok(finals.length >= 1, 'the final-answer round ran');
  assert.ok(finals.every((req) => req.body.tools === undefined), 'with no tools');
  assert.ok(r.requests.length <= 5, `bounded: ${r.requests.length} requests`);
  assert.equal(r.ran.length, 1);
  const text = r.events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.doesNotMatch(text, /reasoning without a final answer/, 'no bare error');
  assert.match(text, /did not write a final answer\. Its reasoning is in the thinking above; these are the sources the tools returned/);
  assert.doesNotMatch(text, /Still thinking/, 'the reasoning is not promoted into the answer');
  assert.match(text, /- https:\/\/example\.invalid\/rust-release/, 'the tool\'s source link is kept');
});

test('#1693: a tool call written in the final-answer round is not run', async (t) => {
  const replies = [callFrame('tavily_search', 'c1', { query: 'a' }), callFrame('tavily_search', 'c2', { query: 'b' }), callFrame('tavily_search', 'c3', { query: 'c' }), callFrame('tavily_search', 'c4', { query: 'd' })];
  const r = await run(t, { message: FIRST, gateOn: false, replies });
  assert.equal(r.ran.length, 3, 'only the three tool rounds ran tools');
  assert.ok(r.events.some((e) => e.type === 'tool_result' && e.notRun === true));
  assert.equal(r.requests.length, 4);
});

test('#1693: a reply with no tools that writes only reasoning keeps the existing notice (no extra round)', async (t) => {
  const r = await run(t, { message: 'Thanks, that helps a lot.', gateOn: false, replies: [reasoning('hmm'), reasoning('hmm'), reasoning('hmm')] });
  assert.ok(!r.requests.some(hasFinalNote), 'no final-answer round without tool results');
  assert.match(r.events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), /reasoning without a final answer/);
});

// ── Review fixes (#1700, #1702) ─────────────────────────────────────────────

const MEMBER_CLOUD = { id: 'member-cloud', label: 'Synthetic cloud', baseUrl: 'https://cloud.example.invalid', external: true };
const ON_CLOUD = { ...AUTO_PROJECT, routing: 'manual', provider: MEMBER_CLOUD.id, model: 'synthetic-cloud-model' };
const failedWith = (name, content) => [{ role: 'user', content: 'Find it for me.' }, { role: 'tool', name, content }];

for (const [name, secret] of [['nc_notes_search_notes', 'SYNTHETIC-PRIVATE-NOTE-7731'], ['read_project_file', 'SYNTHETIC-PRIVATE-FILE-4402'], ['unknown_tool', 'SYNTHETIC-UNKNOWN-9910']]) {
  test(`#1700: a failed reply's ${name} result never reaches a cloud model on the next turn`, async (t) => {
    const r = await run(t, { message: 'And what did that say?', provider: MEMBER_CLOUD, project: ON_CLOUD, history: failedWith(name, secret) });
    assert.ok(r.requests.length >= 1);
    for (const req of r.requests) assert.doesNotMatch(JSON.stringify(req.body), new RegExp(secret), 'the private result is not in the upstream body');
  });
}

test('#1700: a failed reply\'s public search result is still carried, on a cloud route too', async (t) => {
  const r = await run(t, { message: 'And when was that?', provider: MEMBER_CLOUD, project: ON_CLOUD, history: failedWith('tavily_search', 'SYNTHETIC-PUBLIC-RESULT-5150') });
  assert.match(JSON.stringify(r.requests[0].body), /SYNTHETIC-PUBLIC-RESULT-5150/);
});

test('#1702: Web search is not carried when recent history has a private tool result', async (t) => {
  const history = [{ role: 'user', content: FIRST }, { role: 'assistant', content: 'Rust.' }, { role: 'user', content: 'Search my notes too.' }, { role: 'tool', name: 'nc_notes_search_notes', content: 'synthetic note' }];
  const r = await run(t, { message: FOLLOW_UP, history });
  assert.ok(!r.tools.includes('tavily_search'), `no carry beside private results (got ${r.tools.join(', ')})`);
});

test('#1702: Web search is not carried when the turn already has a Nextcloud box', async (t) => {
  const project = { ...AUTO_PROJECT, toolsMode: 'manual', toolboxes: ['core', 'nextcloud-notes'] };
  const history = [{ role: 'user', content: FIRST }, { role: 'assistant', content: 'Rust.' }];
  // Manual never carries (Automatic only); the pure rule covers an Automatic turn whose base holds a Nextcloud box.
  const r = await run(t, { message: FOLLOW_UP, history, project });
  assert.ok(!r.tools.includes('tavily_search'));
  const toolModes = require('./tools-mode.cjs');
  const added = toolModes.automaticAdditions({ message: FOLLOW_UP, base: ['core', 'nextcloud-notes'], boxes: [WEB, NC_NOTES], connectorBoxes: new Set(), isWriteTool: () => false, carried: ['web-search'] });
  assert.deepEqual(added, []);
  const control = toolModes.automaticAdditions({ message: FOLLOW_UP, base: ['core'], boxes: [WEB, NC_NOTES], connectorBoxes: new Set(), isWriteTool: () => false, carried: ['web-search'] });
  assert.deepEqual(control, ['web-search']);
});

test('#1700: tool_result marks a public tool public, and never a private one', async (t) => {
  const replies = [callFrame('tavily_search', 'c1', { query: 'rust' }), callFrame('nc_notes_search_notes', 'c2', { query: 'x' })];
  const r = await run(t, { message: 'Search my notes and the web for the synthetic thing.', gateOn: false, replies });
  const results = r.events.filter((e) => e.type === 'tool_result');
  assert.equal(results.find((e) => e.name === 'tavily_search')?.public, true);
  const nc = results.find((e) => e.name === 'nc_notes_search_notes');
  if (nc) assert.equal(nc.public, undefined);
});
