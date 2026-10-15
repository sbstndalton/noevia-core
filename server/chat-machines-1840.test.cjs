'use strict';
// sbstndalton/noevia#1840: chat roles (Fast, Smart, Code, Creative) and Vision on an Inference machine. The turn for a
// role on a machine goes to that machine's OpenAI-compatible server (a fake llama-server on loopback here): streamed,
// same request shape, tool calls through, no local key, no redirects, LAN/Tailscale only (checked at connect time,
// link-local refused), nothing loaded or unloaded on this machine, and a clear error when the machine is not
// answering. Nothing assigned: the request is byte-identical to before. Synthetic models and prompts only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const reasoningEffort = require('./reasoning-effort.cjs');
const { createInferenceMachines, normalizeAddress } = require('./inference-machines.cjs');
const { createChatMachines, modelIds } = require('./chat-machines.cjs');
const { createMachineHealth } = require('./machine-health.cjs');
const { createServiceFetch } = require('./service-endpoint.cjs');
const { createInferenceMachineRoutes } = require('./routes/inference-machines.cjs');
const { createModelService } = require('./models.cjs');

const LOCAL_KEY = 'synthetic-local-key-1840';
const REMOTE_MODEL = 'synthetic-remote-fast';
const ROLES = { fast: 'synthetic-fast', smart: 'synthetic-smart' };
const catalogue = [{ name: 'synthetic-fast' }, { name: 'synthetic-smart' }, { name: 'synthetic-creative' }];

function memoryStore() { const map = new Map(); return { get: (k) => map.get(k), set: (k, v) => map.set(k, v) }; }

/** A fake llama-server: /health, /v1/models, /props, and a streaming /v1/chat/completions. */
async function fakeServer(t, { toolCall = false, redirect = false, models = [REMOTE_MODEL, 'synthetic-remote-creative'], nCtx = 16384 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"ok"}'); }
      if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) })); }
      if (req.url.startsWith('/props')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ default_generation_settings: { n_ctx: nCtx } })); }
      if (req.url === '/v1/chat/completions') {
        if (redirect) { res.writeHead(302, { Location: 'http://93.184.216.34/v1/chat/completions' }); return res.end(); }
        const body = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        const answeredTool = body.messages.some((m) => m.role === 'tool');
        if (toolCall && !answeredTool) {
          chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_synth_1', type: 'function', function: { name: 'synthetic_lookup', arguments: '' } }] } }] });
          chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"kettle"}' } }] } }] });
          chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        } else {
          chunk({ choices: [{ delta: { content: 'Remote ' } }] });
          chunk({ choices: [{ delta: { content: answeredTool ? 'used the tool.' : 'hello.' } }] });
          chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        }
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

async function machinesWith({ assign = [], address = '127.0.0.1', lookup } = {}) {
  const machines = createInferenceMachines({ store: memoryStore(), log: () => {}, ...(lookup ? { lookup } : {}) });
  const { machine } = await machines.add({ name: 'Synthetic Pi', address }, 'admin');
  for (const a of assign) machines.assign({ ...a, machine: machine.id }, 'admin');
  return { machines, machine };
}

/** One chat turn through the real handler, with a recording local engine. */
async function turn(t, { chatMachines = null, route = 'fast', roles = ROLES, rows = catalogue, message = 'QA-SYNTH-1840 Say hello.', tools = false, project = { routing: 'auto' } } = {}) {
  const saved = { kind: process.env.MODEL_MANAGER_KIND, base: process.env.INFERENCE_BASE_URL };
  process.env.MODEL_MANAGER_KIND = 'llamacpp'; process.env.INFERENCE_BASE_URL = 'http://default.invalid';
  t.after(() => { for (const [k, v] of [['MODEL_MANAGER_KIND', saved.kind], ['INFERENCE_BASE_URL', saved.base]]) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1840-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], localRequests = [], engine = { makeRoomFor: [], health: 0, props: 0 };
  let replied = null;
  const res = new EventEmitter(); res.writeHead = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  res.write = (chunk) => { for (const line of String(chunk).split('\n')) if (line.startsWith('data:')) { try { events.push(JSON.parse(line.slice(5))); } catch { /* not json */ } } };
  // The local engine: records every request so a turn on a machine can be shown to send nothing here.
  const fetch = async (url, init) => {
    localRequests.push({ url: String(url), headers: init?.headers, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Local hello.' } }] })}\n\n`); })() };
  };
  const toolDefs = tools ? [{ type: 'function', function: { name: 'synthetic_lookup', description: 'Synthetic lookup.', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }] : [];
  const executed = [];
  const { handleChat } = createChatHandler({
    chatMachines,
    modelManager: { enabled: true, makeRoomFor: async (m) => { engine.makeRoomFor.push(m); },
      health: async () => { engine.health++; return { ok: true, body: { all_models_loaded: catalogue.map((m) => ({ model_name: m.name, loaded: true, recipe_options: { ctx_size: 32768 } })) } }; } },
    reasoningEffort, crypto: require('node:crypto'), path, fs, fetch,
    authService: { audit() {}, db: { prepare: () => ({ get: () => undefined }) } },
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', assets: [], ...project }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', label: 'Local', baseUrl: 'http://default.invalid', apiKey: LOCAL_KEY }),
    providerHeaders: (p) => ({ 'Content-Type': 'application/json', ...(p.apiKey && p.apiKey !== 'local' ? { Authorization: `Bearer ${p.apiKey}` } : {}) }),
    autoRoles: () => roles,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) }, resolveTools: () => ({ tools: toolDefs, dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (r) => ({ text: String(r) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: (_res, status, body) => { replied = { status, body }; }, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => route, servedCatalogue: async () => rows, modelsInstalled: async () => rows,
    missingRoles: require('./auto-roles-check.cjs').missingRoles, staleRolesError: require('./auto-roles-check.cjs').staleRolesError,
    allToolboxes: () => [{ id: 'core', tools: toolDefs }], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async (...args) => { executed.push(args); return 'synthetic result'; }, awaitApproval: async () => 'approve',
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message });
  return { events, localRequests, engine, replied, executed, meta: events.find((e) => e.type === 'meta' && e.model), errors: events.filter((e) => e.type === 'error') };
}

test('#1840 registry: a chat role moves with a port and the model the machine serves, and back', async () => {
  const { machines, machine } = await machinesWith();
  assert.equal(machines.chatTarget('fast'), null);
  machines.assign({ service: 'chatFast', machine: machine.id, port: 8080, model: REMOTE_MODEL }, 'admin');
  assert.deepEqual(machines.chatTarget('fast'), { role: 'fast', service: 'chatFast', machine: { id: machine.id, name: 'Synthetic Pi', address: 'http://127.0.0.1' }, port: 8080, model: REMOTE_MODEL, baseUrl: 'http://127.0.0.1:8080' });
  assert.deepEqual(machines.view().services.find((s) => s.id === 'chatFast'), { id: 'chatFast', mode: 'chat', machine: machine.id, port: 8080, model: REMOTE_MODEL });
  assert.equal(machines.urlFor('chatFast'), null, 'urlFor stays for runtime services');
  assert.throws(() => machines.assign({ service: 'chatSmart', machine: machine.id, port: 8080, model: 'bad\u0000name' }, 'admin'), (e) => e.code === 'invalidModel');
  assert.throws(() => machines.remove({ id: machine.id }, 'admin'), (e) => e.code === 'inUse');
  machines.assign({ service: 'chatFast', machine: 'local' }, 'admin');
  assert.equal(machines.chatTarget('fast'), null);
});

test('#1840 a public machine address is refused when saved (no override)', () => {
  assert.throws(() => normalizeAddress('93.184.216.34'), (e) => e.code === 'publicAddress');
  assert.throws(() => normalizeAddress('169.254.10.10'), (e) => e.code === 'publicAddress', 'link-local is refused too');
});

test('#1840 a Fast turn on a machine streams its reply from that machine, same request shape, no local key, nothing loaded here', async (t) => {
  const fake = await fakeServer(t, { nCtx: 16384 });
  const { machines } = await machinesWith({ assign: [{ service: 'chatFast', port: fake.port, model: REMOTE_MODEL }] });
  const chatMachines = createChatMachines({ machines, health: createMachineHealth() });
  const out = await turn(t, { chatMachines });
  assert.deepEqual(out.errors, []);
  assert.equal(out.localRequests.filter((r) => r.url.includes('/chat/completions')).length, 0, 'nothing sent to the local engine');
  const [chat] = fake.chats();
  assert.ok(chat, 'the machine got the request');
  assert.equal(chat.body.model, REMOTE_MODEL);
  assert.equal(chat.body.stream, true);
  assert.ok(Array.isArray(chat.body.messages) && chat.body.messages.at(-1).role === 'user');
  assert.match(JSON.stringify(chat.body.messages.at(-1).content), /QA-SYNTH-1840 Say hello/);
  assert.equal(chat.headers.authorization, undefined, 'the local API key never leaves for another host');
  assert.equal(JSON.stringify(chat.headers).includes(LOCAL_KEY), false);
  assert.equal(out.meta.model, REMOTE_MODEL);
  assert.equal(out.meta.route, 'fast');
  assert.match(JSON.stringify(out.events), /Remote /);
  assert.match(JSON.stringify(out.events), /hello\./);
  // Budget and residency: no load, unload or local context read for a role on a machine.
  assert.deepEqual(out.engine.makeRoomFor, []);
  assert.equal(out.engine.health, 0);
  const ctx = out.events.find((e) => e.type === 'context');
  assert.equal(ctx.limit, 16384, 'the context comes from the machine\'s /props, not this machine\'s engine');
  assert.ok(fake.seen.some((s) => s.url === `/props?model=${REMOTE_MODEL}`));
  assert.ok(fake.seen.some((s) => s.url === '/health'), 'the shared health probe ran');
});

test('#1840 tool calls pass through the machine and the tool result goes back to it', async (t) => {
  const fake = await fakeServer(t, { toolCall: true });
  const { machines } = await machinesWith({ assign: [{ service: 'chatFast', port: fake.port, model: REMOTE_MODEL }] });
  const out = await turn(t, { chatMachines: createChatMachines({ machines, health: createMachineHealth() }), tools: true, message: 'QA-SYNTH-1840 Look up the kettle.' });
  assert.deepEqual(out.errors, []);
  const chats = fake.chats();
  assert.ok(chats.length >= 2, `two rounds on the machine (got ${chats.length})`);
  assert.equal(chats[0].body.tools?.[0]?.function?.name, 'synthetic_lookup', 'the tools were offered to the machine');
  const second = chats[1].body.messages;
  assert.ok(second.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.function?.name === 'synthetic_lookup'));
  assert.ok(second.some((m) => m.role === 'tool' && m.tool_call_id === 'call_synth_1'));
  assert.equal(out.executed.length, 1);
  assert.equal(out.localRequests.filter((r) => r.url.includes('/chat/completions')).length, 0);
  assert.match(JSON.stringify(out.events), /used the tool/);
});

test('#1840 an unreachable machine fails the turn clearly; it never falls back to a local model', async (t) => {
  const closed = http.createServer(); await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port; await new Promise((r) => closed.close(r));
  const { machines } = await machinesWith({ assign: [{ service: 'chatFast', port, model: REMOTE_MODEL }] });
  const out = await turn(t, { chatMachines: createChatMachines({ machines, health: createMachineHealth() }) });
  assert.equal(out.replied?.status, 503);
  assert.equal(out.replied.body.code, 'machineUnreachable');
  assert.match(out.replied.body.error, /^Fast model’s machine \(Synthetic Pi\) is unreachable/);
  assert.equal(out.localRequests.length, 0, 'no fallback to the local engine');
  assert.deepEqual(out.engine.makeRoomFor, []);
});

test('#1840 a machine whose name now resolves to a public or link-local address is refused at connect time', async (t) => {
  const fake = await fakeServer(t);
  // A machine saved by name (private when saved). The name is `localhost` only so the hermetic guard lets the socket
  // start; the connect-time lookup (stubbed DNS) then answers a public, or a link-local, address.
  const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
  for (const answer of ['93.184.216.34', '169.254.20.20']) {
    const { machines } = await machinesWith({ address: 'localhost', lookup, assign: [{ service: 'chatFast', port: fake.port, model: REMOTE_MODEL }] });
    const fetchImpl = createServiceFetch({ resolve: (host, opts, cb) => cb(null, [{ address: answer, family: 4 }]) });
    const chatMachines = createChatMachines({ machines, health: createMachineHealth({ fetchImpl }), fetchImpl });
    const out = await turn(t, { chatMachines });
    assert.equal(out.replied?.status, 503, answer);
    assert.match(out.replied.body.error, /Fast model’s machine \(Synthetic Pi\) is unreachable: its address is not on this network/);
    assert.equal(out.localRequests.length, 0);
    await assert.rejects(chatMachines.listModels(machines.view().machines[1].id, fake.port), (e) => e.code === 'publicAddress');
  }
  assert.equal(fake.seen.length, 0, 'nothing reached any server');
});

test('#1840 a redirect from the machine is refused, not followed', async (t) => {
  const fake = await fakeServer(t, { redirect: true });
  const { machines } = await machinesWith({ assign: [{ service: 'chatFast', port: fake.port, model: REMOTE_MODEL }] });
  const out = await turn(t, { chatMachines: createChatMachines({ machines, health: createMachineHealth() }) });
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].code, 'machineUnreachable');
  assert.match(out.errors[0].text, /redirect, which is never followed/);
  assert.equal(fake.chats().length, 1);
});

test('#1840 default path: with nothing assigned the request is byte-identical to a handler without machines', async (t) => {
  const { machines } = await machinesWith();
  const before = await turn(t, { chatMachines: null });
  const after = await turn(t, { chatMachines: createChatMachines({ machines, health: createMachineHealth() }) });
  const chat = (o) => o.localRequests.filter((r) => r.url.includes('/chat/completions'));
  assert.equal(chat(before).length, 1);
  assert.equal(JSON.stringify(chat(after)), JSON.stringify(chat(before)));
  assert.deepEqual(after.engine, before.engine);
  assert.equal(chat(after)[0].headers.Authorization, `Bearer ${LOCAL_KEY}`, 'the local engine keeps its key');
});

test('#1840 a role on this machine is unaffected while another role is on a machine', async (t) => {
  const fake = await fakeServer(t);
  const { machines } = await machinesWith({ assign: [{ service: 'chatFast', port: fake.port, model: REMOTE_MODEL }] });
  const out = await turn(t, { chatMachines: createChatMachines({ machines, health: createMachineHealth() }), route: 'smart', message: 'QA-SYNTH-1840 Explain step by step why the synthetic sky is blue in detail.' });
  assert.deepEqual(out.errors, []);
  assert.equal(fake.chats().length, 0);
  assert.equal(out.localRequests.filter((r) => r.url.includes('/chat/completions'))[0].body.model, 'synthetic-smart');
  assert.deepEqual(out.engine.makeRoomFor, ['synthetic-smart'], 'the local role is admitted as before');
});

test('#1840 a local Fast model that is gone does not fail a turn while Fast runs on a machine', async (t) => {
  const fake = await fakeServer(t);
  const { machines } = await machinesWith({ assign: [{ service: 'chatFast', port: fake.port, model: REMOTE_MODEL }] });
  const rows = catalogue.filter((m) => m.name !== 'synthetic-fast');
  const out = await turn(t, { chatMachines: createChatMachines({ machines, health: createMachineHealth() }), rows });
  assert.equal(out.replied, null);
  assert.equal(fake.chats().length, 1);
});

const CREATIVE = 'QA-SYNTH-1840 Write a short poem about a synthetic kettle.';
test('#1816/#1840 Creative on a machine: the move costs no local swap, so it happens even with Smart loaded here', async (t) => {
  const fake = await fakeServer(t);
  const { machines } = await machinesWith({ assign: [{ service: 'chatCreative', port: fake.port, model: 'synthetic-remote-creative' }] });
  const rows = catalogue.map((m) => ({ ...m, loaded: m.name === 'synthetic-smart' }));
  const out = await turn(t, { chatMachines: createChatMachines({ machines, health: createMachineHealth() }), route: 'smart', message: CREATIVE, rows });
  assert.equal(out.meta.route, 'creative');
  assert.equal(fake.chats()[0].body.model, 'synthetic-remote-creative');
  assert.deepEqual(out.engine.makeRoomFor, []);
});

test('#1816/#1840 Creative on an unreachable machine is optional: the router pick stands, locally', async (t) => {
  const closed = http.createServer(); await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port; await new Promise((r) => closed.close(r));
  const { machines } = await machinesWith({ assign: [{ service: 'chatCreative', port, model: 'synthetic-remote-creative' }] });
  const out = await turn(t, { chatMachines: createChatMachines({ machines, health: createMachineHealth() }), route: 'smart', message: CREATIVE });
  assert.equal(out.replied, null);
  assert.equal(out.meta.route, 'smart');
  assert.equal(out.localRequests.filter((r) => r.url.includes('/chat/completions'))[0].body.model, 'synthetic-smart');
});

test('#1816/#1840 a local Creative with Fast on a machine moves only when it costs no local swap', async (t) => {
  const fake = await fakeServer(t);
  const { machines } = await machinesWith({ assign: [{ service: 'chatFast', port: fake.port, model: REMOTE_MODEL }] });
  const roles = { ...ROLES, creative: 'synthetic-creative' };
  const cm = createChatMachines({ machines, health: createMachineHealth() });
  const busy = await turn(t, { chatMachines: cm, roles, route: 'fast', message: CREATIVE, rows: catalogue.map((m) => ({ ...m, loaded: m.name === 'synthetic-smart' })) });
  assert.equal(busy.meta.route, 'fast', 'Smart is loaded here: loading Creative would swap, so Fast (remote) answers');
  assert.equal(fake.chats().length, 1);
  const idle = await turn(t, { chatMachines: cm, roles, route: 'fast', message: CREATIVE, rows: catalogue.map((m) => ({ ...m, loaded: false })) });
  assert.equal(idle.meta.route, 'creative');
  assert.deepEqual(idle.engine.makeRoomFor, ['synthetic-creative']);
});

test('#1840 ensureRolesLoaded never warms a role that runs on a machine; a local role still warms', async () => {
  const loads = [];
  const svc = createModelService({ fetchJson: async () => ({ ok: true, body: {} }), env: {}, currentWorkspace: () => ({ autoRoles: { fast: 'synthetic-fast', smart: 'synthetic-smart' } }),
    modelManager: { enabled: true, capabilities: {}, requireEnabled() {}, load: async (n) => { loads.push(n); return { ok: true }; },
      listModels: async () => ({ ok: true, body: { data: catalogue.map((m) => ({ id: m.name })) } }), health: async () => ({ ok: true, body: { all_models_loaded: [] } }) },
    roleOnMachine: (role) => role === 'fast' });
  svc.ensureRolesLoaded();
  for (let i = 0; i < 50 && !loads.includes('synthetic-smart'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(loads, ['synthetic-smart']);
});

test('#1840 modelIds reads llama-server and older /v1/models shapes, bounded', () => {
  assert.deepEqual(modelIds({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }), ['a', 'b']);
  assert.deepEqual(modelIds({ models: [{ name: 'c' }, { model: 'd' }, 'e', { id: 'bad\u0001' }] }), ['c', 'd', 'e']);
  assert.deepEqual(modelIds(null), []);
});

test('#1840 route: lists a machine\'s models, assigns only a served model, administrators only', async (t) => {
  const fake = await fakeServer(t);
  const { machines, machine } = await machinesWith();
  const chatMachines = createChatMachines({ machines, health: createMachineHealth() });
  const route = createInferenceMachineRoutes({ json: (res, status, body) => { res.out = { status, body }; return true; }, readJson: async (req) => req.body, machines, health: createMachineHealth(), chatMachines });
  const call = async (method, { body, query = '', role = 'admin' } = {}) => {
    const res = { setHeader() {} };
    await route({ method, body }, res, { path: '/api/models/machines', authn: { user: { id: 'u', role } }, url: new URL(`http://x/api/models/machines${query}`) });
    return res.out;
  };
  const listed = await call('GET', { query: `?models=${machine.id}&port=${fake.port}` });
  assert.deepEqual(listed, { status: 200, body: { models: [REMOTE_MODEL, 'synthetic-remote-creative'] } });
  const bad = await call('POST', { body: { action: 'assign', service: 'chatFast', machine: machine.id, port: fake.port, model: 'not-served' } });
  assert.equal(bad.status, 400); assert.equal(bad.body.code, 'unknownModel'); assert.deepEqual(bad.body.models, [REMOTE_MODEL, 'synthetic-remote-creative']);
  const ok = await call('POST', { body: { action: 'assign', service: 'chatFast', machine: machine.id, port: fake.port, model: REMOTE_MODEL } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.services.find((s) => s.id === 'chatFast').url, `http://127.0.0.1:${fake.port}`);
  const withHealth = await call('GET', { query: '?health=1' });
  assert.equal(withHealth.body.health.services.chatFast.state, 'up');
  assert.equal(withHealth.body.health.machines[machine.id], 'up');
  assert.equal((await call('GET', { query: `?models=${machine.id}&port=${fake.port}`, role: 'member' })).status, 403);
  assert.equal((await call('POST', { role: 'member', body: { action: 'assign', service: 'chatFast', machine: 'local' } })).status, 403);
});

// sbstndalton/noevia#1851: the served model is checked on each turn (through the health cache), /props is cached with
// it, and an address change re-checks the model.
test('#1851 the machine now serves another model: the turn fails with machineWrongModel and no request is sent', async (t) => {
  const served = [REMOTE_MODEL];
  const fake = await fakeServer(t, { models: served });
  const { machines } = await machinesWith({ assign: [{ service: 'chatFast', port: fake.port, model: REMOTE_MODEL }] });
  let now = 0;
  const cm = createChatMachines({ machines, health: createMachineHealth({ now: () => now }) });
  const ok = await turn(t, { chatMachines: cm });
  assert.equal(ok.errors.length, 0);
  assert.equal(fake.chats().length, 1);
  served[0] = 'synthetic-other-gguf'; // llama-server restarted with a different GGUF
  now += 31000; // the cached answer has expired
  const bad = await turn(t, { chatMachines: cm });
  assert.equal(bad.replied?.status, 503);
  assert.equal(bad.replied.body.code, 'machineWrongModel');
  assert.match(bad.replied.body.error, /^The Fast machine \(Synthetic Pi\) serves synthetic-other-gguf, not synthetic-remote-fast\./);
  assert.equal(fake.chats().length, 1, 'the second turn was never sent');
  assert.equal(bad.localRequests.length, 0);
});

test('#1851 inside the TTL there is one /v1/models and one /props for many turns; after it, one more', async (t) => {
  const fake = await fakeServer(t);
  const { machines } = await machinesWith({ assign: [{ service: 'chatFast', port: fake.port, model: REMOTE_MODEL }] });
  let now = 0;
  const cm = createChatMachines({ machines, health: createMachineHealth({ now: () => now }) });
  const count = (prefix) => fake.seen.filter((s) => s.url.startsWith(prefix)).length;
  for (let i = 0; i < 3; i++) await turn(t, { chatMachines: cm });
  assert.equal(count('/v1/models'), 1);
  assert.equal(count('/props'), 1);
  assert.equal(count('/health'), 1);
  assert.equal(fake.chats().length, 3);
  now += 31000;
  await turn(t, { chatMachines: cm });
  assert.equal(count('/v1/models'), 2);
  assert.equal(count('/props'), 2);
});

test('#1851 /props: the last known context is kept when a later read fails; 8192 only when nothing was ever known', async (t) => {
  const { machines, machine } = await machinesWith({});
  let now = 0, propsUp = true, n = 0;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/health') return new Response('{}', { status: 200 });
    if (u.pathname === '/v1/models') return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
    if (!propsUp) return new Response('no', { status: 500 });
    n++;
    return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 32768 } }), { status: 200 });
  };
  const target = (port) => ({ role: 'fast', machine: { id: machine.id, name: 'Synthetic Pi', address: machine.address }, port, model: 'm1', baseUrl: `${machine.address}:${port}` });
  const cm = createChatMachines({ machines, fetchImpl, health: createMachineHealth({ now: () => now }) });
  assert.equal(await cm.contextTokens(target(9001)), 32768);
  assert.equal(await cm.contextTokens(target(9001)), 32768);
  assert.equal(n, 1, 'cached with the health result');
  propsUp = false; now += 31000;
  assert.equal(await cm.contextTokens(target(9001)), 32768, 'last known value reused');
  assert.equal(await cm.contextTokens(target(9002)), 8192, 'never known: the floor');
});

test('#1851 changing a machine address marks a chat assignment whose model the new address does not serve', async () => {
  const lookups = { 'http://10.0.0.5': ['other-model'], 'http://10.0.0.6': ['synthetic-remote-fast', 'x'] };
  const machines = createInferenceMachines({ store: memoryStore(), log: () => {}, modelsAt: async (address) => lookups[address] });
  const { machine } = await machines.add({ name: 'Synthetic Pi', address: '10.0.0.4' }, 'admin');
  machines.assign({ service: 'chatFast', machine: machine.id, port: 8080, model: REMOTE_MODEL }, 'admin');
  machines.assign({ service: 'chatSmart', machine: machine.id, port: 8081, model: REMOTE_MODEL }, 'admin');
  await machines.update({ id: machine.id, address: '10.0.0.5' }, 'admin');
  assert.equal(machines.chatTarget('fast').needsConfirm, true);
  assert.equal(machines.view().services.find((s) => s.id === 'chatFast').needsConfirm, true);
  // A rename does not re-check; a move to a server that serves it clears the mark; assigning again clears it too.
  await machines.update({ id: machine.id, name: 'Renamed Pi' }, 'admin');
  assert.equal(machines.chatTarget('fast').needsConfirm, true);
  await machines.update({ id: machine.id, address: '10.0.0.6' }, 'admin');
  assert.equal(machines.chatTarget('fast').needsConfirm, undefined);
  await machines.update({ id: machine.id, address: '10.0.0.5' }, 'admin');
  assert.equal(machines.chatTarget('smart').needsConfirm, true);
  machines.assign({ service: 'chatSmart', machine: machine.id, port: 8081, model: 'other-model' }, 'admin');
  assert.equal(machines.chatTarget('smart').needsConfirm, undefined);
});

test('#1851 an address change to a machine that is not answering marks nothing (the turn check says it is unreachable)', async () => {
  const machines = createInferenceMachines({ store: memoryStore(), log: () => {}, modelsAt: async () => { throw Error('down'); } });
  const { machine } = await machines.add({ name: 'Synthetic Pi', address: '10.0.0.4' }, 'admin');
  machines.assign({ service: 'chatFast', machine: machine.id, port: 8080, model: REMOTE_MODEL }, 'admin');
  await machines.update({ id: machine.id, address: '10.0.0.5' }, 'admin');
  assert.equal(machines.chatTarget('fast').needsConfirm, undefined);
});
