'use strict';
// sbstndalton/noevia#1863: an Automatic turn loads its local model beside the routing decision when every role it
// could end on names that model. Time to first token is then about max(load, decision), not load + decision.
// A fake llama.cpp router (with a slow load) and a fake decision service; synthetic models and prompts only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { createModelManager } = require('./model-manager.cjs');
const { preloadTarget, startPreload } = require('./route-preload.cjs');
const reasoningEffort = require('./reasoning-effort.cjs');

const LOAD_MS = 600, DECISION_MS = 500;
const ONE = { fast: 'synthetic-one', smart: 'synthetic-one' };
const TWO = { fast: 'synthetic-fast', smart: 'synthetic-smart' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A llama.cpp router whose loads take LOAD_MS. `states`: { id: status }. */
function router(states) {
  const calls = [], unloads = [];
  const fetchJson = async (url, options = {}) => {
    const u = new URL(url), method = String(options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push(`${method} ${u.pathname}${body.model ? ' ' + body.model : ''}`);
    if (u.pathname === '/models' && method === 'GET') return { ok: true, status: 200, body: { data: Object.entries(states).map(([id, value]) => ({ id, status: { value } })) } };
    if (u.pathname === '/props') return { ok: true, status: 200, body: { default_generation_settings: { n_ctx: 16384 }, total_slots: 1 } };
    if (u.pathname === '/models/load') { states[body.model] = 'loading'; setTimeout(() => { if (states[body.model] === 'loading') states[body.model] = 'loaded'; }, LOAD_MS); return { ok: true, status: 200, body: { success: true } }; }
    // Each unload records the state the model was in: 'loaded' would mean a model that could be in use.
    if (u.pathname === '/models/unload') { unloads.push({ model: body.model, was: states[body.model] }); states[body.model] = 'unloaded'; return { ok: true, status: 200, body: { success: true } }; }
    return { ok: true, status: 200, body: {} };
  };
  const manager = createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic-router/v1', fetchJson, fetchStream: async () => ({ ok: false }) });
  return { manager, calls, states, unloads, loads: () => calls.filter((c) => c.startsWith('POST /models/load')) };
}

async function turn(t, { roles, states, project = { routing: 'auto' }, routingModes = null, chatMachines = null, decisionMs = DECISION_MS, route = 'fast', message = 'QA-SYNTH-1863 Say hello.', codeTasks = [], mode }) {
  const saved = { kind: process.env.MODEL_MANAGER_KIND, base: process.env.INFERENCE_BASE_URL };
  process.env.MODEL_MANAGER_KIND = 'llamacpp'; process.env.INFERENCE_BASE_URL = 'http://default.invalid';
  t.after(() => { for (const [k, v] of [['MODEL_MANAGER_KIND', saved.kind], ['INFERENCE_BASE_URL', saved.base]]) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1863-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const engine = router(states);
  const events = [], upstream = [];
  let firstToken = null, replied = null;
  const started = Date.now();
  const res = new EventEmitter(); res.writeHead = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  res.write = (chunk) => { for (const line of String(chunk).split('\n')) if (line.startsWith('data:')) { try { events.push(JSON.parse(line.slice(5))); } catch { /* not json */ } } };
  const fetch = async (url, init) => {
    if (String(url).includes('/chat/completions') && firstToken === null) firstToken = Date.now() - started;
    upstream.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello.' } }] })}\n\n`); })() };
  };
  const rows = Object.keys(states).map((name) => ({ name }));
  const { handleChat } = createChatHandler({
    chatMachines, routingModes,
    modelManager: engine.manager, reasoningEffort, crypto: require('node:crypto'), path, fs, fetch,
    authService: { audit() {}, db: { prepare: () => ({ get: () => undefined }) } },
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', assets: [], ...project }),
    skillsIndexFor: () => [], getProvider: (id) => (id === 'synthetic-cloud' ? { id, label: 'Cloud', baseUrl: 'http://cloud.invalid', apiKey: 'synthetic-cloud-key' } : { id: 'default', label: 'Local', baseUrl: 'http://default.invalid', apiKey: 'local' }),
    providerHeaders: () => ({ 'Content-Type': 'application/json' }),
    autoRoles: () => roles,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) }, resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (r) => ({ text: String(r) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: (_res, status, body) => { replied = { status, body }; }, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null,
    // The fake decision service: answers Fast after decisionMs.
    classifyFastOrSmart: async () => { await sleep(decisionMs); return route; }, codeTasksFor: () => codeTasks,
    servedCatalogue: async () => rows, modelsInstalled: async () => rows,
    missingRoles: require('./auto-roles-check.cjs').missingRoles, staleRolesError: require('./auto-roles-check.cjs').staleRolesError,
    allToolboxes: () => [{ id: 'core', tools: [] }], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => 'synthetic result', awaitApproval: async () => 'approve',
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message, ...(mode ? { mode } : {}) });
  return { events, upstream, engine, firstToken, replied, errors: events.filter((e) => e.type === 'error') };
}

test('#1863 preloadTarget: one local model for every role, nothing else', () => {
  assert.equal(preloadTarget({ roles: ONE }), 'synthetic-one');
  assert.equal(preloadTarget({ roles: { fast: 'synthetic-one' } }), 'synthetic-one');
  assert.equal(preloadTarget({ roles: { ...ONE, code: 'synthetic-one', creative: 'synthetic-one', vision: 'synthetic-eye' } }), 'synthetic-one', 'Vision is not a turn route');
  assert.equal(preloadTarget({ roles: TWO }), null, 'the decision could pick either model');
  assert.equal(preloadTarget({ roles: { ...ONE, code: 'synthetic-coder' } }), 'synthetic-one', 'a separate Code model: pre-load unless the turn looks like code');
  assert.equal(preloadTarget({ roles: { ...ONE, code: 'synthetic-coder' }, likelyCode: true }), null, 'the turn looks like code');
  assert.equal(preloadTarget({ roles: { ...ONE, code: 'synthetic-one' }, likelyCode: true }), 'synthetic-one', 'Code on the same model swaps nothing');
  assert.equal(preloadTarget({ roles: { fast: 'synthetic-one', smart: 'synthetic-one', code: 'synthetic-coder' }, remoteRole: (r) => (r === 'code' ? {} : null) }), null, 'any role on a machine');
  assert.equal(preloadTarget({ roles: { ...ONE, creative: 'synthetic-poet' } }), null, 'the Creative move is another model');
  assert.equal(preloadTarget({ roles: ONE, remoteRole: (r) => (r === 'smart' ? { model: 'x' } : null) }), null, 'a role on a machine');
  assert.equal(preloadTarget({ roles: ONE, hasImages: true }), null);
  assert.equal(preloadTarget({ roles: ONE, contextHigh: true }), null);
  assert.equal(preloadTarget({ roles: null }), null);
});

test('#1863 startPreload refuses an engine that is busy, holds another model, or already has this one', async () => {
  for (const [states, busy, why] of [
    [{ 'synthetic-one': 'loaded' }, false, 'already loaded'],
    [{ 'synthetic-one': 'sleeping' }, false, 'sleeping wakes on the request'],
    [{ 'synthetic-one': 'unloaded', 'synthetic-other': 'loaded' }, false, 'would evict a resident model'],
    [{ 'synthetic-one': 'unloaded', 'synthetic-other': 'loading' }, false, 'another load is arriving'],
    [{ 'synthetic-one': 'unloaded' }, true, 'engine busy'],
  ]) {
    const engine = router(states);
    assert.equal(await startPreload({ manager: engine.manager, model: 'synthetic-one', busy: () => busy }), null, why);
    assert.deepEqual(engine.loads(), [], why);
  }
  const aborted = new AbortController(); aborted.abort();
  const engine = router({ 'synthetic-one': 'unloaded' });
  assert.equal(await startPreload({ manager: engine.manager, model: 'synthetic-one', signal: aborted.signal }), null);
  assert.equal(await startPreload({ manager: { kind: 'lemonade', load() {}, listModels() {} }, model: 'synthetic-one' }), null, 'llama.cpp router only');
});

test('#1863 startPreload: a refused load (memory budget) is ignored, and cancel stops waiting', async () => {
  const refusing = { kind: 'llamacpp', listModels: async () => ({ ok: true, body: { data: [{ id: 'synthetic-one', loaded: false, status: { value: 'unloaded' } }] } }),
    load: async () => ({ ok: false, status: 409, body: { error: 'over budget' } }) };
  const p = await startPreload({ manager: refusing, model: 'synthetic-one' });
  assert.equal(await p.settled, false);
  assert.equal(p.pending(), false);
  const hanging = { ...refusing, load: (_m, _o, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) };
  const q = await startPreload({ manager: hanging, model: 'synthetic-one' });
  assert.equal(q.pending(), true);
  q.cancel();
  assert.equal(await q.settled, false);
  const throwing = { ...refusing, load: async () => { throw Error('router down'); } };
  assert.equal(await (await startPreload({ manager: throwing, model: 'synthetic-one' })).settled, false);
});

test('#1863 cold model, one model for Fast and Smart: TTFT is about max(load, decision), one load', async (t) => {
  const out = await turn(t, { roles: ONE, states: { 'synthetic-one': 'unloaded' } });
  assert.deepEqual(out.errors, []);
  assert.equal(out.engine.loads().length, 1, 'loaded once, not again by the turn');
  assert.ok(out.firstToken !== null, 'the model was asked');
  assert.ok(out.firstToken < LOAD_MS + DECISION_MS - 150, `overlapped: ${out.firstToken} ms vs ${LOAD_MS + DECISION_MS} ms sequential`);
  assert.ok(out.firstToken >= LOAD_MS, 'still waits for the load');
  assert.equal(out.upstream.find((r) => r.url.includes('/chat/completions')).body.model, 'synthetic-one');
  assert.ok(out.events.some((e) => e.type === 'status' && e.id === 'loadingModel'), 'the loading status is still shown');
});

test('#1863 control: two different Fast/Smart models never pre-load (load + decision, as before)', async (t) => {
  const out = await turn(t, { roles: TWO, states: { 'synthetic-fast': 'unloaded', 'synthetic-smart': 'unloaded' } });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.engine.loads(), ['POST /models/load synthetic-fast']);
  assert.ok(out.firstToken >= LOAD_MS + DECISION_MS, `sequential: ${out.firstToken} ms`);
});

test('#1863 already loaded: the turn is unchanged (no load, same request)', async (t) => {
  const out = await turn(t, { roles: ONE, states: { 'synthetic-one': 'loaded' } });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.engine.loads(), []);
  assert.equal(out.events.some((e) => e.type === 'status' && e.id === 'loadingModel'), false);
  const control = await turn(t, { roles: TWO, states: { 'synthetic-fast': 'loaded', 'synthetic-smart': 'unloaded' } });
  const chat = (o) => { const b = o.upstream.find((r) => r.url.includes('/chat/completions')).body; return JSON.stringify({ ...b, model: null }); };
  assert.equal(chat(out), chat(control), 'same upstream request apart from the model name');
});

test('#1863 a role on an Inference machine: no pre-load, nothing touched on this engine', async (t) => {
  const chatMachines = { target: (role) => (role === 'smart' ? { role, model: 'synthetic-one', machine: { id: 'm1' } } : null),
    effectiveRoles: (r) => r, localRoles: (r) => { const { smart: _s, ...rest } = r; return rest; }, remoteRoles: () => ({}), ready: async () => ({ ok: true }) };
  const out = await turn(t, { roles: ONE, states: { 'synthetic-one': 'unloaded' }, chatMachines });
  // The Fast turn here then loads as before, after the decision.
  assert.ok(out.firstToken >= LOAD_MS + DECISION_MS, `no overlap: ${out.firstToken} ms`);
  assert.deepEqual(out.engine.loads(), ['POST /models/load synthetic-one']);
});

test('#1863 a cloud route (routing modes): no pre-load, the local engine is never touched', async (t) => {
  const routingModes = { enabled: () => true, settings: () => ({ mode: 'cloud', whenSensitive: 'ask', cloud: { providerId: 'synthetic-cloud', fast: 'cloud-fast', smart: 'cloud-smart' } }),
    log() {}, sensitivity: async () => ({ sensitive: false }), awaitChoice: async () => ({ choice: 'cloud' }), setChatFlags() {} };
  const out = await turn(t, { roles: ONE, states: { 'synthetic-one': 'unloaded' }, routingModes });
  assert.deepEqual(out.engine.loads(), [], 'nothing loaded locally');
  assert.equal(out.replied, null, `the turn ran: ${JSON.stringify(out.replied)}`);
  assert.deepEqual(out.errors, []);
  assert.ok(out.upstream.some((r) => r.url.startsWith('http://cloud.invalid')), 'answered by the cloud route');
  assert.equal(out.engine.calls.length, 0, 'the local engine was not even listed');
});

// The owner's role shape: Fast and Smart share one model, Code is another, Creative unset.
const OWNER = { fast: 'synthetic-shared-12b', smart: 'synthetic-shared-12b', code: 'synthetic-coder-9b' };
const ownerStates = () => ({ 'synthetic-shared-12b': 'unloaded', 'synthetic-coder-9b': 'unloaded' });
const chatModel = (out) => out.upstream.find((r) => r.url.includes('/chat/completions'))?.body.model;

test('#1863 owner shape: a plain turn pre-loads the shared Fast/Smart model, TTFT about max(load, decision)', async (t) => {
  const out = await turn(t, { roles: OWNER, states: ownerStates() });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.engine.loads(), ['POST /models/load synthetic-shared-12b']);
  assert.deepEqual(out.engine.unloads, []);
  assert.equal(chatModel(out), 'synthetic-shared-12b');
  assert.ok(out.firstToken < LOAD_MS + DECISION_MS - 150, `overlapped: ${out.firstToken} ms`);
});

test('#1863 owner shape: the code rule (a fenced block), a Code project or a Task turn never pre-loads', async (t) => {
  for (const [opts, why] of [
    [{ message: 'QA-SYNTH-1863 fix this\n```js\nlet a = 1\n```', route: 'code' }, 'fenced code'],
    [{ message: 'QA-SYNTH-1863\ndiff --git a/x b/x', route: 'code' }, 'a diff'],
    [{ codeTasks: [{ id: 'synthetic-task' }], route: 'code' }, 'a project with Code tasks'],
    [{ project: { routing: 'auto', sharedContext: { chat: true } }, route: 'code' }, 'a project sharing Code context'],
  ]) {
    const out = await turn(t, { roles: OWNER, states: ownerStates(), ...opts });
    assert.deepEqual(out.errors, [], why);
    assert.deepEqual(out.engine.loads(), ['POST /models/load synthetic-coder-9b'], `${why}: only the Code model loads, as today`);
    assert.deepEqual(out.engine.unloads, [], why);
    assert.equal(chatModel(out), 'synthetic-coder-9b', why);
  }
  assert.equal(preloadTarget({ roles: OWNER, likelyCode: true }), null, 'a Task (cowork) turn is likelyCode');
});

test('#1863 owner shape, wrong guess: the decision picks Code after a pre-load started', async (t) => {
  // Today: decision then one Code load, about DECISION_MS + LOAD_MS.
  const out = await turn(t, { roles: OWNER, states: ownerStates(), route: 'code' });
  assert.deepEqual(out.errors, []);
  assert.equal(chatModel(out), 'synthetic-coder-9b', 'the turn still gets its Code model');
  assert.deepEqual(out.engine.loads(), ['POST /models/load synthetic-shared-12b', 'POST /models/load synthetic-coder-9b']);
  // The only unload is the pre-loaded shared model, which nothing used: no request ever went to it.
  assert.deepEqual(out.engine.unloads.map((u) => u.model), ['synthetic-shared-12b']);
  assert.equal(out.upstream.some((r) => r.body?.model === 'synthetic-shared-12b'), false, 'the unloaded model was never in use');
  assert.equal(out.engine.states['synthetic-shared-12b'], 'unloaded');
  // Cancelled at the decision, so the swap does not wait for the rest of the shared model's load.
  assert.ok(out.firstToken < DECISION_MS + LOAD_MS + 350, `wrong guess costs about today's time: ${out.firstToken} ms vs ${DECISION_MS + LOAD_MS} ms`);
  console.log(`[1863] wrong-guess TTFT ${out.firstToken} ms (today ${DECISION_MS + LOAD_MS} ms + poll granularity)`);
});

test('#1863 owner shape, wrong guess with a fast decision: the pre-load is cancelled mid-load, the swap does not wait for it', async (t) => {
  const out = await turn(t, { roles: OWNER, states: ownerStates(), route: 'code', decisionMs: 100 });
  assert.deepEqual(out.errors, []);
  assert.equal(chatModel(out), 'synthetic-coder-9b');
  assert.deepEqual(out.engine.unloads, [{ model: 'synthetic-shared-12b', was: 'loading' }], 'only the unused, still-loading pre-load');
  assert.equal(out.upstream.some((r) => r.body?.model === 'synthetic-shared-12b'), false);
  // Without the cancel the swap would wait for the rest of the 600 ms load: about 100 + 600 + 600.
  assert.ok(out.firstToken < 100 + LOAD_MS + 400, `${out.firstToken} ms vs today ${100 + LOAD_MS} ms`);
  console.log(`[1863] wrong-guess (fast decision) TTFT ${out.firstToken} ms (today ${100 + LOAD_MS} ms)`);
});
