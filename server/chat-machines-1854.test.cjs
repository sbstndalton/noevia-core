'use strict';
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}
// sbstndalton/noevia#1854, a follow-up to #1840/#1849/#1850 (chat roles on Inference machines).
//  1. #1550 tool-capable move: an Automatic turn the tool gate says needs a tool, routed to a role whose model cannot
//     take tools, moves to a tool-capable role whether either role is here or on a machine. A role on a machine is a
//     candidate only when that machine answers and serves its model (ready()), and its own /props template takes tools
//     (the #1850 verdict, kept per machine + model).
//  2. Measurements per machine + served model: context, thinking switch and image input from the machine's own /props,
//     the prefill rate under the machine's scope; auto-tune, presets, long profiles and speculative decoding are named as
//     not measured on machines. Nothing assigned: every request is byte-identical.
// Driven against a fake llama-server on loopback. Synthetic models, templates and prompts only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const reasoningEffort = require('./reasoning-effort.cjs');
const { createInferenceMachines } = require('./inference-machines.cjs');
const { createChatMachines, propsFactsOf, NOT_MEASURED_ON_MACHINES } = require('./chat-machines.cjs');
const { createMachineHealth } = require('./machine-health.cjs');
const templateCaps = require('./chat-template-caps.cjs');
const toolModes = require('./tools-mode.cjs');
const prefill = require('./prefill.cjs');

const LOCAL_KEY = 'synthetic-local-key-1854';
const REMOTE_MODEL = 'synthetic-remote-1854';
const ROLES = { fast: 'synthetic-fast', smart: 'synthetic-smart', code: 'synthetic-code' };
const catalogue = Object.values(ROLES).map((name) => ({ name }));
// Synthetic chat templates (checked by the Rust template classifier through dav-parse.wasm).
const NO_TOOLS_TEMPLATE = '{# {% if tools %} #}{{ raise_exception("Roles must alternate") }}';
const TOOLS_TEMPLATE = '{% if tools %}{% for t in tools %}{{ t | tojson }}{% endfor %}{% endif %}{% for m in messages %}{% if m.tool_calls %}{{ m.tool_calls | tojson }}{% endif %}{{ m.role }}{{ m.content }}{% endfor %}';
const THINKING_TEMPLATE = `${TOOLS_TEMPLATE}{% if enable_thinking is defined and enable_thinking is false %}<no-think>{% endif %}`;
const SYNTHETIC_TOOL = { type: 'function', function: { name: 'synthetic_lookup', description: 'Synthetic lookup.', parameters: { type: 'object', properties: { q: { type: 'string' } } } } };
const NEEDS_TOOL = { decision: { tool: 'synthetic_lookup', mode: 'require' }, source: 'decision', elapsedMs: 0 };

function memoryStore() { const map = new Map(); return { get: (k) => map.get(k), set: (k, v) => map.set(k, v) }; }

/** A fake llama-server: /health, /v1/models, /props (n_ctx, chat template, optional modalities) and /v1/chat/completions. */
async function fakeServer(t, { models = [REMOTE_MODEL], template = TOOLS_TEMPLATE, nCtx = 16384, modalities = undefined } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/health') return reply(200, { status: 'ok' });
      if (req.url === '/v1/models') return reply(200, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
      if (req.url.startsWith('/props')) return reply(200, { default_generation_settings: { n_ctx: nCtx }, chat_template: template, ...(modalities ? { modalities } : {}) });
      if (req.url === '/v1/chat/completions') {
        const body = JSON.parse(raw);
        if (!body.stream) return reply(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // A first token a few ms after the request, so the turn takes a prefill sample.
        return setTimeout(() => {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Remote hello.' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 3 } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }, 15);
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { port: server.address().port, seen, chats: () => seen.filter((s) => s.url === '/v1/chat/completions'), props: () => seen.filter((s) => s.url.startsWith('/props')) };
}

async function closedPort() {
  const s = http.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise((r) => s.close(r));
  return port;
}

async function machinesFor({ assign = [] } = {}) {
  const machines = createInferenceMachines({ store: memoryStore(), log: () => {} });
  const { machine } = await machines.add({ name: 'Synthetic Pi', address: '127.0.0.1' }, 'admin');
  for (const a of assign) machines.assign({ ...a, machine: machine.id }, 'admin');
  return { chatMachines: createChatMachines({ machines, health: createMachineHealth() }), machines, machineId: machine.id };
}

/**
 * One chat turn through the real handler. `localTemplates`: this machine's engine's chat template per model (the
 * local tools gate reads it through modelManager.props). `route`: the role the router picks.
 */
async function turn(t, { chatMachines = null, project, route = 'fast', localTemplates = {}, gate = NEEDS_TOOL, message = 'QA-SYNTH-1854 look this up', prefillCalls = null, resolveCalls = null } = {}) {
  const saved = { kind: process.env.MODEL_MANAGER_KIND, base: process.env.INFERENCE_BASE_URL };
  process.env.MODEL_MANAGER_KIND = 'llamacpp'; process.env.INFERENCE_BASE_URL = 'http://default.invalid';
  t.after(() => { for (const [k, v] of [['MODEL_MANAGER_KIND', saved.kind], ['INFERENCE_BASE_URL', saved.base]]) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1854-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], localRequests = [], engine = { makeRoomFor: [], props: [] };
  let replied = null;
  const res = new EventEmitter(); res.writeHead = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  res.write = (chunk) => { for (const line of String(chunk).split('\n')) if (line.startsWith('data:')) { try { events.push(JSON.parse(line.slice(5))); } catch { /* not json */ } } };
  const fetch = async (url, init) => {
    localRequests.push({ url: String(url), headers: init?.headers, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Local hello.' } }] })}\n\n`); })() };
  };
  const modelManager = { enabled: true, makeRoomFor: async (m) => { engine.makeRoomFor.push(m); },
    props: async (m) => { engine.props.push(m); return localTemplates[m] ? { ok: true, body: { chat_template: localTemplates[m] } } : { ok: false, status: 404 }; },
    health: async () => ({ ok: true, body: { all_models_loaded: catalogue.map((m) => ({ model_name: m.name, loaded: true, recipe_options: { ctx_size: 32768 } })) } }) };
  const { handleChat } = createChatHandler({
    chatMachines, modelManager, templateToolsGate: templateCaps.createToolsGate(),
    toolGate: gate ? { evaluate: async () => gate, record() {} } : null,
    reasoningEffort, crypto: require('node:crypto'), path, fs, fetch,
    authService: { audit() {}, db: { prepare: () => ({ get: () => undefined }) } },
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', assets: [], files: [], ...project }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', label: 'Local', baseUrl: 'http://default.invalid', apiKey: LOCAL_KEY }),
    providerHeaders: (p) => ({ 'Content-Type': 'application/json', ...(p.apiKey && p.apiKey !== 'local' ? { Authorization: `Bearer ${p.apiKey}` } : {}) }),
    autoRoles: () => ({ ...ROLES }),
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: (...args) => { if (resolveCalls) resolveCalls.push(args.slice(1)); return { tools: [SYNTHETIC_TOOL], dropped: [], routes: [] }; }, isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample: (...args) => { if (prefillCalls) prefillCalls.push(args); } }, reduceToolResult: (r) => ({ text: String(r) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: (_res, status, body) => { replied = { status, body }; }, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => route, servedCatalogue: async () => catalogue, modelsInstalled: async () => catalogue,
    missingRoles: require('./auto-roles-check.cjs').missingRoles, staleRolesError: require('./auto-roles-check.cjs').staleRolesError,
    allToolboxes: () => [{ id: 'core', tools: [SYNTHETIC_TOOL] }], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => 'synthetic result', awaitApproval: async () => 'decline',
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message });
  return { events, localRequests, engine, replied, route: events.find((e) => e.type === 'meta' && e.route)?.route,
    errors: events.filter((e) => e.type === 'error'), warnings: events.filter((e) => e.type === 'warning').map((e) => e.text) };
}

const automatic = { routing: 'auto', toolsMode: 'auto' };
const localChats = (out) => out.localRequests.filter((r) => r.url.includes('/chat/completions'));
// The answer's first request (a required tool the model did not call is asked again, with the same model).
const firstLocal = (out) => localChats(out)[0];
const allModel = (out, model) => localChats(out).every((r) => r.body.model === model);

// ── 1. #1550 tool-capable move with roles on machines ──

test('#1854 move: Fast here cannot take tools, Smart on a machine can: the turn goes to the machine with its tools', async (t) => {
  const fake = await fakeServer(t, { template: TOOLS_TEMPLATE });
  const { chatMachines } = await machinesFor({ assign: [{ service: 'chatSmart', port: fake.port, model: REMOTE_MODEL }] });
  const out = await turn(t, { chatMachines, project: automatic, localTemplates: { [ROLES.fast]: NO_TOOLS_TEMPLATE } });
  assert.deepEqual(out.errors, []);
  assert.equal(localChats(out).length, 0, 'nothing is answered here');
  const [chat] = fake.chats();
  assert.ok(chat, 'the machine answered the moved turn');
  assert.equal(chat.body.model, REMOTE_MODEL);
  assert.deepEqual(chat.body.tools.map((x) => x.function.name), ['synthetic_lookup'], 'the tools went with it');
  assert.equal(chat.headers.authorization, undefined, 'the local key never leaves for another host');
  assert.equal(JSON.stringify(chat.headers).includes(LOCAL_KEY), false);
  assert.equal(out.route, 'smart', 'the client is told the route it really got');
  assert.deepEqual(out.engine.makeRoomFor, [], 'nothing loaded or unloaded here');
  assert.ok(fake.props().length >= 1, 'the machine template was read from its own /props');
  assert.deepEqual(out.warnings, []);
});

test('#1854 move: Fast on a machine cannot take tools, Smart here can: the turn comes back to this machine', async (t) => {
  const fake = await fakeServer(t, { template: NO_TOOLS_TEMPLATE });
  const { chatMachines } = await machinesFor({ assign: [{ service: 'chatFast', port: fake.port, model: REMOTE_MODEL }] });
  const out = await turn(t, { chatMachines, project: automatic, localTemplates: { [ROLES.smart]: TOOLS_TEMPLATE } });
  assert.deepEqual(out.errors, []);
  assert.equal(fake.chats().length, 0, 'the machine whose template cannot take tools gets no turn');
  const first = firstLocal(out);
  assert.ok(first);
  assert.ok(allModel(out, ROLES.smart));
  assert.deepEqual(first.body.tools.map((x) => x.function.name), ['synthetic_lookup']);
  assert.equal(first.headers.Authorization, `Bearer ${LOCAL_KEY}`, 'the local provider and its key, as for a turn routed here');
  assert.deepEqual(out.engine.makeRoomFor, [ROLES.smart], 'the local engine loads the model it now answers with');
  assert.equal(out.route, 'smart');
});

test('#1854 move: Fast and Smart on the same machine: a tools-capable Smart there takes the turn after the same checks', async (t) => {
  const fastSrv = await fakeServer(t, { models: ['synthetic-remote-fast'], template: NO_TOOLS_TEMPLATE });
  const smartSrv = await fakeServer(t, { template: TOOLS_TEMPLATE });
  const { chatMachines } = await machinesFor({ assign: [{ service: 'chatFast', port: fastSrv.port, model: 'synthetic-remote-fast' }, { service: 'chatSmart', port: smartSrv.port, model: REMOTE_MODEL }] });
  const out = await turn(t, { chatMachines, project: automatic });
  assert.deepEqual(out.errors, []);
  assert.equal(fastSrv.chats().length, 0);
  assert.ok(smartSrv.chats().length >= 1);
  assert.ok(smartSrv.chats().every((c) => c.body.model === REMOTE_MODEL));
  assert.ok(smartSrv.seen.some((s) => s.url === '/health'), 'the candidate machine was health-checked before the move');
  assert.equal(localChats(out).length, 0);
});

test('#1854 move: an unreachable machine role is never a candidate; the next capable role here takes the turn', async (t) => {
  const { chatMachines } = await machinesFor({ assign: [{ service: 'chatSmart', port: await closedPort(), model: REMOTE_MODEL }] });
  const out = await turn(t, { chatMachines, project: automatic, localTemplates: { [ROLES.fast]: NO_TOOLS_TEMPLATE, [ROLES.code]: TOOLS_TEMPLATE } });
  assert.deepEqual(out.errors, []);
  assert.ok(firstLocal(out));
  assert.ok(allModel(out, ROLES.code), 'Smart was skipped: its machine does not answer');
  assert.equal(out.route, 'code');
});

test('#1854 move: a machine that now serves another model is not a candidate (the wrong-model rule)', async (t) => {
  const fake = await fakeServer(t, { models: ['synthetic-other'], template: TOOLS_TEMPLATE });
  const { chatMachines } = await machinesFor({ assign: [{ service: 'chatSmart', port: fake.port, model: REMOTE_MODEL }] });
  const out = await turn(t, { chatMachines, project: automatic, localTemplates: { [ROLES.fast]: NO_TOOLS_TEMPLATE, [ROLES.code]: NO_TOOLS_TEMPLATE } });
  assert.equal(fake.chats().length, 0, 'never sent to a machine serving another model');
  assert.ok(firstLocal(out));
  assert.ok(allModel(out, ROLES.fast), 'no capable role: the routed model stays');
  assert.equal(firstLocal(out).body.tools, undefined);
  assert.deepEqual(out.warnings, [templateCaps.TOOLS_OFF_NOTICE]);
});

test('#1854 move: a turn routed to a machine that can take tools stays there', async (t) => {
  const fake = await fakeServer(t, { template: TOOLS_TEMPLATE });
  const { chatMachines } = await machinesFor({ assign: [{ service: 'chatFast', port: fake.port, model: REMOTE_MODEL }] });
  const out = await turn(t, { chatMachines, project: automatic, localTemplates: { [ROLES.smart]: TOOLS_TEMPLATE } });
  assert.ok(fake.chats().length >= 1);
  assert.ok(fake.chats().every((c) => c.body.model === REMOTE_MODEL));
  assert.equal(fake.chats()[0].body.tools.length, 1);
  assert.equal(localChats(out).length, 0);
  assert.equal(out.route, 'fast');
});

test('#1854 move default: nothing assigned moves exactly as before, byte for byte', async (t) => {
  const opts = { project: automatic, localTemplates: { [ROLES.fast]: NO_TOOLS_TEMPLATE, [ROLES.smart]: TOOLS_TEMPLATE } };
  const before = await turn(t, { ...opts, chatMachines: null });
  const after = await turn(t, { ...opts, chatMachines: (await machinesFor()).chatMachines });
  assert.ok(firstLocal(before));
  assert.ok(allModel(before, ROLES.smart), 'the #1550 move happened');
  assert.equal(JSON.stringify(after.localRequests), JSON.stringify(before.localRequests), 'byte-identical local requests');
  assert.deepEqual(after.engine, before.engine, 'the same local template reads and loads');
  assert.equal(after.route, before.route);
});

test('#1854 toolCapableRoute: a same-named model on another host is a candidate; omitted hostOf keeps the old skip', async () => {
  const roles = { fast: 'same', smart: 'same' };
  const calls = [];
  const allowsTools = async (m, role) => { calls.push(role); return role === 'smart'; };
  const old = await toolModes.toolCapableRoute({ model: 'same', routedRole: 'fast', roles, allowsTools });
  assert.equal(old.rerouted, false, 'no hostOf: the same name is skipped, as before');
  const moved = await toolModes.toolCapableRoute({ model: 'same', routedRole: 'fast', roles, allowsTools, hostOf: (r) => (r === 'smart' ? 'machine:x' : 'local') });
  assert.deepEqual(moved, { rerouted: true, model: 'same', role: 'smart' });
});

// ── 2. Measurements per machine + model ──

test('#1854 propsFactsOf: context, thinking switch and image input from a /props body; null when not said', () => {
  assert.deepEqual(propsFactsOf({ default_generation_settings: { n_ctx: 32768 }, chat_template: THINKING_TEMPLATE, modalities: { vision: true } }), { contextTokens: 32768, thinking: true, vision: true });
  assert.deepEqual(propsFactsOf({ default_generation_settings: { n_ctx: 8192 }, chat_template: TOOLS_TEMPLATE, modalities: { vision: false } }), { contextTokens: 8192, thinking: false, vision: false });
  assert.deepEqual(propsFactsOf({}), { contextTokens: null, thinking: null, vision: null });
  assert.deepEqual(propsFactsOf({ default_generation_settings: { n_ctx: 12 }, chat_template: 42, modalities: { vision: 'yes' } }), { contextTokens: null, thinking: null, vision: null });
  assert.deepEqual([...NOT_MEASURED_ON_MACHINES].sort(), ['autotune', 'longContextProfile', 'presets', 'speculativeDecoding']);
});

test('#1854 measurements: two machines serving the same model name are measured apart, cached with their health', async (t) => {
  const a = await fakeServer(t, { models: ['synthetic-same'], nCtx: 8192, template: TOOLS_TEMPLATE, modalities: { vision: false } });
  const b = await fakeServer(t, { models: ['synthetic-same'], nCtx: 65536, template: THINKING_TEMPLATE, modalities: { vision: true } });
  const { chatMachines } = await machinesFor({ assign: [{ service: 'chatFast', port: a.port, model: 'synthetic-same' }, { service: 'chatSmart', port: b.port, model: 'synthetic-same' }] });
  const ma = await chatMachines.measurements(chatMachines.target('fast'));
  const mb = await chatMachines.measurements(chatMachines.target('smart'));
  assert.deepEqual({ ...ma, notMeasured: undefined }, { contextTokens: 8192, thinking: false, vision: false, notMeasured: undefined });
  assert.deepEqual({ ...mb, notMeasured: undefined }, { contextTokens: 65536, thinking: true, vision: true, notMeasured: undefined });
  assert.deepEqual(ma.notMeasured, [...NOT_MEASURED_ON_MACHINES]);
  const reads = a.props().length;
  await chatMachines.measurements(chatMachines.target('fast'));
  assert.equal(a.props().length, reads, 'a second read inside the TTL is served from the cache');
});

test('#1854 thinking: a machine whose /props template has the switch gets the native switch at High; one without, the hint', async (t) => {
  const project = { routing: 'manual', model: REMOTE_MODEL, reasoningEffort: 'high' };
  const withSwitch = await fakeServer(t, { template: THINKING_TEMPLATE });
  const on = await turn(t, { chatMachines: (await machinesFor({ assign: [{ service: 'chatSmart', port: withSwitch.port, model: REMOTE_MODEL }] })).chatMachines, project, gate: null });
  assert.deepEqual(on.errors, []);
  const sent = withSwitch.chats()[0].body;
  assert.deepEqual(sent.chat_template_kwargs, { enable_thinking: true }, 'the measured switch is used');
  assert.equal(sent.messages.some((m) => m.role === 'system' && m.content === reasoningEffort.HINTS.high), false);
  const noSwitch = await fakeServer(t, { template: TOOLS_TEMPLATE });
  await turn(t, { chatMachines: (await machinesFor({ assign: [{ service: 'chatSmart', port: noSwitch.port, model: REMOTE_MODEL }] })).chatMachines, project, gate: null });
  const hinted = noSwitch.chats()[0].body;
  assert.equal(hinted.chat_template_kwargs, undefined, 'no switch measured: none sent');
  assert.ok(hinted.messages.some((m) => m.role === 'system' && m.content === reasoningEffort.HINTS.high), 'the effort hint instead');
});

test('#1854 thinking: the machine switch is measured, never named; this machine\'s rule is unchanged', () => {
  const machineRow = (thinkingSwitch) => ({ id: 'machine:m1', baseUrl: 'http://127.0.0.1:1/v1', machine: { id: 'm1', ...(thinkingSwitch ? { thinkingSwitch: true } : {}) } });
  assert.equal(reasoningEffort.nativeThinking(machineRow(true), 'any-name'), true);
  assert.equal(reasoningEffort.nativeThinking(machineRow(false), 'synthetic-qwen3-8b'), false, 'a Qwen3-looking name on a machine proves nothing');
  assert.equal(reasoningEffort.forcedAnswerBody({ messages: [] }, machineRow(true), 'm').chat_template_kwargs.enable_thinking, false);
  assert.equal(reasoningEffort.forcedAnswerBody({ messages: [] }, machineRow(false), 'm').chat_template_kwargs, undefined);
  assert.equal(reasoningEffort.nativeThinking({ id: 'default', baseUrl: 'http://x.invalid' }, 'synthetic-qwen3-8b'), false, 'not the local engine: as before');
});

test('#1854 vision: the machine\'s /props modalities answers without an image probe; unsaid, the probe goes through the machine', async (t) => {
  const says = await fakeServer(t, { modalities: { vision: false } });
  const cmA = (await machinesFor({ assign: [{ service: 'chatSmart', port: says.port, model: REMOTE_MODEL }] })).chatMachines;
  assert.equal((await cmA.visionFor(cmA.target('smart'))).supported, false);
  assert.equal(says.chats().length, 0, 'no inference request to learn what /props said');
  const yes = await fakeServer(t, { modalities: { vision: true } });
  const cmB = (await machinesFor({ assign: [{ service: 'chatSmart', port: yes.port, model: REMOTE_MODEL }] })).chatMachines;
  assert.equal((await cmB.visionFor(cmB.target('smart'))).supported, true);
  const silent = await fakeServer(t, {});
  const cmC = (await machinesFor({ assign: [{ service: 'chatSmart', port: silent.port, model: REMOTE_MODEL }] })).chatMachines;
  await cmC.visionFor(cmC.target('smart'));
  assert.equal(silent.chats().length, 1, 'the probe ran against that machine');
  assert.equal(silent.chats()[0].body.model, REMOTE_MODEL);
});

test('#1854 prefill: a machine turn is recorded and budgeted under its machine scope; a local turn exactly as before', async (t) => {
  const fake = await fakeServer(t, { template: TOOLS_TEMPLATE });
  const { chatMachines, machineId } = await machinesFor({ assign: [{ service: 'chatSmart', port: fake.port, model: REMOTE_MODEL }] });
  const remoteSamples = [], remoteResolve = [];
  await turn(t, { chatMachines, project: { routing: 'manual', model: REMOTE_MODEL }, gate: null, prefillCalls: remoteSamples, resolveCalls: remoteResolve });
  assert.ok(remoteSamples.length >= 1, 'a sample was taken');
  for (const s of remoteSamples) assert.equal(s[3], `machine:${machineId}`);
  assert.ok(remoteResolve.every((args) => args[2]?.measureScope === `machine:${machineId}`), 'tools budgeted by the machine\'s rate');
  const localResolve = [];
  await turn(t, { chatMachines: null, project: { routing: 'manual', model: ROLES.fast }, gate: null, resolveCalls: localResolve });
  assert.ok(localResolve.length >= 1);
  assert.ok(localResolve.every((args) => args.length === 2), 'a local turn passes the same two arguments after the project');
});

test('#1854 prefill store: a machine scope never feeds this machine\'s rate for the same name, nor the toolbox stats', () => {
  prefill.reset();
  for (const [n, ms] of [[500, 200], [4000, 1600]]) prefill.recordSample('synthetic-same', n, ms, 'machine:m1');
  assert.equal(prefill.rateFor('synthetic-same'), null, 'nothing measured here');
  assert.ok(prefill.rateFor('synthetic-same', 'machine:m1') > 0);
  assert.equal(prefill.budgetFor('synthetic-same', 10000), null);
  assert.ok(prefill.budgetFor('synthetic-same', 10000, 'machine:m1') > 0);
  assert.deepEqual(prefill.stats(), {}, 'the toolbox page lists this machine\'s models only');
  for (const [n, ms] of [[500, 1000], [4000, 8000]]) prefill.recordSample('synthetic-same', n, ms);
  assert.notEqual(prefill.rateFor('synthetic-same'), prefill.rateFor('synthetic-same', 'machine:m1'));
  assert.deepEqual(Object.keys(prefill.stats()), ['synthetic-same']);
  prefill.reset();
});

test('#1854 Settings view: health=1 carries what each chat role\'s machine measured; nothing assigned adds no key', async (t) => {
  const { createInferenceMachineRoutes } = require('./routes/inference-machines.cjs');
  const fake = await fakeServer(t, { nCtx: 32768, template: THINKING_TEMPLATE, modalities: { vision: false } });
  const call = async (env) => {
    let out = null;
    const route = createInferenceMachineRoutes({ json: (_res, status, body) => { out = { status, body }; }, readJson: async () => ({}), machines: env.machines, health: createMachineHealth(), chatMachines: env.chatMachines });
    await route({ method: 'GET' }, { setHeader() {} }, { path: '/api/models/machines', authn: { user: { id: 'admin', role: 'admin' } }, url: new URL('http://x.invalid/api/models/machines?health=1') });
    return out;
  };
  const assigned = await machinesFor({ assign: [{ service: 'chatSmart', port: fake.port, model: REMOTE_MODEL }] });
  const r = await call(assigned);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.health.measured, { chatSmart: { contextTokens: 32768, thinking: true, vision: false, notMeasured: [...NOT_MEASURED_ON_MACHINES] } });
  const none = await machinesFor();
  const r0 = await call(none);
  assert.equal('measured' in r0.body.health, false);
});
