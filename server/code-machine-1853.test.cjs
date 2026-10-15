'use strict';
// sbstndalton/noevia#1853: the Code pipeline (role engine) and the Code sandbox follow the Code role to its
// Inference machine. A fake llama-server on loopback is the machine. A full pipeline task runs its Planner,
// review and Auditor on it through the role engine's machine pin (no admission, no residency read, no budget,
// no local key), and its Executor reaches it only through web's relay (code-machine.cjs) with a per-run token.
// An unreachable machine and one serving another model refuse the task with the #1840 texts and send nothing.
// With nothing assigned, every request is what it was. Synthetic repositories, models and prompts only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createInferenceMachines } = require('./inference-machines.cjs');
const { createChatMachines } = require('./chat-machines.cjs');
const { createMachineHealth } = require('./machine-health.cjs');
const { createRoleEngine } = require('./role-engine.cjs');
const { createPlannerPlan } = require('./planner-plan.cjs');
const { createPlannerReview, createEngineReviewer, REVIEW_ACTION } = require('./code-review.cjs');
const { createCodePipeline } = require('./code-pipeline.cjs');
const { createCodeService } = require('./code-service.cjs');
const { createVerifyAdapter } = require('./code-pipeline-verify.cjs');
const { codeTargetFrom, createEngineRelay, startEngineRelayFromEnv } = require('./code-machine.cjs');

const REMOTE = 'synthetic-coder-1853';
const LOCAL_KEY = 'synthetic-local-key-1853';
const temps = [];
const temp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo() {
  const dir = temp('noevia-1853-repo-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 'qa@example.invalid'); git(dir, 'config', 'user.name', 'QA');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'first');
  return dir;
}
function memoryStore() { const map = new Map(); return { get: (k) => map.get(k), set: (k, v) => map.set(k, v) }; }

const PLAN = { goal: 'Change a.', context: [], constraints: [], investigation: [], steps: [{ n: 1, do: 'Edit a.txt', done_when: 'a.txt says b' }],
  capabilities: [], approval_boundaries: [], verification: [], completion: 'done', non_goals: [] };
const VERDICT = { verdict: 'approve', summary: 'Fine.', findings: [] };
const AUDIT = { completeness: 'complete', summary: 'Measured.', evidence: [{ source: 'tests', note: 'passed' }], gaps: [] };

/** The answer a role asks for, from its persona block (role-engine.cjs buildMessages). */
function roleAnswer(body) {
  const user = String(body?.messages?.[1]?.content || '');
  if (user.includes('You are the Planner. Write')) return PLAN;
  if (user.includes('reviewing a finished code change')) return VERDICT;
  if (user.includes('You are the Auditor')) return AUDIT;
  return null;
}

/** A fake llama-server: /health, /v1/models, /props, /v1/chat/completions (SSE for role calls, JSON otherwise). */
async function fakeLlama(t, { models = [REMOTE], redirect = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"ok"}'); }
      if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: models.map((id) => ({ id })) })); }
      if (req.url.startsWith('/props')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ default_generation_settings: { n_ctx: 16384 } })); }
      if (req.url === '/v1/chat/completions') {
        if (redirect) { res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' }); return res.end(); }
        const body = JSON.parse(raw);
        const answer = roleAnswer(body);
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const text = answer ? JSON.stringify(answer) : 'Executor hello.';
          for (let i = 0; i < text.length; i += 16) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 16) } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: { prompt_n: 10, predicted_n: 5 } })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: answer ? JSON.stringify(answer) : 'Executor hello.' }, finish_reason: 'stop' }] }));
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { port: server.address().port, seen, chats: () => seen.filter((s) => s.url === '/v1/chat/completions') };
}

async function closedPort() {
  const s = http.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise((r) => s.close(r));
  return port;
}

async function machinesFor(assign = []) {
  const machines = createInferenceMachines({ store: memoryStore(), log: () => {} });
  const { machine } = await machines.add({ name: 'Synthetic Pi', address: '127.0.0.1' }, 'admin');
  for (const a of assign) machines.assign({ ...a, machine: machine.id }, 'admin');
  return createChatMachines({ machines, health: createMachineHealth() });
}

/** The relay on loopback (production binds web's code-network address). */
async function relayFor(t, chatMachines, target) {
  let relay = null;
  const server = http.createServer((req, res) => { relay.handle(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  relay = createEngineRelay({ chatMachines, target, url });
  return { relay, url };
}

/** Everything index.cjs wires for Code, with spies on every local-engine path. */
async function wiring(t, { chatMachines, autoRoles = () => ({ smart: 'synthetic-local-smart' }) }) {
  const target = () => codeTargetFrom(chatMachines, autoRoles);
  const r = await relayFor(t, chatMachines, target);
  const local = { admissions: 0, budget: 0, fetches: [], leases: 0 };
  const localFetch = async (url) => { local.fetches.push(String(url)); throw Error('the local engine must not be used'); };
  const roleEndpoint = () => {
    const remote = target();
    if (remote) return { baseUrl: `${remote.baseUrl}/v1`, apiKey: null, model: remote.model, external: false, provider: chatMachines.provider(remote), machine: remote };
    return { baseUrl: 'http://local-engine.invalid/v1', apiKey: LOCAL_KEY, model: 'synthetic-local-smart', external: false, provider: null };
  };
  const roleEngine = createRoleEngine({ engine: roleEndpoint, fetch: localFetch, machines: chatMachines,
    admission: async (work) => { local.admissions += 1; return work(); }, budgetRefusal: () => { local.budget += 1; return null; } });
  const planner = createPlannerPlan({ engine: roleEndpoint, fetch: localFetch, machines: chatMachines, admit: async () => { local.admissions += 1; } });
  const review = createPlannerReview({ enabled: () => true, roleEngine });
  const engine = () => {
    const remote = target();
    if (remote) return { baseUrl: r.url, apiKey: null, model: remote.model, relay: r.relay };
    return { baseUrl: 'http://local-engine.invalid/v1', apiKey: LOCAL_KEY, model: 'synthetic-local-smart' };
  };
  return { target, relay: r.relay, relayUrl: r.url, local, roleEngine, planner, review, engine };
}

function measuredVerifier() {
  const measured = new WeakSet();
  return { available: () => true,
    isMeasured: (r, e) => measured.has(r) && r.taskId === e.taskId && r.headSha === e.headSha && r.revision === e.revision,
    run: async ({ taskId, headSha, revision, emit }) => {
      const report = Object.freeze({ kind: 'test-report', passed: true, exitCode: 0, tail: 'ok', taskId, headSha, revision });
      measured.add(report);
      emit('artifact.created', { ...report });
      return { status: 'passed', report, error: null };
    } };
}

/** The Code service with the pipeline on; the fake agent calls whatever engine its pinned opencode.json names. */
function service(w, { agentCalls }) {
  const ws = { dir: temp('noevia-1853-ws-'), userId: 'tenant-synthetic' };
  const svc = createCodeService({ repos: [{ id: 'fixture', path: repo() }], sandboxKind: 'sandbox', timeoutMs: 5000, engine: w.engine,
    // As index.cjs: a task whose Code role is on a machine takes no local inference lease.
    inference: { enter: () => { if (!w.target()) w.local.leases += 1; return () => {}; }, paused: () => false },
    connect: async ({ cwd }) => ({ agent: {}, prompt: async () => {
      const config = JSON.parse(fs.readFileSync(path.join(cwd, 'opencode.json'), 'utf8'));
      const options = config.provider.local.options;
      const r = await fetch(`${options.baseURL}/chat/completions`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ model: 'whatever-the-agent-says', stream: false, messages: [{ role: 'user', content: 'QA-SYNTH-1853 edit a' }] }) });
      agentCalls.push({ status: r.status, body: await r.json(), options, model: config.model });
      fs.writeFileSync(path.join(cwd, 'a.txt'), 'b'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'edit');
      return { stopReason: 'end_turn' };
    } }),
    pipeline: { enabled: () => true, create: (deps) => createCodePipeline({ ...deps, merge: () => false,
      roleEngine: w.roleEngine, planner: w.planner, review: w.review, verify: createVerifyAdapter(measuredVerifier()) }) } });
  return { svc, ws };
}
const project = { id: 'p1' };
const settle = async (svc, ws, id, until) => {
  for (let i = 0; i < 1000 && !until.includes(svc.get(ws, project, id)?.status); i++) await new Promise((r) => setTimeout(r, 5));
  return svc.get(ws, project, id);
};

test('Code on a machine: Planner, Executor (via the relay), review and Auditor all run on its model; nothing local', async (t) => {
  const fake = await fakeLlama(t);
  const chatMachines = await machinesFor([{ service: 'chatCode', port: fake.port, model: REMOTE }]);
  const w = await wiring(t, { chatMachines });
  const agentCalls = [];
  const { svc, ws } = service(w, { agentCalls });
  const started = await svc.start(ws, project, { repository: 'fixture', prompt: 'QA-SYNTH-1853 Change a to b.', promptPreparation: 'planner' });
  const waiting = await settle(svc, ws, started.taskId, ['waiting_approval', 'failed', 'completed']);
  assert.equal(waiting.status, 'waiting_approval', waiting.error);
  assert.equal(waiting.approval.action, REVIEW_ACTION);
  assert.equal(waiting.approval.verdict.verdict, 'approve');
  assert.equal(waiting.pipeline.audit.overall, 'complete');

  const chats = fake.chats();
  const roles = chats.filter((c) => c.body.stream).map((c) => roleAnswer(c.body));
  assert.deepEqual(roles, [PLAN, VERDICT, AUDIT], 'Planner, review and Auditor streamed from the machine, in order');
  // Every request: the machine's model, never this machine's key.
  for (const c of chats) {
    assert.equal(c.body.model, REMOTE);
    assert.equal(c.headers.authorization, undefined);
  }
  // The Executor: its config names the relay and a per-run token, never the machine or the local key.
  assert.equal(agentCalls.length, 1);
  assert.equal(agentCalls[0].status, 200, JSON.stringify(agentCalls[0].body));
  assert.equal(agentCalls[0].options.baseURL, w.relayUrl);
  assert.match(agentCalls[0].options.apiKey, /^ncr_/);
  assert.equal(agentCalls[0].model, `local/${REMOTE}`);
  assert.equal(agentCalls[0].body.choices[0].message.content, 'Executor hello.');
  const executor = chats.filter((c) => !c.body.stream);
  assert.equal(executor.length, 1);
  assert.equal(executor[0].body.model, REMOTE, 'the relay forces the task’s model');
  assert.equal(executor[0].body.messages[0].content, 'QA-SYNTH-1853 edit a');
  // Nothing admitted, budgeted, leased or sent to this machine's engine; the relay token is gone.
  assert.deepEqual(w.local, { admissions: 0, budget: 0, fetches: [], leases: 0 });
  assert.equal(w.relay.active(), 0);
  // The used token no longer works.
  const again = await fetch(`${w.relayUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${agentCalls[0].options.apiKey}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(again.status, 401);
  svc.cancel(ws, project, started.taskId);
  await settle(svc, ws, started.taskId, ['cancelled', 'completed', 'failed']);
});

test('Smart on a machine and no Code model here: the task follows Smart; a local Code model keeps it here', async () => {
  const chatMachines = await machinesFor([{ service: 'chatSmart', port: 9, model: REMOTE }]);
  assert.equal(codeTargetFrom(chatMachines, () => ({}))?.model, REMOTE);
  assert.equal(codeTargetFrom(chatMachines, () => ({ code: 'synthetic-local-coder' })), null);
  assert.equal(codeTargetFrom(await machinesFor(), () => ({})), null);
  assert.equal(codeTargetFrom(null, () => ({})), null);
});

for (const kind of ['unreachable', 'wrong model']) {
  test(`a machine that is ${kind}: the task refuses at the pin with the #1840 text; nothing is sent`, async (t) => {
    const fake = kind === 'wrong model' ? await fakeLlama(t, { models: ['synthetic-other-model'] }) : null;
    const port = fake ? fake.port : await closedPort();
    const chatMachines = await machinesFor([{ service: 'chatCode', port, model: REMOTE }]);
    const w = await wiring(t, { chatMachines });
    const agentCalls = [];
    const { svc, ws } = service(w, { agentCalls });
    const started = await svc.start(ws, project, { repository: 'fixture', prompt: 'QA-SYNTH-1853 Change a to b.', promptPreparation: 'planner' });
    const done = await settle(svc, ws, started.taskId, ['failed', 'completed', 'cancelled']);
    assert.equal(done.status, 'failed');
    assert.equal(done.lifecycle, 'blocked');
    if (kind === 'unreachable') assert.match(done.error, /Code model’s machine \(Synthetic Pi\) is unreachable/);
    else assert.match(done.error, /The Code machine \(Synthetic Pi\) serves synthetic-other-model, not synthetic-coder-1853/);
    assert.equal(agentCalls.length, 0);
    if (fake) assert.equal(fake.chats().length, 0);
    assert.deepEqual(w.local, { admissions: 0, budget: 0, fetches: [], leases: 0 });
  });
}

test('the Executor alone (a direct task) also needs the machine ready, and refuses a task naming another model', async (t) => {
  const fake = await fakeLlama(t, { models: ['synthetic-other-model'] });
  const chatMachines = await machinesFor([{ service: 'chatCode', port: fake.port, model: REMOTE }]);
  const w = await wiring(t, { chatMachines });
  await assert.rejects(() => w.relay.open({ taskId: 't1' }), (e) => /serves synthetic-other-model, not synthetic-coder-1853/.test(e.publicMessage) && e.code === 'machineWrongModel');
  const ok = await fakeLlama(t);
  const chatMachines2 = await machinesFor([{ service: 'chatCode', port: ok.port, model: REMOTE }]);
  const w2 = await wiring(t, { chatMachines: chatMachines2 });
  await assert.rejects(() => w2.relay.open({ taskId: 't2', model: 'synthetic-elsewhere' }), (e) => e.code === 'model_mismatch' && /One task runs on one model/.test(e.message));
  await assert.rejects(() => w2.relay.open({ taskId: 't3', expect: null }), (e) => e.code === 'model_mismatch', 'pinned here, but the role is now on a machine');
  const lease = await w2.relay.open({ taskId: 't4' });
  assert.equal(lease.contextTokens, 16384);
  lease.close();
  // No relay configured: the task says how to fix it, never falls back to the local engine.
  const none = createEngineRelay({ chatMachines: chatMachines2, target: () => codeTargetFrom(chatMachines2, () => ({})), url: null });
  await assert.rejects(() => none.open({ taskId: 't5' }), (e) => e.code === 'machineRelayOff' && /CODE_ENGINE_RELAY_PORT/.test(e.message));
  assert.equal(ok.chats().length, 0);
});

test('the relay: a live task token only, two paths only, the machine’s model forced, and nothing after the run', async (t) => {
  const fake = await fakeLlama(t);
  const chatMachines = await machinesFor([{ service: 'chatCode', port: fake.port, model: REMOTE }]);
  const w = await wiring(t, { chatMachines });
  const post = (token, p = '/chat/completions', body = { model: 'x', messages: [] }, method = 'POST') => fetch(`${w.relayUrl}${p}`, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await post(null)).status, 401);
  assert.equal((await post('ncr_forged')).status, 401);
  const lease = await w.relay.open({ taskId: 'relay-1' });
  const models = await post(lease.token, '/models', null, 'GET');
  assert.deepEqual((await models.json()).data.map((m) => m.id), [REMOTE]);
  for (const p of ['/embeddings', '/../props', '/completions']) assert.equal((await post(lease.token, p)).status, 404, p);
  assert.equal((await fetch(w.relayUrl.replace(/\/v1$/, '/health'), { headers: { Authorization: `Bearer ${lease.token}` } })).status, 404);
  const r = await post(lease.token, '/chat/completions', { model: 'synthetic-elsewhere', messages: [{ role: 'user', content: 'QA-SYNTH' }], stream: true });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /data: \[DONE\]/);
  const sent = fake.chats().at(-1);
  assert.equal(sent.body.model, REMOTE);
  assert.equal(sent.headers.authorization, undefined, 'the relay token is never forwarded');
  // A body over the cap is refused before anything is sent.
  const small = createEngineRelay({ chatMachines, target: w.target, url: 'http://unused.invalid/v1', bodyCap: 64 });
  const s = http.createServer((req, res) => { small.handle(req, res); });
  await new Promise((rr) => s.listen(0, '127.0.0.1', rr)); t.after(() => new Promise((rr) => s.close(rr)));
  const sl = await small.open({ taskId: 'relay-2' });
  const big = await fetch(`http://127.0.0.1:${s.address().port}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${sl.token}` }, body: 'x'.repeat(1000) });
  assert.equal(big.status, 413);
  lease.close(); sl.close();
  assert.equal((await post(lease.token)).status, 401);
});

test('the relay never reaches past the on-this-network rules: link-local, public and redirects are refused', async (t) => {
  const redirecting = await fakeLlama(t, { redirect: true });
  const cases = [
    { address: '169.254.169.254', port: 80, want: /unreachable/ },
    { address: '8.8.8.8', port: 80, want: /not on this network|unreachable/ },
    { address: '127.0.0.1', port: redirecting.port, want: /redirect/ },
  ];
  for (const c of cases) {
    const t0 = { role: 'code', service: 'chatCode', machine: { id: 'm1', name: 'Synthetic Pi', address: c.address }, port: c.port, model: REMOTE, baseUrl: `http://${c.address}:${c.port}` };
    // No health cache: ready() passes, so the request itself meets serviceFetch.
    const chatMachines = createChatMachines({ machines: { chatTarget: (role) => (role === 'code' ? t0 : null), machine: () => null }, health: null });
    const relay = createEngineRelay({ chatMachines, target: () => chatMachines.target('code'), url: 'http://unused.invalid/v1' });
    const s = http.createServer((req, res) => { relay.handle(req, res); });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const lease = await relay.open({ taskId: 'net-1' });
    const r = await fetch(`http://127.0.0.1:${s.address().port}/v1/chat/completions`, { method: 'POST',
      headers: { Authorization: `Bearer ${lease.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [] }), signal: AbortSignal.timeout(20000) });
    const body = await r.json();
    assert.equal(r.status, 502, `${c.address}: ${JSON.stringify(body)}`);
    assert.match(body.error.message, c.want, c.address);
    lease.close();
    await new Promise((r2) => s.close(r2));
  }
  assert.equal(redirecting.chats().length, 1, 'the redirect was answered once and never followed');
});

test('the role engine pins one model per task: a role moving between the pin and a call refuses the call', async (t) => {
  const fake = await fakeLlama(t);
  const machines = createInferenceMachines({ store: memoryStore(), log: () => {} });
  const { machine } = await machines.add({ name: 'Synthetic Pi', address: '127.0.0.1' }, 'admin');
  machines.assign({ service: 'chatCode', port: fake.port, model: REMOTE, machine: machine.id }, 'admin');
  const chatMachines = createChatMachines({ machines, health: createMachineHealth() });
  const w = await wiring(t, { chatMachines });
  const pin = await w.roleEngine.pinModel({ taskId: 'pin-1' });
  assert.equal(pin.ok, true, JSON.stringify(pin));
  assert.equal(pin.session.model, REMOTE);
  const named = await w.roleEngine.pinModel({ taskId: 'pin-2', model: 'synthetic-elsewhere' });
  assert.equal(named.code, 'model_mismatch');
  machines.assign({ service: 'chatCode', machine: 'local' }, 'admin');
  const call = await pin.session.call({ role: 'planner', state: { taskId: 'pin-1', tenantId: 't', request: 'x' }, instructions: 'i', schema: { type: 'object' } });
  assert.equal(call.code, 'model_mismatch');
  assert.equal(fake.chats().length, 0);
  assert.deepEqual(w.local, { admissions: 0, budget: 0, fetches: [], leases: 0 });
});

test('nothing assigned: the role engine, Planner and reviewer send exactly what they sent before', async () => {
  const record = () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init: { ...init, signal: undefined } });
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'synthetic-local-smart', status: { value: 'loaded' } }] }), { status: 200 });
      const body = JSON.parse(init.body);
      if (body.stream) {
        const text = JSON.stringify(PLAN);
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body.messages[0].content.includes('reviewing') ? VERDICT : PLAN) } }] }), { status: 200 });
    };
    return { calls, fetchImpl };
  };
  const endpoint = () => ({ baseUrl: 'http://local-engine.invalid/v1', apiKey: LOCAL_KEY, model: 'synthetic-local-smart', external: false, provider: null });
  const run = async (withMachines) => {
    const r = record();
    const machines = withMachines ? await machinesFor() : null;
    const admitted = [];
    const engine = createRoleEngine({ engine: endpoint, fetch: r.fetchImpl, machines, admission: async (work) => { admitted.push('role'); return work(); }, budgetRefusal: () => null });
    const pin = await engine.pinModel({ taskId: 'same-1' });
    await createPlannerPlan({ engine: endpoint, fetch: r.fetchImpl, machines }).generate({ session: pin.session, state: { taskId: 'same-1', tenantId: 't', request: 'QA-SYNTH', capabilities: [{ name: 'edit', description: 'Edit' }] } });
    await createPlannerPlan({ engine: endpoint, fetch: r.fetchImpl, machines, admit: async () => { admitted.push('plan'); } }).generate({ state: { taskId: 'same-2', tenantId: 't', request: 'QA-SYNTH', capabilities: [{ name: 'edit', description: 'Edit' }] } });
    await createEngineReviewer({ engine: endpoint, fetch: r.fetchImpl, machines, admit: async () => { admitted.push('review'); } }).review({ instructions: 'reviewing', context: '{}', schema: {} });
    return { calls: r.calls, admitted };
  };
  const before = await run(false), after = await run(true);
  assert.deepEqual(after, before);
  assert.ok(before.calls.length >= 4);
  assert.ok(before.calls.filter((c) => c.init.method === 'POST').every((c) => c.init.headers.Authorization === `Bearer ${LOCAL_KEY}`));
  assert.deepEqual(before.admitted, ['role', 'role', 'plan', 'review']);
});

test('startEngineRelayFromEnv: unset is no relay; set binds the code-network name, never all interfaces', async () => {
  const off = startEngineRelayFromEnv({}, { chatMachines: null, target: () => null });
  assert.equal(off.url, null); assert.equal(off.server, null);
  assert.throws(() => startEngineRelayFromEnv({ CODE_ENGINE_RELAY_PORT: '8095', CODE_EGRESS_HOST: 'bad host' }, { target: () => null }), /CODE_ENGINE_RELAY_HOST/);
  const lookups = [];
  const on = startEngineRelayFromEnv({ CODE_ENGINE_RELAY_PORT: '0', CODE_EGRESS_HOST: 'egress' }, { target: () => null });
  assert.equal(on.server, null, 'port 0 is not a port');
  const bound = startEngineRelayFromEnv({ CODE_ENGINE_RELAY_PORT: '18953', CODE_EGRESS_HOST: 'egress' }, { target: () => null,
    lookup: async (h) => { lookups.push(h); return { address: '127.0.0.1' }; } });
  assert.equal(bound.url, 'http://egress:18953/v1');
  await new Promise((r) => bound.server.once('listening', r));
  assert.deepEqual(lookups, ['egress']);
  assert.equal(bound.server.address().address, '127.0.0.1');
  await new Promise((r) => bound.server.close(r));
});
