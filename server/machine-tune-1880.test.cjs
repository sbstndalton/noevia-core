'use strict';
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}
// sbstndalton/noevia#1880: an administrator-started measurement of a chat role's model on an Inference machine.
// Driven against a fake llama-server on loopback with controllable latency. Synthetic models and prompts only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { EventEmitter } = require('node:events');
const { createInferenceMachines } = require('./inference-machines.cjs');
const { createChatMachines } = require('./chat-machines.cjs');
const { createMachineHealth } = require('./machine-health.cjs');
const { createMachineTune, recommend, STORE_KEY } = require('./machine-tune.cjs');
const { createInferenceMachineRoutes } = require('./routes/inference-machines.cjs');

const MODEL = 'synthetic-remote-1880';
const LOCAL_KEY = 'synthetic-local-key-1880';

function memoryStore() { const map = new Map(); return { map, get: (k) => map.get(k), set: (k, v) => map.set(k, v), delete: (k) => map.delete(k) }; }

/**
 * A fake llama-server. `latencyMs` delays every /v1/chat/completions answer (a function of the request body or a
 * number); `timings` adds llama-server timings; `draft` reports drafted/accepted tokens; `stream` answers stream turns.
 */
async function fakeServer(t, { latencyMs = 0, timings = true, draft = null, nCtx = 8192, status = 200 } = {}) {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const reply = (code, b) => { if (!res.writableEnded) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); } };
      if (req.url === '/health') return reply(200, { status: 'ok' });
      if (req.url === '/v1/models') return reply(200, { object: 'list', data: [{ id: MODEL, object: 'model' }] });
      if (req.url.startsWith('/props')) return reply(200, { default_generation_settings: { n_ctx: nCtx }, chat_template: '{{ messages }}' });
      if (req.url === '/v1/chat/completions') {
        const wait = typeof latencyMs === 'function' ? latencyMs(body) : latencyMs;
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          return setTimeout(() => {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Remote hello.' } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n'); res.end();
          }, wait);
        }
        return setTimeout(() => {
          if (status !== 200) return reply(status, { error: 'synthetic' });
          const prompt = JSON.stringify(body.messages).length / 6;
          reply(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: Math.round(prompt), completion_tokens: body.max_tokens },
            ...(timings ? { timings: { prompt_n: Math.round(prompt), prompt_per_second: 400, predicted_n: body.max_tokens, predicted_per_second: 25, ...(draft ? { draft_n: draft[0], draft_n_accepted: draft[1] } : {}) } } : {}) });
        }, wait);
      }
      res.writeHead(404); res.end();
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }));
  return { port: server.address().port, seen, chats: () => seen.filter((s) => s.url === '/v1/chat/completions') };
}

async function setup(t, serverOpts = {}, { assign = true, tuneOpts = {} } = {}) {
  const fake = await fakeServer(t, serverOpts);
  const store = memoryStore();
  const machines = createInferenceMachines({ store, log: () => {} });
  const { machine } = await machines.add({ name: 'Synthetic Pi', address: '127.0.0.1' }, 'admin');
  if (assign) machines.assign({ service: 'chatFast', machine: machine.id, port: fake.port, model: MODEL }, 'admin');
  const health = createMachineHealth();
  const chatMachines = createChatMachines({ machines, health });
  const audits = [];
  const tune = createMachineTune({ machines, chatMachines, store, audit: (a, actor, d) => audits.push({ a, actor, d }), log: () => {}, ...tuneOpts });
  const routes = createInferenceMachineRoutes({ json: (res, status, body) => { res.out = { status, body }; return true; }, readJson: async (req) => req.body,
    machines, health, chatMachines, machineTune: tune });
  const call = async (method, query, body, role = 'admin') => {
    const res = { setHeader() {} };
    const url = new URL(`http://app.invalid/api/models/machines${query || ''}`);
    await routes({ method, body }, res, { path: url.pathname, authn: { user: { id: `synthetic-${role}`, role } }, url });
    return res.out;
  };
  return { fake, store, machines, machineId: machine.id, chatMachines, tune, call, audits };
}

const waitFor = async (pred, ms = 10000) => { const until = Date.now() + ms; while (!pred()) { if (Date.now() > until) throw Error('deadline passed'); await new Promise((r) => setTimeout(r, 5)); } };

test('#1880 admin starts a measurement: fixed synthetic steps, results kept per machine + model, shown on the measured line', async (t) => {
  const s = await setup(t, { draft: [100, 80] });
  const started = await s.call('POST', '', { action: 'tune', service: 'chatFast', confirm: true });
  assert.equal(started.status, 202);
  assert.equal(started.body.tune.state, 'running');
  assert.equal(started.body.tune.model, MODEL);
  const done = await s.tune.settled();
  assert.equal(done.state, 'done', JSON.stringify(done));
  const chats = s.fake.chats();
  // 3 decode workloads, then prefill at 1024 and 4096 (16384 is above 3/4 of the 8192 context).
  assert.equal(chats.length, 5);
  for (const c of chats) {
    assert.equal(c.body.model, MODEL);
    assert.equal(c.body.stream, false);
    assert.equal(c.body.cache_prompt, false);
    assert.equal(c.headers.authorization, undefined, 'no key goes to the machine');
    assert.ok(c.body.max_tokens <= 200);
  }
  assert.deepEqual(chats.slice(3).map((c) => c.body.max_tokens), [1, 1]);
  const r = s.tune.resultFor(s.machineId, MODEL);
  assert.equal(r.contextTokens, 8192);
  assert.equal(r.decode.tokensPerSecond, 25);
  assert.deepEqual(r.prefill.map((p) => p.tokensPerSecond), [400, 400]);
  assert.deepEqual(r.speculative, { measured: true, drafted: 300, accepted: 240, acceptance: 0.8 });
  assert.deepEqual(r.recommendations, [], 'fills in 20 s and accepts 80%: nothing to change');
  // Persisted under the machine + served model, as text in the settings store.
  const stored = JSON.parse(s.store.map.get(STORE_KEY));
  assert.equal(stored.results.length, 1);
  assert.equal(stored.results[0].machineId, s.machineId);
  assert.equal(stored.results[0].model, MODEL);
  // The measured line carries it, and no longer names auto-tune or speculative decoding as not measured.
  const view = await s.call('GET', '?health=1');
  const m = view.body.health.measured.chatFast;
  assert.equal(m.tune.decode.tokensPerSecond, 25);
  assert.deepEqual(m.notMeasured, ['longContextProfile', 'presets']);
  assert.deepEqual(s.audits.map((a) => a.a), ['machines.tune.start']);
  assert.equal((await s.call('GET', '?tune=1')).body.tune.state, 'done');
});

test('#1880 a second model on the same machine, or the same model on another machine, keeps its own result', async (t) => {
  const s = await setup(t);
  await s.call('POST', '', { action: 'tune', service: 'chatFast', confirm: true });
  await s.tune.settled();
  assert.ok(s.tune.resultFor(s.machineId, MODEL));
  assert.equal(s.tune.resultFor(s.machineId, 'synthetic-other'), null);
  assert.equal(s.tune.resultFor('another-machine', MODEL), null);
  // A removed machine's result is not shown.
  s.machines.assign({ service: 'chatFast', machine: 'local' }, 'admin');
  s.machines.remove({ id: s.machineId }, 'admin');
  assert.equal(s.tune.resultFor(s.machineId, MODEL), null);
});

test('#1880 administrators only, and only with confirm: true', async (t) => {
  const s = await setup(t);
  assert.equal((await s.call('POST', '', { action: 'tune', service: 'chatFast', confirm: true }, 'user')).status, 403);
  assert.equal((await s.call('GET', '?tune=1', undefined, 'user')).status, 403);
  assert.equal((await s.call('POST', '', { action: 'tuneAbort' }, 'user')).status, 403);
  const noConfirm = await s.call('POST', '', { action: 'tune', service: 'chatFast' });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.code, 'confirmRequired');
  assert.equal(s.fake.chats().length, 0, 'nothing was sent');
  assert.equal((await s.call('POST', '', { action: 'tune', service: 'decision', confirm: true })).body.code, 'invalidService');
});

test('#1880 a role on this machine is never measured here (nothing local runs)', async (t) => {
  const s = await setup(t, {}, { assign: false });
  const out = await s.call('POST', '', { action: 'tune', service: 'chatFast', confirm: true });
  assert.equal(out.status, 404);
  assert.equal(out.body.code, 'notOnMachine');
});

test('#1880 abort stops the request in flight; nothing is saved', async (t) => {
  const s = await setup(t, { latencyMs: 5000 });
  await s.call('POST', '', { action: 'tune', service: 'chatFast', confirm: true });
  await waitFor(() => s.fake.chats().length === 1);
  const t0 = Date.now();
  const out = await s.call('POST', '', { action: 'tuneAbort' });
  assert.equal(out.status, 200);
  assert.equal(out.body.tune.state, 'aborted');
  const done = await s.tune.settled();
  assert.equal(done.state, 'aborted');
  assert.ok(Date.now() - t0 < 2000, 'the slow request was not waited for');
  assert.equal(s.fake.chats().length, 1, 'no further step ran');
  assert.equal(s.tune.resultFor(s.machineId, MODEL), null);
  assert.ok(s.audits.some((a) => a.a === 'machines.tune.abort'));
});

test('#1880 a step that passes its time cap fails the run (stepTimeout)', async (t) => {
  const s = await setup(t, { latencyMs: 2000 }, { tuneOpts: { stepTimeoutMs: 150 } });
  await s.call('POST', '', { action: 'tune', service: 'chatFast', confirm: true });
  const done = await s.tune.settled();
  assert.equal(done.state, 'failed');
  assert.equal(done.code, 'stepTimeout');
  assert.equal(s.tune.resultFor(s.machineId, MODEL), null);
});

test('#1880 the whole run has a time cap too (runTimeout)', async (t) => {
  const s = await setup(t, { latencyMs: 80 }, { tuneOpts: { runTimeoutMs: 120 } });
  await s.call('POST', '', { action: 'tune', service: 'chatFast', confirm: true });
  const done = await s.tune.settled();
  assert.equal(done.state, 'failed');
  assert.equal(done.code, 'runTimeout');
});

test('#1880 refuses while that machine serves a chat turn, and one run at a time', async (t) => {
  const s = await setup(t, { latencyMs: 300 });
  const release = s.chatMachines.beginTurn(s.machineId);
  const busy = await s.call('POST', '', { action: 'tune', service: 'chatFast', confirm: true });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, 'machineBusy');
  release();
  release(); // idempotent
  assert.equal(s.chatMachines.busy(s.machineId), false);
  assert.equal((await s.call('POST', '', { action: 'tune', service: 'chatFast', confirm: true })).status, 202);
  const again = await s.call('POST', '', { action: 'tune', service: 'chatFast', confirm: true });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'tuneRunning');
  s.tune.abort('synthetic-admin');
  await s.tune.settled();
});

test('#1880 a chat turn that starts on the machine interrupts the measurement at once', async (t) => {
  const s = await setup(t, { latencyMs: 3000 });
  await s.call('POST', '', { action: 'tune', service: 'chatFast', confirm: true });
  await waitFor(() => s.fake.chats().length === 1);
  const release = s.chatMachines.beginTurn(s.machineId);
  const done = await s.tune.settled();
  release();
  assert.equal(done.state, 'interrupted');
  assert.equal(done.code, 'chatTurn');
  assert.equal(s.fake.chats().length, 1);
});

test('#1880 a turn on another machine does not interrupt it', async (t) => {
  const s = await setup(t, { latencyMs: 20 });
  await s.call('POST', '', { action: 'tune', service: 'chatFast', confirm: true });
  const release = s.chatMachines.beginTurn('some-other-machine');
  const done = await s.tune.settled();
  release();
  assert.equal(done.state, 'done');
});

test('#1880 an unreachable machine is refused before anything is sent', async (t) => {
  const s = await setup(t);
  s.machines.assign({ service: 'chatFast', machine: s.machineId, port: 1, model: MODEL }, 'admin');
  const out = await s.call('POST', '', { action: 'tune', service: 'chatFast', confirm: true });
  assert.equal(out.status, 503);
  assert.equal(out.body.code, 'machineUnreachable');
});

test('#1880 a machine answering errors fails the run; wall-clock fallback when the server has no timings', async (t) => {
  const bad = await setup(t, { status: 500 });
  await bad.call('POST', '', { action: 'tune', service: 'chatFast', confirm: true });
  assert.equal((await bad.tune.settled()).code, 'machineAnswer');
  const plain = await setup(t, { timings: false, latencyMs: 10 });
  await plain.call('POST', '', { action: 'tune', service: 'chatFast', confirm: true });
  assert.equal((await plain.tune.settled()).state, 'done');
  const r = plain.tune.resultFor(plain.machineId, MODEL);
  assert.ok(r.decode.workloads.every((w) => w.source === 'wall' && w.tokensPerSecond > 0));
  assert.deepEqual(r.speculative, { measured: false, drafted: 0, accepted: 0, acceptance: null }, 'no draft reported: nothing guessed');
});

test('#1880 only on-this-network addresses: a public address is refused at connect time, redirects are not followed', async (t) => {
  const store = memoryStore();
  const machines = createInferenceMachines({ store, log: () => {} });
  const { machine } = await machines.add({ name: 'Synthetic Pi', address: '127.0.0.1' }, 'admin');
  machines.assign({ service: 'chatFast', machine: machine.id, port: 8080, model: MODEL }, 'admin');
  const inits = [];
  const fetchImpl = async (url, init) => {
    inits.push(init);
    if (String(url).endsWith('/health')) return new Response('{}', { status: 200 });
    if (String(url).endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: MODEL }] }), { status: 200 });
    throw Object.assign(Error('refused'), { code: 'EPUBLICADDR' });
  };
  const chatMachines = createChatMachines({ machines, health: createMachineHealth({ fetchImpl }), fetchImpl });
  const tune = createMachineTune({ machines, chatMachines, store, log: () => {} });
  await tune.start({ service: 'chatFast', confirm: true, actor: 'synthetic-admin' });
  const done = await tune.settled();
  assert.equal(done.state, 'failed');
  assert.ok(inits.filter(Boolean).every((i) => i.redirect === 'error'), 'never follows a redirect');
});

test('#1880 the real chat handler counts a turn on the machine while it streams, and the count clears after', async (t) => {
  const s = await setup(t, { latencyMs: 300 });
  const saved = { kind: process.env.MODEL_MANAGER_KIND, base: process.env.INFERENCE_BASE_URL };
  process.env.MODEL_MANAGER_KIND = 'llamacpp'; process.env.INFERENCE_BASE_URL = 'http://default.invalid';
  t.after(() => { for (const [k, v] of [['MODEL_MANAGER_KIND', saved.kind], ['INFERENCE_BASE_URL', saved.base]]) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1880-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { createChatHandler } = require('./chat.cjs');
  const res = new EventEmitter(); res.writeHead = () => {}; res.write = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const roles = { fast: 'synthetic-fast', smart: 'synthetic-smart', code: 'synthetic-code' };
  const catalogue = Object.values(roles).map((name) => ({ name }));
  const { handleChat } = createChatHandler({
    chatMachines: s.chatMachines, modelManager: { enabled: true, makeRoomFor: async () => {}, props: async () => ({ ok: false, status: 404 }), health: async () => ({ ok: true, body: { all_models_loaded: [] } }) },
    templateToolsGate: require('./chat-template-caps.cjs').createToolsGate(), toolGate: null,
    reasoningEffort: require('./reasoning-effort.cjs'), crypto: require('node:crypto'), path, fs, fetch: async () => { throw Error('nothing local in this test'); },
    authService: { audit() {}, db: { prepare: () => ({ get: () => undefined }) } },
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange: require('./tool-exchange.cjs').createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', assets: [], files: [], routing: 'auto' }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', label: 'Local', baseUrl: 'http://default.invalid', apiKey: LOCAL_KEY }),
    providerHeaders: (p) => ({ 'Content-Type': 'application/json', ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) }),
    autoRoles: () => ({ ...roles }), visionDescriptions: new Map(), visionProbe: async () => ({ supported: false }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [], dropped: [], routes: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (r) => ({ text: String(r) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => catalogue, modelsInstalled: async () => catalogue,
    missingRoles: require('./auto-roles-check.cjs').missingRoles, staleRolesError: require('./auto-roles-check.cjs').staleRolesError,
    allToolboxes: () => [], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => 'synthetic result', awaitApproval: async () => 'decline',
  });
  const turn = handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'QA-SYNTH-1880 hello' });
  await waitFor(() => s.fake.chats().some((c) => c.body.stream));
  assert.equal(s.chatMachines.busy(s.machineId), true, 'the machine is serving a turn');
  const refused = await s.call('POST', '', { action: 'tune', service: 'chatFast', confirm: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'machineBusy');
  await turn;
  assert.equal(s.chatMachines.busy(s.machineId), false, 'the count clears when the turn ends');
});

test('#1880 recommendations are rules: a slow fill suggests a smaller context, low acceptance suggests drafting off', () => {
  const out = recommend({ contextTokens: 65536, prefill: [{ tokens: 1024, tokensPerSecond: 300 }, { tokens: 4096, tokensPerSecond: 200 }], speculative: { measured: true, acceptance: 0.3 } });
  assert.deepEqual(out.map((r) => [r.key, r.value, r.flag]), [['contextTokens', 23552, '--ctx-size 23552'], ['speculative', 'off', '--spec-type none']]);
  assert.deepEqual(recommend({ contextTokens: 8192, prefill: [{ tokens: 1024, tokensPerSecond: 300 }], speculative: { measured: false, acceptance: null } }), []);
});

test('#1880 default unchanged: without a measurement the measured line is exactly #1854\'s', async (t) => {
  const s = await setup(t);
  const m = (await s.call('GET', '?health=1')).body.health.measured.chatFast;
  assert.deepEqual(Object.keys(m).sort(), ['contextTokens', 'notMeasured', 'thinking', 'vision']);
  assert.deepEqual(m.notMeasured, ['autotune', 'speculativeDecoding', 'longContextProfile', 'presets']);
  assert.equal(s.fake.chats().length, 0, 'nothing is measured without an administrator starting it');
  assert.equal((await s.call('GET', '?tune=1')).body.tune, null);
  // A route built without the measurement (older wiring) answers as before.
  const routes = createInferenceMachineRoutes({ json: (res, status, body) => { res.out = { status, body }; return true; }, readJson: async (req) => req.body, machines: s.machines, health: createMachineHealth(), chatMachines: s.chatMachines });
  const res = { setHeader() {} };
  await routes({ method: 'POST', body: { action: 'nope' } }, res, { path: '/api/models/machines', authn: { user: { id: 'a', role: 'admin' } }, url: new URL('http://app.invalid/api/models/machines') });
  assert.equal(res.out.body.error, 'action must be one of add, update, remove, assign');
});
