'use strict';
// #865: a tool call is routed by (server, name), never by name alone. Two synthetic MCP servers
// offer the same tool name; whichever box offered the tool to the model is the server the call
// reaches, with that server's credential. A bare name two servers offer is refused, not guessed.
// Real mcp-wiring.cjs, mcp-boxes.cjs and toolboxes.cjs; fake protocol client, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createMcpWiring, createCredentialOriginCheck } = require('./mcp-wiring.cjs');
const { bindBoxes } = require('./mcp-boxes.cjs');
const { createToolboxes } = require('./toolboxes.cjs');

const NC_URL = 'http://nc.invalid/mcp';
const DIR_URL = 'https://dir.example/mcp';
const rawTool = (name, description = name) => ({ name, description, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } });

function fakeMcp(catalogues) {
  const calls = [];
  return {
    calls,
    async connect() { return { session: 1 }; },
    async disconnect() {},
    async listTools(url) { return catalogues[url] || []; },
    async callTool(url, _session, name, args, headers) { calls.push({ url, name, args, headers }); return { content: [{ type: 'text', text: `${url}:${name}` }] }; },
    convertTool(t) { return { ok: true, tool: { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } } }; },
    readOnlyHint(t) { return t.annotations ? t.annotations.readOnlyHint : undefined; },
    resultToText(r) { return r.content.map((c) => c.text).join(''); },
  };
}

const SELF_URL = 'http://127.0.0.1:9/mcp';

async function setup({ withDirectory = true, withInternal = false } = {}) {
  const catalogues = {
    [NC_URL]: [rawTool('search_files', 'operator search'), rawTool('nc_only')],
    ...(withDirectory ? { [DIR_URL]: [rawTool('search_files', 'directory search'), rawTool('project_append_file', 'directory append'), rawTool('dir_only')] } : {}),
    ...(withInternal ? { [SELF_URL]: [rawTool('project_append_file', 'noevia append')] } : {}),
  };
  const mcp = fakeMcp(catalogues);
  const scope = new AsyncLocalStorage();
  const directoryServers = withDirectory ? [{ id: 'dir', title: 'Synthetic directory', url: DIR_URL, auth: 'directory', directory: true }] : [];
  const wiring = createMcpWiring({
    servers: [{ id: 'nc', url: NC_URL, auth: 'nextcloud' }, ...(withInternal ? [{ id: 'self', url: SELF_URL, auth: 'internal' }] : [])],
    manifest: [{ id: 'nc-files', label: 'Files', server: 'nc', tools: ['search_files', 'nc_only'], reads: ['search_files', 'nc_only'] }],
    mcp, bindBoxes,
    directoryMcp: {
      asServers: () => directoryServers,
      boxFor: (server, names) => ({ id: server.id, server: server.id, label: server.title, directory: true, description: 'synthetic', tools: [...names] }),
      headersFor: () => ({ 'X-Key': 'directory-key' }), userHeadersFor: () => ({}), hasUserKey: () => false,
    },
    mcpOAuth: { connected: () => false, tokenFor: async () => null },
    directoryUrlAllowed: async () => true,
    credentialOriginAllowed: createCredentialOriginCheck('http://cloud.invalid'),
    scope,
    storageFor: () => ({ kind: 'nextcloud', baseUrl: 'http://cloud.invalid', username: 'synthetic-user', secret: 'synthetic-app-password' }),
    isWriteTool: () => false,
    internal: { mintToken: () => 'cap' }, internalKey: 'k',
    reduceToolResult: (text) => ({ text, reduced: false }), logger: { log() {}, warn() {} },
  });
  await wiring.discoverMcpTools(true);
  const toolboxes = createToolboxes({
    mcpBoxes: () => wiring.state.boxes, mcpTools: () => wiring.state.tools,
    prefill: { budgetFor: () => null, rateFor: () => 0 }, scope,
    documentSources: { notice: () => '', readPages: () => { throw new Error('no pages'); } },
    executeMcp: (name, args, signal, serverId) => wiring.executeMcpToolCall(name, args, signal, serverId),
  });
  const asUser = (fn, extra = {}) => scope.run({ workspace: { userId: 'synthetic-user' }, authn: { user: { id: 'synthetic-user' } }, ...extra }, fn);
  // What chat.cjs does: resolve the project's boxes, then call with the resolved names and routes.
  const callAs = async (toolboxIds, name) => {
    const resolved = toolboxes.resolveTools({ id: 'p1', toolboxes: toolboxIds }, 'model-70b');
    const allowed = new Set(resolved.tools.map((t) => t.function.name));
    const text = await asUser(() => toolboxes.executeToolCall({ id: 'p1' }, name, '{}', allowed, undefined, {}, { routes: resolved.routes }));
    return { resolved, text };
  };
  return { wiring, toolboxes, mcp, asUser, callAs };
}

test('enabling only the directory box routes a shared tool name to the directory server, with its own credential', async () => {
  const s = await setup();
  const { resolved, text } = await s.callAs(['dir'], 'search_files');
  assert.equal(resolved.tools.find((t) => t.function.name === 'search_files').function.description, 'directory search', 'the model is shown the directory tool');
  assert.equal(resolved.routes.get('search_files'), 'dir');
  assert.equal(text, `${DIR_URL}:search_files`);
  assert.equal(s.mcp.calls.length, 1);
  assert.equal(s.mcp.calls[0].url, DIR_URL);
  assert.deepEqual(s.mcp.calls[0].headers, { 'X-Key': 'directory-key' });
  assert.ok(!JSON.stringify(s.mcp.calls).includes('Basic'), 'the Nextcloud password never leaves for the other server');
});

test('the operator box keeps its own server for the same name, and the first selected box wins a clash', async () => {
  const s = await setup();
  const nc = await s.callAs(['nc-files'], 'search_files');
  assert.equal(nc.text, `${NC_URL}:search_files`);
  assert.match(s.mcp.calls[0].headers.Authorization, /^Basic /);
  const both = await s.callAs(['nc-files', 'dir'], 'search_files');
  assert.equal(both.resolved.routes.get('search_files'), 'nc');
  assert.equal(both.text, `${NC_URL}:search_files`);
  const reversed = await s.callAs(['dir', 'nc-files'], 'search_files');
  assert.equal(reversed.resolved.routes.get('search_files'), 'dir');
  assert.equal(reversed.text, `${DIR_URL}:search_files`);
  assert.deepEqual(s.mcp.calls.map((c) => c.url), [NC_URL, NC_URL, DIR_URL]);
});

test('a bare name two servers offer is refused rather than guessed; a unique bare name still runs', async () => {
  const s = await setup();
  const refused = await s.asUser(() => s.wiring.executeMcpToolCall('search_files', {}));
  assert.equal(refused, 'ERROR: tool "search_files" is offered by more than one MCP server, so it was not run.');
  const viaToolboxes = await s.asUser(() => s.toolboxes.executeToolCall({ id: 'p1' }, 'search_files', '{}', new Set(['search_files'])));
  assert.equal(viaToolboxes, refused, 'a caller that passes no routes gets the same refusal');
  assert.equal(s.mcp.calls.length, 0, 'nothing was sent to either server');
  assert.equal(await s.asUser(() => s.wiring.executeMcpToolCall('nc_only', {})), `${NC_URL}:nc_only`);
});

test('a route to a server that does not offer the name is refused, not redirected', async () => {
  const s = await setup();
  assert.equal(await s.asUser(() => s.wiring.executeMcpToolCall('nc_only', {}, undefined, 'dir')), 'ERROR: unknown tool "nc_only" on MCP server "dir"');
  assert.equal(await s.asUser(() => s.wiring.executeMcpToolCall('search_files', {}, undefined, 'gone')), 'ERROR: unknown tool "search_files" on MCP server "gone"');
  assert.equal(s.mcp.calls.length, 0);
});

test('operator-only deployments are unchanged: same tools offered byte for byte, bare calls still run', async () => {
  const s = await setup({ withDirectory: false });
  const { resolved, text } = await s.callAs(['nc-files'], 'search_files');
  assert.equal(JSON.stringify(resolved.tools), JSON.stringify(s.wiring.state.boxes[0].tools), 'no field is added to what the model sees');
  assert.equal(text, `${NC_URL}:search_files`);
  assert.equal(await s.asUser(() => s.wiring.executeMcpToolCall('search_files', {})), `${NC_URL}:search_files`, 'callers without a route (deep research) keep working');
  // Built-in tools carry no route and still run in-process.
  const core = s.toolboxes.resolveTools({ id: 'p1', toolboxes: ['core'] }, 'model-70b');
  assert.equal(core.routes.size, 0);
});

test('a call approved as a project file edit is refused unless it goes to noevia\'s own server (review of #865)', async () => {
  const s = await setup({ withInternal: true });
  const digest = 'f'.repeat(64);
  // Routed to the directory server that also offers project_append_file: refused, nothing sent.
  const refused = await s.asUser(() => s.toolboxes.executeToolCall({ id: 'p1' }, 'project_append_file', '{}', new Set(['project_append_file']), undefined, {},
    { routes: new Map([['project_append_file', 'dir']]), editTarget: digest }));
  assert.equal(refused, 'ERROR: project_append_file was approved as a project file edit, but "project_append_file" was offered by MCP server "dir"; it was not run.');
  assert.equal(s.mcp.calls.length, 0, 'the directory server received nothing');
  // Directly at the wiring, too.
  assert.match(await s.asUser(() => s.wiring.executeMcpToolCall('project_append_file', {}, undefined, 'dir'), { internalEditTarget: digest }), /^ERROR: .*was not run\.$/);
  assert.equal(s.mcp.calls.length, 0);
  // Routed to noevia's own server, the approved edit runs.
  const ran = await s.asUser(() => s.toolboxes.executeToolCall({ id: 'p1' }, 'project_append_file', '{}', new Set(['project_append_file']), undefined, {},
    { routes: new Map([['project_append_file', 'self']]), editTarget: digest }));
  assert.equal(ran, `${SELF_URL}:project_append_file`);
  assert.deepEqual(s.mcp.calls.map((c) => c.url), [SELF_URL]);
  // A directory call without an edit approval is unaffected.
  assert.equal(await s.asUser(() => s.wiring.executeMcpToolCall('project_append_file', {}, undefined, 'dir')), `${DIR_URL}:project_append_file`);
});

test('noevia\'s own fixed callers (deep research) get the single operator server even when a directory server shares the name', async () => {
  const s = await setup();
  assert.equal(s.wiring.operatorServerFor('search_files'), 'nc');
  assert.equal(s.wiring.operatorServerFor('nc_only'), 'nc');
  assert.equal(s.wiring.operatorServerFor('dir_only'), undefined, 'a directory-only tool has no operator server');
  assert.equal(s.wiring.operatorServerFor('nope'), undefined);
  // What index.cjs does for tavily_search / tavily_extract.
  assert.equal(await s.asUser(() => s.wiring.executeMcpToolCall('search_files', {}, undefined, s.wiring.operatorServerFor('search_files'))), `${NC_URL}:search_files`);
});

// The chat loop hands the resolved routes to every executeToolCall. Synthetic provider and tool.
function chatHarness(t, { frames, resolveTools, router = async (ids) => ({ ids, routed: false }), write = false }) {
  const { createChatHandler } = require('./chat.cjs');
  const { createToolExchange } = require('./tool-exchange.cjs');
  const { createVisionProbe } = require('./vision.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-routes-865-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], audits = [], seen = [];
  const res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6))); res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const stream = (...f) => ({ ok: true, body: (async function* () { for (const x of f) yield Buffer.from('data: ' + JSON.stringify(x) + '\n\n'); })() });
  let requests = 0;
  const fetch = async () => {
    const calls = frames[requests++];
    return calls ? stream({ choices: [{ delta: { tool_calls: calls.map((name, index) => ({ index, id: `call-${requests}-${index}`, function: { name, arguments: name === 'more_tools' ? '{}' : JSON.stringify({ q: `round ${requests}` }) } })) } }] })
      : stream({ choices: [{ delta: { content: 'done' } }] });
  };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit: (kind, _a, _b, detail) => audits.push({ kind, ...detail }) }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', model: 'answer-model', assets: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: router }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [],
    toolPolicy: { mode: (_u, _n, w) => (w ? 'ask' : 'allow') }, requestScope: { getStore: () => ({}) },
    resolveTools, isWriteTool: () => write,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (text) => ({ text }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async (_p, name, _a, _allowed, _s, _o, options) => { seen.push({ name, route: options?.routes?.get(name) }); return 'synthetic result'; },
    awaitApproval: async () => 'approve',
  });
  return { events, audits, seen, run: () => handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'synthetic search' }) };
}
const offer = (name, server) => ({ tools: [{ type: 'function', function: { name, parameters: { type: 'object' } } }], dropped: [], routes: new Map([[name, server]]) });

test('the chat loop passes the resolved routes to the tool call', async (t) => {
  const h = chatHarness(t, { frames: [['search_files']], resolveTools: () => offer('search_files', 'dir') });
  await h.run();
  assert.deepEqual(h.seen, [{ name: 'search_files', route: 'dir' }]);
});

test('the approval card and the write audit name the MCP server the call goes to', async (t) => {
  const h = chatHarness(t, { frames: [['search_files']], resolveTools: () => offer('search_files', 'dir'), write: true });
  await h.run();
  const pending = h.events.find((e) => e.type === 'tool_pending');
  assert.equal(pending.server, 'dir');
  assert.equal(pending.args, '{"q":"round 1"}', 'the full arguments are still on the card');
  assert.equal(h.audits.find((a) => a.kind === 'tool.write').server, 'dir');
  // A built-in (no route) adds no server field.
  const b = chatHarness(t, { frames: [['get_current_time']], resolveTools: () => ({ ...offer('get_current_time', 'x'), routes: new Map() }), write: true });
  await b.run();
  assert.equal('server' in b.events.find((e) => e.type === 'tool_pending'), false);
});

test('more_tools: the rest of the round keeps the narrowed routes; the widened ones apply from the next round', async (t) => {
  const h = chatHarness(t, {
    frames: [['more_tools', 'search_files'], ['search_files']],
    router: async () => ({ ids: ['narrow'], routed: true, narrowed: true }),
    resolveTools: (project) => (project.toolboxes.includes('narrow') ? offer('search_files', 'narrow-server') : offer('search_files', 'wide-server')),
  });
  await h.run();
  assert.deepEqual(h.seen, [{ name: 'search_files', route: 'narrow-server' }, { name: 'search_files', route: 'wide-server' }]);
});
