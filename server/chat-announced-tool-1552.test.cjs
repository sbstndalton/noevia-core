'use strict';
// #1552: a reply that announces a tool action ("I will read the full file...") and calls no tool gets one
// more try, with a note that nothing was read. Stubbed model output only; no engine, no model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { announcesToolAction, ANNOUNCED_NOTE } = require('./announced-action.cjs');

const toolCallFrame = (name) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-fixture', function: { name, arguments: '{}' } }] } }] });
const stream = (...frames) => ({ ok: true, body: (async function* () { for (const f of frames) yield Buffer.from('data: ' + JSON.stringify(f) + '\n\n'); })() });
async function run(t, { replies = [],second = 'text', toolThrows = false, stepSupervision = null, providerId = 'default', decision = 'approve_all',
  readOnly = false, toolResult = 'complete synthetic result', passThrough = false, ctxSize = 32768 } = {}) {
  const toolName = readOnly ? 'synthetic_read' : 'synthetic_write';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-tool-round-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6))); res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [], decisions = [];
  let executions = 0;
  const baseUrl = `http://${providerId}.invalid`;
  const fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    const reply = replies[requests.length - 1];
    if (reply === 'tool') return stream(toolCallFrame(toolName));
    return stream({ choices: [{ delta: { content: reply ?? 'synthetic final answer' } }] });
  };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: ctxSize } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', model: 'answer-model', assets: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: providerId, baseUrl }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [],
    toolPolicy: { mode: (_user, _name, write) => (write ? 'ask' : 'allow') }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [{ type: 'function', function: { name: toolName, parameters: { type: 'object' } } }], dropped: [] }), isWriteTool: (name) => name === 'synthetic_write',
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (text) => ({ text: passThrough ? String(text) : 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => { executions++; if (toolThrows) throw Error('connection lost after write'); return toolResult; },
    awaitApproval: async (args) => { decisions.push(Object.keys(args).sort()); return decision === 'approve_all' ? 'approve' : decision; },
    stepSupervision,
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'Which item in the CSV has the highest qty?' });
  return { events, requests, decisions, executions };
}

const deltas = (r) => r.events.filter((e) => e.type === 'delta').map((e) => e.text).join('');

test('the end of a reply that promises a tool action is recognised; answers are not', () => {
  for (const text of [
    'I will read the full file and compute the monthly totals.',
    "Sure. Let me check the CSV first.",
    "I'll look at qa_sales.csv now:",
    'To answer this, I need to read the file.',
    'Here is the plan. First, I will list the project files, then open each one.',
    'I’m going to search the web for the latest release.',
    'I will read qa_sales.csv. Then I will open qa_config.json.',
  ]) assert.equal(announcesToolAction(text), true, text);
  for (const text of [
    '',
    'The item with the highest qty is Widget B (42).',
    'I read the CSV: Widget B has the highest qty (42).',
    'I will not guess: the file is not in this project.',
    'Let me know if you want the totals by month.',
    'I will read the full file and total the months.\n\nWidget B has the highest qty (42), followed by Widget A (30), and the totals are January 120, February 98 and March 143 in this file overall.',
  ]) assert.equal(announcesToolAction(text), false, text);
});

test('a promised read with no tool call gets one retry that ends in a tool call and an answer (#1552)', async (t) => {
  const r = await run(t, { readOnly: true, passThrough: true, replies: ['I will read the full file and find the highest qty.', 'tool', 'Widget B has the highest qty (42).'] });
  assert.equal(r.requests.length, 3);
  assert.equal(r.executions, 1, 'the tool ran on the retry');
  const retry = r.requests[1].body.messages;
  assert.deepEqual(retry.slice(-2), [{ role: 'assistant', content: 'I will read the full file and find the highest qty.' }, { role: 'user', content: ANNOUNCED_NOTE }]);
  assert.ok(r.events.some((e) => e.type === 'preamble' && /I will read/.test(e.text)), 'the promise is kept as narration');
  assert.match(deltas(r), /Widget B has the highest qty/);
  assert.ok(r.events.some((e) => e.type === 'done'));
});

test('the retry happens once: a second promise ends the reply without a loop (#1552)', async (t) => {
  const r = await run(t, { readOnly: true, replies: ['Let me check the CSV.', 'Let me check the CSV again.'] });
  assert.equal(r.requests.length, 2);
  assert.equal(r.executions, 0);
});

test('a plain answer with no tool call is not retried (#1552)', async (t) => {
  const r = await run(t, { readOnly: true, replies: ['Widget B has the highest qty (42).'] });
  assert.equal(r.requests.length, 1);
});
