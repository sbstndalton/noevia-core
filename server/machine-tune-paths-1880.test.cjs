'use strict';
// sbstndalton/noevia#1880 review: every path that uses a role's Inference machine counts as a turn there while it runs,
// so a measurement is refused (409 machineBusy) while it is in flight: the Code relay (per forwarded request), a Deep
// Research step, a Vision description of attached images and a Vision caption of a retrieved image.
// Each fake llama-server tries to start the measurement from inside the request it is answering. Synthetic data only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createInferenceMachines } = require('./inference-machines.cjs');
const { createChatMachines } = require('./chat-machines.cjs');
const { createMachineHealth } = require('./machine-health.cjs');
const { createMachineTune } = require('./machine-tune.cjs');
const { codeTargetFrom, createEngineRelay } = require('./code-machine.cjs');
const { createResearchModel } = require('./research-model.cjs');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { readCappedJson } = require('./http.cjs');

const MODEL = 'synthetic-remote-1880';
function memoryStore() { const map = new Map(); return { get: (k) => map.get(k), set: (k, v) => map.set(k, v), delete: (k) => map.delete(k) }; }

/** A fake llama-server; `during` runs inside each chat-completions request before it is answered. */
async function fakeServer(t, during) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const reply = (code, b) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.url === '/health') return reply(200, { status: 'ok' });
      if (req.url === '/v1/models') return reply(200, { data: [{ id: MODEL }] });
      if (req.url.startsWith('/props')) return reply(200, { default_generation_settings: { n_ctx: 8192 }, chat_template: '{{ messages }}', modalities: { vision: true } });
      if (req.url === '/v1/chat/completions') {
        const body = JSON.parse(raw);
        seen.push(body);
        if (body.max_tokens !== 1) await during(body);
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Remote.' } }] })}\n\ndata: [DONE]\n\n`);
          return res.end();
        }
        return reply(200, { choices: [{ message: { content: 'Synthetic description: a red square.' }, finish_reason: 'stop' }] });
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { port: server.address().port, seen };
}

/** One machine with `service` on the fake server, the measurement, and what a start answered inside the request. */
async function setup(t, service) {
  const attempts = [];
  let tune = null;
  const fake = await fakeServer(t, async () => {
    try { await tune.start({ service, confirm: true, actor: 'synthetic-admin' }); attempts.push('started'); }
    catch (err) { attempts.push(err.code); }
  });
  const machines = createInferenceMachines({ store: memoryStore(), log: () => {} });
  const { machine } = await machines.add({ name: 'Synthetic Pi', address: '127.0.0.1' }, 'admin');
  machines.assign({ service, machine: machine.id, port: fake.port, model: MODEL }, 'admin');
  const chatMachines = createChatMachines({ machines, health: createMachineHealth() });
  tune = createMachineTune({ machines, chatMachines, store: memoryStore(), log: () => {} });
  return { fake, chatMachines, tune, attempts, machineId: machine.id };
}

const settle = async (s) => { if (s.tune.status()?.state === 'running') s.tune.abort('synthetic-admin'); await s.tune.settled(); };

test('#1880 Code relay: each forwarded request holds the machine; a measurement is refused while it is in flight', async (t) => {
  const s = await setup(t, 'chatCode');
  let relay = null;
  const server = http.createServer((req, res) => { relay.handle(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  relay = createEngineRelay({ chatMachines: s.chatMachines, target: () => codeTargetFrom(s.chatMachines, () => ({})), url });
  const lease = await relay.open({ taskId: 'synthetic-task' });
  for (const stream of [false, true]) {
    const r = await fetch(`${url}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${lease.token}` },
      body: JSON.stringify({ model: 'x', stream, messages: [{ role: 'user', content: 'QA-SYNTH-1880' }] }) });
    assert.equal(r.status, 200);
    await r.text();
  }
  assert.deepEqual(s.attempts, ['machineBusy', 'machineBusy']);
  assert.equal(s.chatMachines.busy(s.machineId), false, 'released after each request');
  lease.close?.();
  await settle(s);
});

test('#1880 Deep Research: a step on the machine holds it; a measurement is refused while it is in flight', async (t) => {
  const s = await setup(t, 'chatSmart');
  const research = createResearchModel({ autoRoles: () => ({ smart: 'synthetic-local' }), lastLoadedModel: () => null, chatMachines: s.chatMachines,
    getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), DEFAULT_PROVIDER_ID: 'default', providerHeaders: () => ({}),
    fetch: async () => { throw Error('nothing local'); }, modelManager: {}, admitEngineModel: async () => {}, readCappedJson });
  const text = await research.complete({}, [{ role: 'user', content: 'QA-SYNTH-1880 summarise' }], { signal: new AbortController().signal, maxTokens: 64 });
  assert.match(text, /Synthetic description/);
  assert.deepEqual(s.attempts, ['machineBusy']);
  assert.equal(s.chatMachines.busy(s.machineId), false);
  await settle(s);
});

/** A chat turn through the real handler with the Vision role on the machine; the answer is local and cannot see. */
async function visionTurn(t, s, { retrieved = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1880-v-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic red square')]);
  const sha = crypto.createHash('sha256').update(PNG).digest('hex');
  const events = [];
  const res = new EventEmitter(); res.writeHead = () => {}; res.write = (line) => { try { events.push(JSON.parse(String(line).slice(6))); } catch { /* not json */ } };
  res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const localFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.stream) return { ok: true, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Local answer.' } }] })}\n\n`); })() };
    if (body.max_tokens === 1) return new Response('provide the mmproj', { status: 500 }); // the answering model cannot see
    throw Error(`unexpected local request ${url}`);
  };
  const asset = { id: 'img-red', name: 'red.png', mime: 'image/png', bytes: PNG.length, sourceName: 'red.png' };
  const project = { id: 'fixture-project', model: 'answer-model', assets: [asset], files: retrieved ? [{ name: 'red.png', content: '', attachment: { id: sha, group: 'Images', state: 'vision' } }] : [] };
  const hit = { file: 'red.png', kind: 'image', meta: { source: 'red.png', assetId: asset.id, name: asset.name, mime: 'image/png' }, hash: `img:${sha}`, score: 0.7 };
  const { handleChat } = createChatHandler({
    chatMachines: s.chatMachines,
    rag: { filesContext: async (_p, _f, _q, _u, _s, opts) => { if (retrieved && opts?.images) opts.onImages({ hits: [hit], indexed: [hit] }); return null; }, readCaption: () => null, writeCaption: () => true },
    prefill: { recordSample() {} }, reduceToolResult: (text) => ({ text }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], executeToolCall: async () => '', grantContext: async raw => require('../tests/server/chat-grant-fixture.cjs').context(raw, { holder: { kind: 'absent' } }), chatWideApproved: () => false, awaitApproval: async () => 'decline', recordUsage() {}, recordToolUse() {},
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: {}, crypto, path, fetch: localFetch,
    fs: { readFileSync: () => PNG },
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => project, skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid' }), providerHeaders: () => ({}),
    autoRoles: () => ({ vision: 'synthetic-local-vision' }),
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: localFetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false }, chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [],
    CONNECTOR_BOXES: new Set(), connectedBoxes: () => [], toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    multimodalEnabled: () => retrieved,
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'QA-SYNTH-1880 what colour is it?', ...(retrieved ? {} : { turnImageIds: [asset.id] }) });
  return events;
}

test('#1880 Vision description on the machine holds it; a measurement is refused while it is in flight', async (t) => {
  const s = await setup(t, 'vision');
  await visionTurn(t, s);
  assert.ok(s.fake.seen.some((b) => b.model === MODEL && b.max_tokens !== 1), 'the description ran on the machine');
  assert.deepEqual(s.attempts, ['machineBusy']);
  assert.equal(s.chatMachines.busy(s.machineId), false);
  await settle(s);
});

test('#1880 Vision caption of a retrieved image on the machine holds it; a measurement is refused while it is in flight', async (t) => {
  const s = await setup(t, 'vision');
  await visionTurn(t, s, { retrieved: true });
  assert.ok(s.fake.seen.some((b) => b.model === MODEL && b.max_tokens === 1024), 'the caption ran on the machine');
  assert.deepEqual(s.attempts, ['machineBusy']);
  assert.equal(s.chatMachines.busy(s.machineId), false);
  await settle(s);
});
