'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolboxes } = require('./toolboxes.cjs');
const { createDriveTools } = require('./gdrive-tools.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');

async function runDriveCall(t, { name, savedMode = null, connected = true, decision = 'approve' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-drive-chat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const user = { id: 'synthetic-user' }, project = { id: 'synthetic-project', model: 'synthetic-model', toolboxes: ['core'], files: [] };
  const store = { workspace: { userId: user.id }, authn: { user } };
  const requestScope = { getStore: () => store, run: (_scope, fn) => fn() };
  const accounts = { forUser: () => ({ drive: { state: () => ({ state: connected ? 'connected' : 'disconnected' }) } }) };
  const definitions = createDriveTools({ accounts });
  const executions = [], approvals = [], requests = [], events = [];
  const driveTools = { ...definitions, execute: async (_user, tool) => { executions.push(tool); return 'synthetic Drive result'; } };
  const toolbox = createToolboxes({
    boxes: [driveTools.box], driveTools, offered: (id) => id !== 'gdrive',
    mcpBoxes: () => [], mcpTools: () => new Map(), prefill: { budgetFor: () => null, rateFor: () => 0 }, requestScope,
    scope: requestScope, documentSources: { notice: () => '' }, workspace: () => ({ dir }),
  });
  const res = new EventEmitter();
  res.writeHead = () => {};
  res.write = (line) => events.push(JSON.parse(line.slice(6)));
  res.end = () => { res.writableEnded = true; res.emit('finish'); };
  let round = 0;
  const fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const called = round++ === 0;
    const frame = called
      ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'synthetic-call', function: { name, arguments: '{}' } }] } }] }
      : { choices: [{ delta: { content: 'Done.' } }] };
    return { ok: true, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify(frame)}\n\n`); })() };
  };
  const handler = createChatHandler({
    fs, path, crypto, fetch, reasoningEffort: require('./reasoning-effort.cjs'), createToolExchange,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: require('./tool-result-reduce.cjs').reduceToolResult,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000,
    authService: { audit() {} }, toolPolicy: { mode: (_user, _tool, write) => write ? 'ask' : savedMode || 'allow' },
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'synthetic-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    requestScope, currentWorkspace: () => ({ userId: user.id, dir }), json() {}, getProject: () => project,
    getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid', label: 'Mock' }), providerHeaders: () => ({}), saveChats() {}, endpointApproved: () => true,
    diaryHeaders: () => ({}), diaryExtras: require('./diary-extras.cjs'), autoRoles: () => null, lastLoadedModel: () => null,
    classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    visionProbe: async () => ({ supported: false, reason: 'none' }), visionDescriptions: new Map(), skillsIndexFor: () => [],
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, chatToolRouter: { select: async (ids) => ({ ids, routed: false }) },
    ...toolbox, oauthServerIds: () => new Set(), accountReady: () => true,
    chatWideApproved: () => false, awaitApproval: async (request) => { approvals.push(request); return decision; },
    recordUsage() {}, recordToolUse() {},
  });
  await handler.handleChat({}, res, { message: 'Synthetic Drive request', projectId: project.id, chatId: 'synthetic-chat' });
  assert.equal(events.some((event) => event.type === 'error'), false, JSON.stringify(events.filter((event) => event.type === 'error')));
  return { executions, approvals, requests, events };
}

test('connected Drive read runs in chat without approval when omitted from ENABLED_TOOLBOXES', async (t) => {
  const r = await runDriveCall(t, { name: 'drive_read_file' });
  assert.ok(r.requests[0].tools.some((tool) => tool.function.name === 'drive_read_file'));
  assert.deepEqual(r.executions, ['drive_read_file']);
  assert.equal(r.approvals.length, 0);
  assert.equal(r.events.some((event) => event.type === 'tool_pending'), false);
});

test('saved ask still prompts for a Drive read and saved block withholds it', async (t) => {
  const ask = await runDriveCall(t, { name: 'drive_read_file', savedMode: 'ask' });
  assert.equal(ask.approvals.length, 1);
  assert.deepEqual(ask.executions, ['drive_read_file']);
  const blocked = await runDriveCall(t, { name: 'drive_read_file', savedMode: 'block' });
  assert.equal(blocked.requests[0].tools.some((tool) => tool.function.name === 'drive_read_file'), false);
  assert.deepEqual(blocked.executions, []);
});

test('Drive writes still require approval and disconnected accounts receive no Drive tools', async (t) => {
  const write = await runDriveCall(t, { name: 'drive_trash_file', decision: 'deny' });
  assert.equal(write.approvals.length, 1);
  assert.deepEqual(write.events.filter((event) => event.type === 'tool_pending').map((event) => [event.name, event.args]),
    [['drive_trash_file', '{}']]);
  assert.deepEqual(write.executions, []);
  const disconnected = await runDriveCall(t, { name: 'drive_read_file', connected: false });
  assert.equal(disconnected.requests[0].tools.some((tool) => tool.function.name === 'drive_read_file'), false);
  assert.deepEqual(disconnected.executions, []);
});
