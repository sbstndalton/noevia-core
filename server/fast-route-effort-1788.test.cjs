'use strict';
// sbstndalton/noevia#1788 (after #1475): "Say hello in one short sentence." was routed Fast by the decision service,
// but the account's default effort (High) was applied anyway: the gemma reply got the High hint and the 8,192-token
// thinking cap, showed "Effort: high", and thought for about 19 s before "Hello there.". The #1475 fix capped
// thinking per effort; it never looked at the route. An Automatic turn routed Fast now runs at Low (the Low hint
// and its 512-token cap), so a trivial turn does not get extended reasoning. Smart and Code turns, and chats not
// on Automatic, keep the effort they had. Synthetic provider; no network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const reasoningEffort = require('./reasoning-effort.cjs');

let ROLES = { fast: 'synthetic-fast', smart: 'synthetic-smart' };
const catalogue = [{ name: 'synthetic-fast' }, { name: 'synthetic-smart' }, { name: 'synthetic-manual' }, { name: 'qwen3.5-9b-synthetic-fast' }];

async function turn(t, { route, project = { routing: 'auto' }, globalEffort = 'high', local = true }) {
  // The default provider is the local llama.cpp engine unless a case says otherwise (reasoning-effort.cjs localEngine).
  const saved = { kind: process.env.MODEL_MANAGER_KIND, base: process.env.INFERENCE_BASE_URL };
  if (local) { process.env.MODEL_MANAGER_KIND = 'llamacpp'; process.env.INFERENCE_BASE_URL = 'http://default.invalid'; }
  else { delete process.env.MODEL_MANAGER_KIND; delete process.env.INFERENCE_BASE_URL; }
  t.after(() => { for (const [k, v] of [['MODEL_MANAGER_KIND', saved.kind], ['INFERENCE_BASE_URL', saved.base]]) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1788-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], requests = [];
  const res = new EventEmitter(); res.writeHead = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  res.write = (chunk) => { for (const line of String(chunk).split('\n')) if (line.startsWith('data:')) { try { events.push(JSON.parse(line.slice(5))); } catch { /* not json */ } } };
  const fetch = async (url, init) => {
    if (String(url).endsWith('/chat/completions')) requests.push(JSON.parse(init.body));
    return { ok: true, status: 200, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello there.' } }] })}\n\n`); })() };
  };
  const settings = { reasoning_effort_default: globalEffort };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: catalogue.map((m) => ({ model_name: m.name, loaded: true, recipe_options: { ctx_size: 32768 } })) } }) },
    reasoningEffort, crypto: require('node:crypto'), path, fs, fetch,
    authService: { audit() {}, db: { prepare: (sql) => ({ get: () => { const key = /key='([a-z_]+)'/.exec(sql)?.[1]; return key in settings ? { value: settings[key] } : undefined; } }) } },
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', assets: [], ...project }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), providerHeaders: () => ({}), autoRoles: () => ROLES,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) }, resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => route, servedCatalogue: async () => catalogue, modelsInstalled: async () => catalogue, missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [{ id: 'core' }], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {}, executeToolCall: async () => 'unused', awaitApproval: async () => 'approve',
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'QA-SYNTH-1 Say hello in one short sentence.' });
  const meta = events.find((e) => e.type === 'meta' && e.reasoningEffort);
  return { request: requests[0], effort: meta?.reasoningEffort, thinkingCap: meta?.thinkingCap };
}

test('#1788: an Automatic turn routed Fast runs at Low with thinking OFF, not at the High default', async (t) => {
  const { request, effort, thinkingCap } = await turn(t, { route: 'fast' });
  assert.equal(request.model, 'synthetic-fast');
  assert.equal(effort, 'low');
  assert.equal(request.messages[0].content, reasoningEffort.HINTS.low);
  // Reopen (b84758dc): Low's 512-token cap still meant ~28-45 s of thinking at 11 tok/s on "hi". Thinking is switched off.
  assert.deepEqual(request.chat_template_kwargs, { enable_thinking: false }, 'the outgoing request has thinking disabled');
  assert.equal(thinkingCap, undefined, 'no thinking cap: there is no thinking to cut');
});

test('#1788 reopen: a Fast turn at the Standard (default) account effort also runs with thinking off', async (t) => {
  const { request } = await turn(t, { route: 'fast', globalEffort: 'default' });
  assert.deepEqual(request.chat_template_kwargs, { enable_thinking: false });
});

test('#1788 reopen: Smart, explicit picks and an explicit project effort keep their thinking (no switch sent)', async (t) => {
  for (const [label, opts] of [
    ['smart', { route: 'smart' }],
    ['manual pick', { route: 'fast', project: { routing: 'manual', model: 'synthetic-manual' } }],
    ['project high', { route: 'fast', project: { routing: 'auto', reasoningEffort: 'high' }, globalEffort: 'default' }],
    ['project low', { route: 'fast', project: { routing: 'auto', reasoningEffort: 'low' }, globalEffort: 'high' }],
    ['project default', { route: 'fast', project: { routing: 'auto', reasoningEffort: 'default' }, globalEffort: 'high' }],
  ]) {
    const { request } = await turn(t, opts);
    assert.equal(request.chat_template_kwargs?.enable_thinking === false, false, `${label}: thinking is not switched off`);
  }
});

test('#1788 review: the switch is only sent to the local llama.cpp engine, not to a default provider elsewhere', async (t) => {
  const { request, effort } = await turn(t, { route: 'fast', local: false });
  assert.equal(effort, 'low', 'still Low on a Fast route');
  assert.equal(request.chat_template_kwargs, undefined, 'no template switch for an engine that is not the local one');
});

test('#1788 reopen: a Qwen3.5 Fast role on the local engine also gets enable_thinking false', async (t) => {
  const roles = ROLES; ROLES = { fast: 'qwen3.5-9b-synthetic-fast', smart: 'synthetic-smart' };
  t.after(() => { ROLES = roles; });
  const { request } = await turn(t, { route: 'fast' });
  assert.equal(request.model, 'qwen3.5-9b-synthetic-fast');
  assert.equal(request.chat_template_kwargs?.enable_thinking, false, 'native-thinking path keeps it off as well');
});

test('#1788 reopen: fastRouteThinkingOff is only Automatic + Fast + no explicit project effort', () => {
  assert.equal(reasoningEffort.fastRouteThinkingOff({ auto: true, routedRole: 'fast', projectEffort: undefined }), true);
  assert.equal(reasoningEffort.fastRouteThinkingOff({ auto: true, routedRole: 'fast', projectEffort: 'nonsense' }), true, 'an invalid stored value is not a choice');
  for (const e of ['low', 'high', 'default']) assert.equal(reasoningEffort.fastRouteThinkingOff({ auto: true, routedRole: 'fast', projectEffort: e }), false);
  for (const role of ['smart', 'code', null, undefined]) assert.equal(reasoningEffort.fastRouteThinkingOff({ auto: true, routedRole: role }), false);
  assert.equal(reasoningEffort.fastRouteThinkingOff({ auto: false, routedRole: 'fast' }), false);
});

test('#1788 reopen: the gemma-4 and Qwen3 templates turn thinking off on enable_thinking false (llama.cpp defaults it on)', () => {
  const dir = path.join(__dirname, '../tests/fixtures/chat-templates');
  for (const f of ['google-gemma-4-31B-it.jinja', 'google-gemma-4-31B-it-interleaved.jinja']) {
    const tpl = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(tpl, /if enable_thinking is defined and enable_thinking -%}\s*\{\{- '<\|think\|>/, `${f}: <|think|> only when enable_thinking is true`);
    assert.match(tpl, /if not enable_thinking \| default\(false\) -%}\s*\{\{- '<\|channel>thought\\n<channel\|>'/, `${f}: an empty thought channel when it is false`);
  }
  const qwen = fs.readFileSync(path.join(dir, 'Qwen-Qwen3-0.6B.jinja'), 'utf8');
  assert.match(qwen, /enable_thinking is defined and enable_thinking is false %}\s*\{\{- '<think>\\n\\n<\/think>\\n\\n' }}/);
});

test('#1788: an Automatic turn routed Smart keeps High', async (t) => {
  const { request, effort, thinkingCap } = await turn(t, { route: 'smart' });
  assert.equal(request.model, 'synthetic-smart');
  assert.equal(effort, 'high');
  assert.equal(thinkingCap, require('./thinking-budget.cjs').thinkingCap('high', 8192), 'the High cap for this 32k context');
  assert.equal(request.messages[0].content, reasoningEffort.HINTS.high);
});

test('#1788: a chat not on Automatic keeps its effort whatever the model', async (t) => {
  const { request, effort } = await turn(t, { route: 'fast', project: { routing: 'manual', model: 'synthetic-manual' } });
  assert.equal(request.model, 'synthetic-manual');
  assert.equal(effort, 'high');
});

test('#1788: effortForRoute lowers only a Fast route, and never raises', () => {
  assert.equal(reasoningEffort.effortForRoute('high', 'fast'), 'low');
  assert.equal(reasoningEffort.effortForRoute('default', 'fast'), 'low');
  assert.equal(reasoningEffort.effortForRoute('low', 'fast'), 'low');
  for (const role of ['smart', 'code', null, undefined]) for (const e of ['high', 'default', 'low']) assert.equal(reasoningEffort.effortForRoute(e, role), e);
});

// Review of core#119: only the account default is lowered. A project's own effort is an explicit choice and wins.
test('#1788: a project set to High keeps High on a Fast route', async (t) => {
  const { request, effort } = await turn(t, { route: 'fast', project: { routing: 'auto', reasoningEffort: 'high' }, globalEffort: 'default' });
  assert.equal(request.model, 'synthetic-fast');
  assert.equal(effort, 'high');
  assert.equal(request.messages[0].content, reasoningEffort.HINTS.high);
});

test('#1788: a project set to Standard (default) keeps it on a Fast route', async (t) => {
  const { effort } = await turn(t, { route: 'fast', project: { routing: 'auto', reasoningEffort: 'default' }, globalEffort: 'high' });
  assert.notEqual(effort, 'low');
});
