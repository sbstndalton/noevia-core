'use strict';
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}
// sbstndalton/noevia#1849 and #1850, follow-ups to #1840 (chat roles on Inference machines). Each consumer that
// follows a role to its machine is driven against a fake llama-server on loopback: a Manual pick of a model a
// machine serves, the auto-router classifier (Fast on a machine) and Deep Research (Smart on a machine). Same rules
// as an Automatic turn: the on-this-network fetch, no local key, the health and served-model check with its clear
// errors, nothing loaded or unloaded here. #1850: the template tools gate and the tools-refused retry run for a model
// on a machine, keyed by machine + model as served. With nothing assigned every path sends exactly what it did before.
// Synthetic models, templates and prompts only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const reasoningEffort = require('./reasoning-effort.cjs');
const { createInferenceMachines } = require('./inference-machines.cjs');
const { createChatMachines } = require('./chat-machines.cjs');
const { createMachineHealth } = require('./machine-health.cjs');
const { createAutoRouter } = require('./auto-router.cjs');
const { createResearchModel } = require('./research-model.cjs');
const templateCaps = require('./chat-template-caps.cjs');
const { readCappedJson } = require('./http.cjs');

const LOCAL_KEY = 'synthetic-local-key-1849';
const REMOTE_MODEL = 'synthetic-remote-1849';
const ROLES = { fast: 'synthetic-fast', smart: 'synthetic-smart' };
const catalogue = [{ name: 'synthetic-fast' }, { name: 'synthetic-smart' }];
// Synthetic chat templates (checked by the Rust template classifier through dav-parse.wasm).
const NO_TOOLS_TEMPLATE = '{# {% if tools %} #}{{ raise_exception("Roles must alternate") }}';
const TOOLS_TEMPLATE = '{% if tools %}{% for t in tools %}{{ t | tojson }}{% endfor %}{% endif %}{% for m in messages %}{% if m.tool_calls %}{{ m.tool_calls | tojson }}{% endif %}{{ m.role }}{{ m.content }}{% endfor %}';
const PARSER_400 = JSON.stringify({ error: { code: 400, message: 'Unable to generate parser for this template. Automatic parser generation failed: roles must alternate', type: 'invalid_request_error' } });

function memoryStore() { const map = new Map(); return { get: (k) => map.get(k), set: (k, v) => map.set(k, v) }; }

/**
 * A fake llama-server: /health, /v1/models, /props (n_ctx and a chat template), and /v1/chat/completions, streaming
 * or not. `refuseTools`: a request carrying tools gets the llama.cpp "Unable to generate parser" 400.
 */
async function fakeServer(t, { models = [REMOTE_MODEL], template = TOOLS_TEMPLATE, refuseTools = false, verdict = 'SMART' } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"ok"}'); }
      if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) })); }
      if (req.url.startsWith('/props')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ default_generation_settings: { n_ctx: 16384 }, chat_template: template })); }
      if (req.url === '/v1/chat/completions') {
        const body = JSON.parse(raw);
        if (refuseTools && Array.isArray(body.tools) && body.tools.length) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(PARSER_400); }
        if (!body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { content: body.messages?.[0]?.content?.includes?.('model router') ? verdict : 'Synthetic research note.' }, finish_reason: 'stop' }] }));
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Remote hello.' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { port: server.address().port, seen, chats: () => seen.filter((s) => s.url === '/v1/chat/completions') };
}

/** A closed loopback port: a machine that is not answering. */
async function closedPort() {
  const s = http.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise((r) => s.close(r));
  return port;
}

async function machinesFor({ assign = [] } = {}) {
  const machines = createInferenceMachines({ store: memoryStore(), log: () => {} });
  const { machine } = await machines.add({ name: 'Synthetic Pi', address: '127.0.0.1' }, 'admin');
  for (const a of assign) machines.assign({ ...a, machine: machine.id }, 'admin');
  return createChatMachines({ machines, health: createMachineHealth() });
}

/** One chat turn through the real handler, with a recording local engine. */
async function turn(t, { chatMachines = null, project = { routing: 'manual', model: REMOTE_MODEL }, rows = catalogue, tools = false,
  toolsGate = templateCaps.createToolsGate(), localProps = undefined, message = 'QA-SYNTH-1849 Say hello.' } = {}) {
  const saved = { kind: process.env.MODEL_MANAGER_KIND, base: process.env.INFERENCE_BASE_URL };
  process.env.MODEL_MANAGER_KIND = 'llamacpp'; process.env.INFERENCE_BASE_URL = 'http://default.invalid';
  t.after(() => { for (const [k, v] of [['MODEL_MANAGER_KIND', saved.kind], ['INFERENCE_BASE_URL', saved.base]]) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1849-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], localRequests = [], engine = { leases: [], health: 0, props: [] };
  let replied = null, catalogueReads = 0;
  const res = new EventEmitter(); res.writeHead = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  res.write = (chunk) => { for (const line of String(chunk).split('\n')) if (line.startsWith('data:')) { try { events.push(JSON.parse(line.slice(5))); } catch { /* not json */ } } };
  const fetch = async (url, init) => {
    localRequests.push({ url: String(url), headers: init?.headers, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Local hello.' } }] })}\n\n`); })() };
  };
  const toolDefs = tools ? [{ type: 'function', function: { name: 'synthetic_lookup', description: 'Synthetic lookup.', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }] : [];
  const modelManager = { enabled: true, acquireLease: async (m) => { engine.leases.push(m); return null; },
    health: async () => { engine.health++; return { ok: true, body: { all_models_loaded: catalogue.map((m) => ({ model_name: m.name, loaded: true, recipe_options: { ctx_size: 32768 } })) } }; } };
  if (localProps) modelManager.props = async (m) => { engine.props.push(m); return { ok: true, body: { chat_template: localProps } }; };
  const { handleChat } = createChatHandler({
    chatMachines, modelManager, templateToolsGate: toolsGate,
    reasoningEffort, crypto: require('node:crypto'), path, fs, fetch,
    authService: { audit() {}, db: { prepare: () => ({ get: () => undefined }) } },
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', assets: [], ...project }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', label: 'Local', baseUrl: 'http://default.invalid', apiKey: LOCAL_KEY }),
    providerHeaders: (p) => ({ 'Content-Type': 'application/json', ...(p.apiKey && p.apiKey !== 'local' ? { Authorization: `Bearer ${p.apiKey}` } : {}) }),
    autoRoles: () => ROLES,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) }, resolveTools: () => ({ tools: toolDefs, dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (r) => ({ text: String(r) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: (_res, status, body) => { replied = { status, body }; }, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => { catalogueReads++; return rows; }, modelsInstalled: async () => rows,
    missingRoles: require('./auto-roles-check.cjs').missingRoles, staleRolesError: require('./auto-roles-check.cjs').staleRolesError,
    allToolboxes: () => [{ id: 'core', tools: toolDefs }], grantContext: async raw => require('../tests/server/chat-grant-fixture.cjs').context(raw, { holder: { kind: 'absent' } }), chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => 'synthetic result', awaitApproval: async () => 'approve',
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message });
  return { events, localRequests, engine, replied, catalogueReads, meta: events.find((e) => e.type === 'meta' && e.model),
    errors: events.filter((e) => e.type === 'error'), warnings: events.filter((e) => e.type === 'warning').map((e) => e.text) };
}

const localChats = (out) => out.localRequests.filter((r) => r.url.includes('/chat/completions'));
const shape = (out) => JSON.stringify(out.localRequests);

// ── #1849 Manual picks ──

test('#1849 Manual: a model only a machine serves runs on that machine (no local key, nothing loaded here)', async (t) => {
  const fake = await fakeServer(t);
  const chatMachines = await machinesFor({ assign: [{ service: 'chatSmart', port: fake.port, model: REMOTE_MODEL }] });
  const out = await turn(t, { chatMachines });
  assert.deepEqual(out.errors, []);
  assert.equal(localChats(out).length, 0, 'nothing sent to the local engine');
  const [chat] = fake.chats();
  assert.ok(chat, 'the machine got the Manual turn');
  assert.equal(chat.body.model, REMOTE_MODEL);
  assert.equal(chat.body.stream, true);
  assert.equal(chat.headers.authorization, undefined, 'the local API key never leaves for another host');
  assert.equal(JSON.stringify(chat.headers).includes(LOCAL_KEY), false);
  assert.equal(out.meta.model, REMOTE_MODEL);
  assert.deepEqual(out.engine.leases, [], 'no load or unload on this machine');
  assert.equal(out.engine.health, 0, 'no local residency read');
  assert.match(JSON.stringify(out.events), /Remote hello/);
});

test('#1849 Manual: a name this machine lists stays here even when a machine serves the same name', async (t) => {
  const fake = await fakeServer(t, { models: ['synthetic-smart'] });
  const chatMachines = await machinesFor({ assign: [{ service: 'chatSmart', port: fake.port, model: 'synthetic-smart' }] });
  const out = await turn(t, { chatMachines, project: { routing: 'manual', model: 'synthetic-smart' } });
  assert.equal(fake.chats().length, 0);
  assert.equal(localChats(out).length, 1);
  assert.equal(localChats(out)[0].body.model, 'synthetic-smart');
});

test('#1849 Manual: an unreachable machine fails the turn clearly and never falls back here', async (t) => {
  const chatMachines = await machinesFor({ assign: [{ service: 'chatSmart', port: await closedPort(), model: REMOTE_MODEL }] });
  const out = await turn(t, { chatMachines });
  assert.equal(out.replied?.status, 503);
  assert.equal(out.replied.body.code, 'machineUnreachable');
  assert.match(out.replied.body.error, /^Smart model’s machine \(Synthetic Pi\) is unreachable/);
  assert.equal(out.localRequests.length, 0);
  assert.deepEqual(out.engine.leases, []);
});

test('#1849 Manual: a machine that now serves another model fails with the wrong-model error', async (t) => {
  const fake = await fakeServer(t, { models: ['synthetic-other'] });
  const chatMachines = await machinesFor({ assign: [{ service: 'chatSmart', port: fake.port, model: REMOTE_MODEL }] });
  const out = await turn(t, { chatMachines });
  assert.equal(out.replied?.status, 503);
  assert.equal(out.replied.body.code, 'machineWrongModel');
  assert.match(out.replied.body.error, /serves synthetic-other, not synthetic-remote-1849/);
  assert.equal(fake.chats().length, 0);
  assert.equal(out.localRequests.length, 0);
});

test('#1849 Manual default: nothing assigned sends exactly the request it did before, and reads no extra catalogue', async (t) => {
  const project = { routing: 'manual', model: 'synthetic-fast' };
  const before = await turn(t, { chatMachines: null, project });
  const after = await turn(t, { chatMachines: await machinesFor(), project });
  assert.equal(localChats(before).length, 1);
  assert.equal(shape(after), shape(before), 'byte-identical local request');
  assert.equal(after.catalogueReads, before.catalogueReads, 'no catalogue read for the machine lookup');
  assert.deepEqual(after.engine.leases, before.engine.leases);
});

test('#1849 machineModels lists each machine model once with its roles; empty when nothing is assigned', async () => {
  assert.deepEqual((await machinesFor()).machineModels(), []);
  const cm = await machinesFor({ assign: [{ service: 'chatSmart', port: 8080, model: REMOTE_MODEL }, { service: 'chatCode', port: 8080, model: REMOTE_MODEL }] });
  const rows = cm.machineModels();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, REMOTE_MODEL);
  assert.equal(rows[0].machine.name, 'Synthetic Pi');
  assert.deepEqual(rows[0].roles.sort(), ['code', 'smart']);
});

// ── #1849 auto-router classifier ──

function router({ machine = null, calls, admitted, records }) {
  return createAutoRouter({
    roles: () => ({ fast: 'synthetic-fast', smart: 'synthetic-smart' }),
    provider: () => ({ id: 'default', baseUrl: 'http://default.invalid', apiKey: LOCAL_KEY }),
    headers: (p) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` }),
    fetchJson: async (url, init, timeoutMs) => { calls.push({ url, init, timeoutMs }); return { ok: true, status: 200, body: { choices: [{ message: { content: 'FAST' } }] } }; },
    admit: async (m) => { admitted.push(m); return null; },
    record: (e) => records.push(e),
    log: { log() {}, warn() {} },
    machine,
  });
}

test('#1849 classifier: with Fast on a machine the verdict comes from that machine (its model, no key, no admission)', async (t) => {
  const fake = await fakeServer(t, { verdict: 'SMART' });
  const cm = await machinesFor({ assign: [{ service: 'chatFast', port: fake.port, model: REMOTE_MODEL }] });
  const calls = [], admitted = [], records = [];
  const verdict = await router({ machine: cm, calls, admitted, records }).classify('QA-SYNTH-1849 hi there');
  assert.equal(verdict, 'smart');
  assert.equal(calls.length, 0, 'the local engine was not asked');
  assert.deepEqual(admitted, [], 'no local admission (nothing loads here)');
  const [chat] = fake.chats();
  assert.equal(chat.body.model, REMOTE_MODEL);
  assert.equal(chat.body.stream, false);
  assert.equal(chat.headers.authorization, undefined);
});

test('#1849 classifier: an unreachable or wrong-model Fast machine skips the classifier (rules default to fast)', async (t) => {
  for (const [cm, cause] of [
    [await machinesFor({ assign: [{ service: 'chatFast', port: await closedPort(), model: REMOTE_MODEL }] }), 'machine-unreachable'],
    [await machinesFor({ assign: [{ service: 'chatFast', port: (await fakeServer(t, { models: ['synthetic-other'] })).port, model: REMOTE_MODEL }] }), 'machine-wrong-model'],
  ]) {
    const calls = [], admitted = [], records = [];
    assert.equal(await router({ machine: cm, calls, admitted, records }).classify('QA-SYNTH-1849 hi there'), 'fast');
    assert.equal(calls.length, 0);
    assert.deepEqual(records, [{ selected: 'fast', fellBack: 'classifier-skipped', cause }]);
  }
});

test('#1849 classifier default: Fast here sends exactly the local request it did before', async () => {
  const a = { calls: [], admitted: [], records: [] }, b = { calls: [], admitted: [], records: [] };
  await router({ machine: null, ...a }).classify('QA-SYNTH-1849 hi there');
  await router({ machine: await machinesFor(), ...b }).classify('QA-SYNTH-1849 hi there');
  assert.equal(a.calls.length, 1);
  assert.deepEqual(b.calls, a.calls);
  assert.deepEqual(b.admitted, a.admitted);
});

// ── #1849 Deep Research ──

function research({ chatMachines = null, log }) {
  return createResearchModel({
    autoRoles: () => ROLES, lastLoadedModel: () => null, chatMachines,
    getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid', apiKey: LOCAL_KEY }), DEFAULT_PROVIDER_ID: 'default',
    providerHeaders: (p, extra) => ({ ...extra, Authorization: `Bearer ${p.apiKey}` }),
    fetch: async (url, init) => { log.local.push({ url, init: { ...init, signal: undefined } }); return new Response(JSON.stringify({ choices: [{ message: { content: 'Local note.' }, finish_reason: 'stop' }] }), { status: 200 }); },
    modelManager: { enterInference: () => { log.entered++; return () => { log.left++; }; } },
    admitEngineModel: async (m) => { log.admitted.push(m); },
    readCappedJson,
  });
}
const researchLog = () => ({ local: [], admitted: [], entered: 0, left: 0 });

test('#1849 Research: with Smart on a machine a research step runs there (its model, no key, no local gate or load)', async (t) => {
  const fake = await fakeServer(t);
  const log = researchLog();
  const r = research({ chatMachines: await machinesFor({ assign: [{ service: 'chatSmart', port: fake.port, model: REMOTE_MODEL }] }), log });
  assert.equal(r.model({ model: 'synthetic-fast' }), REMOTE_MODEL);
  const text = await r.complete({}, [{ role: 'user', content: 'QA-SYNTH-1849 summarise' }], { signal: new AbortController().signal, maxTokens: 64 });
  assert.equal(text, 'Synthetic research note.');
  assert.equal(log.local.length, 0);
  assert.deepEqual(log.admitted, []);
  assert.equal(log.entered, 0, 'the maintenance gate of this engine is not taken');
  const [chat] = fake.chats();
  assert.equal(chat.body.model, REMOTE_MODEL);
  assert.equal(chat.body.max_tokens, 64);
  assert.equal(chat.headers.authorization, undefined);
});

test('#1849 Research: unreachable and wrong-model machines fail the step with the clear text', async (t) => {
  const signal = new AbortController().signal;
  const down = research({ chatMachines: await machinesFor({ assign: [{ service: 'chatSmart', port: await closedPort(), model: REMOTE_MODEL }] }), log: researchLog() });
  await assert.rejects(down.complete({}, [], { signal, maxTokens: 8 }), (e) => /^Smart model’s machine \(Synthetic Pi\) is unreachable/.test(e.publicMessage) && e.code === 'machineUnreachable');
  const other = await fakeServer(t, { models: ['synthetic-other'] });
  const wrong = research({ chatMachines: await machinesFor({ assign: [{ service: 'chatSmart', port: other.port, model: REMOTE_MODEL }] }), log: researchLog() });
  await assert.rejects(wrong.complete({}, [], { signal, maxTokens: 8 }), (e) => /serves synthetic-other/.test(e.publicMessage) && e.code === 'machineWrongModel');
  assert.equal(other.chats().length, 0);
});

test('#1849 Research default: Smart here sends exactly the local request it did before', async () => {
  const a = researchLog(), b = researchLog();
  const signal = new AbortController().signal;
  const messages = [{ role: 'user', content: 'QA-SYNTH-1849 summarise' }];
  assert.equal(await research({ chatMachines: null, log: a }).complete({}, messages, { signal, maxTokens: 32 }), 'Local note.');
  assert.equal(await research({ chatMachines: await machinesFor(), log: b }).complete({}, messages, { signal, maxTokens: 32 }), 'Local note.');
  assert.deepEqual(b.local.map((x) => [x.url, x.init.body, x.init.headers, x.init.redirect]), a.local.map((x) => [x.url, x.init.body, x.init.headers, x.init.redirect]));
  assert.equal(a.local[0].init.body, JSON.stringify({ model: 'synthetic-smart', stream: false, max_tokens: 32, messages }));
  assert.deepEqual([b.admitted, b.entered, b.left], [a.admitted, a.entered, a.left]);
  assert.deepEqual(a.admitted, ['synthetic-smart']);
});

// ── #1850 the template tools gate per machine ──

test('#1850 a machine model whose template cannot take tools is sent none, read from that machine\'s /props', async (t) => {
  const fake = await fakeServer(t, { template: NO_TOOLS_TEMPLATE });
  const chatMachines = await machinesFor({ assign: [{ service: 'chatSmart', port: fake.port, model: REMOTE_MODEL }] });
  const out = await turn(t, { chatMachines, tools: true });
  assert.deepEqual(out.errors, []);
  const [chat] = fake.chats();
  assert.equal(chat.body.tools, undefined, 'no tools offered to a template that cannot take them');
  assert.ok(out.warnings.includes(templateCaps.TOOLS_OFF_NOTICE));
  assert.ok(fake.seen.some((s) => s.url === `/props?model=${REMOTE_MODEL}`));
  assert.deepEqual(out.engine.props, [], 'this machine\'s engine was not asked');
});

test('#1850 a machine that refuses tools gets the turn retried without them (not failed), remembered per machine + model', async (t) => {
  const fake = await fakeServer(t, { template: TOOLS_TEMPLATE, refuseTools: true });
  const chatMachines = await machinesFor({ assign: [{ service: 'chatSmart', port: fake.port, model: REMOTE_MODEL }] });
  const gate = templateCaps.createToolsGate();
  const out = await turn(t, { chatMachines, tools: true, toolsGate: gate });
  assert.deepEqual(out.errors, [], 'the turn is answered, not failed');
  const chats = fake.chats();
  assert.equal(chats.length, 2);
  assert.ok(Array.isArray(chats[0].body.tools));
  assert.equal(chats[1].body.tools, undefined, 'the retry carries no tools');
  assert.ok(out.warnings.includes(templateCaps.TOOLS_RETRY_NOTICE));
  assert.match(JSON.stringify(out.events), /Remote hello/);
  // The verdict is kept for this machine + model only: the next turn sends no tools at all, and the same model name on
  // this machine's engine (or another machine) is still asked for itself.
  const next = await turn(t, { chatMachines, tools: true, toolsGate: gate });
  assert.equal(fake.chats().length, 3);
  assert.equal(fake.chats()[2].body.tools, undefined);
  assert.ok(next.warnings.includes(templateCaps.TOOLS_OFF_NOTICE));
  const local = [];
  assert.equal(await gate.allowsTools({ props: async (m) => { local.push(m); return { ok: true, body: { chat_template: TOOLS_TEMPLATE } }; } }, REMOTE_MODEL), true);
  assert.deepEqual(local, [REMOTE_MODEL], 'the local engine is asked for its own verdict');
});

test('#1850 the tools gate keys by scope + model; no scope is the model name alone, as before', async () => {
  const gate = templateCaps.createToolsGate();
  const asked = [];
  const source = (template) => ({ props: async (m) => { asked.push(m); return { ok: true, body: { chat_template: template } }; } });
  assert.equal(await gate.allowsTools(source(NO_TOOLS_TEMPLATE), 'synthetic-m', undefined, 'machine:a'), false);
  assert.equal(await gate.allowsTools(source(TOOLS_TEMPLATE), 'synthetic-m', undefined, 'machine:b'), true);
  assert.equal(await gate.allowsTools(source(TOOLS_TEMPLATE), 'synthetic-m'), true);
  assert.equal(asked.length, 3, 'three separate verdicts');
  gate.markUnsupported('synthetic-m');
  assert.equal(await gate.allowsTools(source(TOOLS_TEMPLATE), 'synthetic-m'), false);
  assert.equal(await gate.allowsTools(source(TOOLS_TEMPLATE), 'synthetic-m', undefined, 'machine:b'), true, 'a local mark does not reach a machine');
  assert.equal(gate.size(), 3);
});

test('#1850 default: a local turn with tools asks this machine\'s engine exactly as before', async (t) => {
  const project = { routing: 'manual', model: 'synthetic-fast' };
  const before = await turn(t, { chatMachines: null, project, tools: true, localProps: TOOLS_TEMPLATE });
  const after = await turn(t, { chatMachines: await machinesFor(), project, tools: true, localProps: TOOLS_TEMPLATE });
  assert.deepEqual(after.engine.props, before.engine.props);
  assert.deepEqual(before.engine.props, ['synthetic-fast']);
  assert.equal(shape(after), shape(before));
  assert.ok(Array.isArray(localChats(after)[0].body.tools));
});

test('#1855 Manual: an unreadable local catalogue keeps the pick local instead of sending it to a machine', async () => {
  const cm = await machinesFor({ assign: [{ service: 'chatSmart', port: 8080, model: REMOTE_MODEL }] });
  assert.equal(await cm.manualTarget(REMOTE_MODEL, async () => { throw new Error('synthetic catalogue failure'); }), null);
  assert.equal(await cm.manualTarget(REMOTE_MODEL, () => { throw new Error('synthetic'); }), null);
  assert.equal((await cm.manualTarget(REMOTE_MODEL, async () => [{ name: 'synthetic-other' }]))?.model, REMOTE_MODEL, 'a readable catalogue without the name still routes to the machine');
});

test('#1855 classifier: a message the rules send to Smart stays Smart when Fast\'s machine is down; an undecided one goes to Fast', async () => {
  const cm = await machinesFor({ assign: [{ service: 'chatFast', port: await closedPort(), model: REMOTE_MODEL }] });
  const calls = [], admitted = [], records = [];
  const r = router({ machine: cm, calls, admitted, records });
  assert.equal(await r.classify('QA-SYNTH-1855 please debug this function'), 'smart');
  assert.equal(await r.classify('QA-SYNTH-1855 ' + 'long '.repeat(130)), 'smart');
  assert.deepEqual([calls.length, records.length], [0, 0], 'the rules decided: no machine call, nothing recorded as skipped');
  assert.equal(await r.classify('QA-SYNTH-1855 hi there'), 'fast');
  assert.deepEqual(records, [{ selected: 'fast', fellBack: 'classifier-skipped', cause: 'machine-unreachable' }]);
});
