'use strict';
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}
// sbstndalton/noevia#1787: on the local gemma route the "high" effort is sent as a best-effort hint. The hint said
// "Think through this step by step before answering.", and a model whose real thinking already goes to
// reasoning_content (the thinking panel) then also wrote its working into the reply: a "Reasoning:" heading,
// "Wait, let me re-calculate", and an answer that contradicted its own first line. The stream parser was not the
// cause (reasoning_content never reaches the reply; checked below). The hint now asks for care and a final answer
// only, without visible working. Synthetic provider; no network.
const test = require('node:test'), assert = require('node:assert/strict');
const { requestBody, requestWithEffort } = require('./reasoning-effort.cjs');

const provider = { id: 'hint-fixture', baseUrl: 'http://fixture.invalid', capabilities: {} };
const body = { model: 'synthetic-model', messages: [{ role: 'user', content: 'Synthetic timing question.' }] };

test('#1787: the high hint does not ask the model to write its reasoning into the reply', () => {
  const hint = requestBody(body, 'high', 'hint', provider).messages[0];
  assert.equal(hint.role, 'system');
  assert.doesNotMatch(hint.content, /step by step/i);
  assert.match(hint.content, /final answer only/i);
  assert.match(hint.content, /do not show your working/i);
});

test('#1787: the low hint is unchanged and still skips reasoning', () => {
  assert.equal(requestBody(body, 'low', 'hint', provider).messages[0].content, 'Answer directly and concisely; skip step-by-step reasoning.');
});

test('#1787: the hint reaches the provider on a real request', async () => {
  const sent = [];
  await requestWithEffort(async (_u, o) => { sent.push(JSON.parse(o.body)); return new Response('{}'); }, provider.baseUrl, {}, body, provider, 'synthetic-model', 'high', () => {});
  assert.doesNotMatch(sent[0].messages[0].content, /step by step/i);
});

test('#1787: reasoning_content from a reasoning parser stays in the thinking events, never in the reply text', async (t) => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { EventEmitter } = require('node:events');
  const { createChatHandler } = require('./chat.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1787-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [];
  const res = new EventEmitter(); res.writeHead = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  res.write = (chunk) => { for (const line of String(chunk).split('\n')) if (line.startsWith('data:')) { try { events.push(JSON.parse(line.slice(5))); } catch { /* not json */ } } };
  const frames = [{ reasoning_content: 'Scratch: 08:14 + 52 = 09:06. Wait, re-check.' }, { content: 'Desk at 09:21; leave home by 08:02.' }]
    .map((delta) => Buffer.from(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
  const fetch = async () => ({ ok: true, status: 200, body: (async function* () { yield* frames; })() });
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange: require('./tool-exchange.cjs').createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', model: 'answer-model', assets: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: require('./vision.cjs').createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) }, resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [{ id: 'core' }], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {}, executeToolCall: async () => 'unused', awaitApproval: async () => 'approve',
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'Synthetic timing question.' });
  const reply = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  const thinking = events.filter((e) => e.type === 'reasoning').map((e) => e.text).join('');
  assert.equal(reply, 'Desk at 09:21; leave home by 08:02.');
  assert.match(thinking, /Wait, re-check/);
  assert.doesNotMatch(reply, /Scratch|Wait/);
});
