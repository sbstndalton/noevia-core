'use strict';
// Rust port R7: NOEVIA_CODE_EXECUTOR=rust hands Code tasks to the Rust front. Unset, nothing changes; set, this
// process recovers no code journal, starts, answers and cancels nothing, and only says what the front cannot know.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PATH, REFUSED, frontOwnsCode, createCodeEngineBridge } = require('./rust-code-executor.cjs');
const { createTaskFactsBridge, PATH: FACTS_PATH } = require('./rust-task-facts.cjs');
const { createCodeService } = require('./code-service.cjs');
const { createJobs } = require('./jobs.cjs');
const { json, readJson } = require('./http.cjs');

const SECRET = 's'.repeat(40);

test('only NOEVIA_CODE_EXECUTOR=rust hands Code tasks to the front', () => {
  assert.equal(frontOwnsCode({}), false);
  assert.equal(frontOwnsCode({ NOEVIA_CODE_EXECUTOR: '' }), false);
  assert.equal(frontOwnsCode({ NOEVIA_CODE_EXECUTOR: 'node' }), false);
  assert.equal(frontOwnsCode({ NOEVIA_CODE_EXECUTOR: 'Rust' }), false);
  assert.equal(frontOwnsCode({ NOEVIA_CODE_EXECUTOR: 'rust' }), true);
});

async function serve(handle) {
  const server = http.createServer(async (req, res) => { if (!await handle(req, res)) { res.statusCode = 599; res.end(); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const call = async (body, { secret = SECRET, method = 'POST', url = PATH, headers = {} } = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { 'x-noevia-store-token': secret, ...headers },
      ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call, close: () => new Promise((resolve) => server.close(resolve)) };
}

function engineBridge(over = {}) {
  const seen = [];
  // The lookups answer only inside the caller's scope, as currentWorkspace() does: run outside it, they throw.
  let current = null;
  const scoped = () => { if (!current) throw Error('no request scope'); return current; };
  const handle = createCodeEngineBridge({
    secret: SECRET, json, readJson, log: () => {},
    asUser: async (user, fn) => { seen.push(['user', user]); current = user; try { return await fn(); } finally { current = null; } },
    getProject: (id) => (id === `${scoped()}-project` || (scoped() === 'qa-user' && id === 'qa-project') ? { id, name: 'QA project' } : null),
    engine: over.engine ?? (() => ({ baseUrl: 'http://qa-engine.invalid:8080/v1', apiKey: `${scoped()}-key`, model: 'qa-model', contextTokens: 8192 })),
    machine: over.machine ?? (() => false),
    paused: over.paused ?? (() => false),
    context: over.context ?? ((project) => `QA context for ${project.id} as ${scoped()}`),
    ...(over.role ? { role: over.role } : {}),
    ...(over.roleWanted ? { roleWanted: over.roleWanted } : {}),
  });
  return { seen, handle };
}

test('the engine bridge answers one start\'s facts, as that user, for that user\'s project only', async () => {
  const { seen, handle } = engineBridge();
  const s = await serve(handle);
  try {
    assert.deepEqual(await s.call({ user: 'qa-user', projectId: 'qa-project' }), { status: 200, body: {
      engine: { baseUrl: 'http://qa-engine.invalid:8080/v1', apiKey: 'qa-user-key', model: 'qa-model', contextTokens: 8192 },
      machine: false, paused: false, context: 'QA context for qa-project as qa-user' } });
    assert.deepEqual(seen, [['user', 'qa-user']]);
    assert.deepEqual(await s.call({ user: 'qa-user', projectId: 'elsewhere' }), { status: 404, body: { error: 'project not found' } });
    // Another user's project is not this user's, and that user's own lookups answer as that user.
    assert.deepEqual(await s.call({ user: 'qa-other', projectId: 'qa-project' }), { status: 404, body: { error: 'project not found' } });
    assert.equal((await s.call({ user: 'qa-other', projectId: 'qa-other-project' })).body.context, 'QA context for qa-other-project as qa-other');
  } finally { await s.close(); }
  // On a machine there is no engine here and no pause; unset values are nulls.
  const remote = await serve(engineBridge({ machine: () => true, paused: () => true }).handle);
  try {
    assert.deepEqual((await remote.call({ user: 'qa-user', projectId: 'qa-project' })).body, { engine: null, machine: true, paused: false, context: 'QA context for qa-project as qa-user' });
  } finally { await remote.close(); }
  const bare = await serve(engineBridge({ engine: () => ({ baseUrl: null, model: undefined }), paused: () => true, context: () => undefined }).handle);
  try {
    assert.deepEqual((await bare.call({ user: 'qa-user', projectId: 'qa-project' })).body, {
      engine: { baseUrl: null, apiKey: null, model: null, contextTokens: null }, machine: false, paused: true, context: '' });
  } finally { await bare.close(); }
  const broken = await serve(engineBridge({ engine: () => { throw Error('QA provider store down'); } }).handle);
  try {
    assert.deepEqual(await broken.call({ user: 'qa-user', projectId: 'qa-project' }), { status: 503, body: { error: 'Code engine facts are unavailable.' } });
  } finally { await broken.close(); }
});

test('with `role` the engine bridge also answers the role engine\'s endpoint, and nothing of the provider but its schema capability', async () => {
  const role = () => ({ baseUrl: 'http://qa-provider.invalid:8080/v1', apiKey: 'qa-provider-key', model: 'qa-model', external: false,
    provider: { id: 'qa-provider', apiKey: 'qa-provider-key', capabilities: { jsonSchemaParam: true } } });
  const wanted = () => true;
  const s = await serve(engineBridge({ role, roleWanted: wanted }).handle);
  try {
    assert.deepEqual((await s.call({ user: 'qa-user', projectId: 'qa-project' })).body.role,
      { baseUrl: 'http://qa-provider.invalid:8080/v1', apiKey: 'qa-provider-key', model: 'qa-model', external: false, jsonSchema: true });
  } finally { await s.close(); }
  // An external provider's key stays here.
  const external = await serve(engineBridge({ role: () => ({ ...role(), external: true }), roleWanted: wanted }).handle);
  try {
    assert.deepEqual((await external.call({ user: 'qa-user', projectId: 'qa-project' })).body.role,
      { baseUrl: 'http://qa-provider.invalid:8080/v1', apiKey: null, model: 'qa-model', external: true, jsonSchema: true });
  } finally { await external.close(); }
  // With the pipeline and the Planner review off (or unsaid), no role at all, and the role is never read.
  let read = 0;
  for (const roleWanted of [() => false, undefined]) {
    const off = await serve(engineBridge({ role: () => { read++; return role(); }, roleWanted }).handle);
    try {
      const body = (await off.call({ user: 'qa-user', projectId: 'qa-project' })).body;
      assert.equal('role' in body, false);
      assert.equal(body.machine, false);
    } finally { await off.close(); }
  }
  assert.equal(read, 0);
  const bare = await serve(engineBridge({ role: () => ({ external: 'yes' }), roleWanted: wanted }).handle);
  try {
    assert.deepEqual((await bare.call({ user: 'qa-user', projectId: 'qa-project' })).body.role,
      { baseUrl: null, apiKey: null, model: null, external: false, jsonSchema: false });
  } finally { await bare.close(); }
  const remote = await serve(engineBridge({ role, roleWanted: wanted, machine: () => true }).handle);
  try { assert.equal((await remote.call({ user: 'qa-user', projectId: 'qa-project' })).body.role, null); } finally { await remote.close(); }
});

test('the engine bridge is an unknown path to anyone else, and refuses a malformed call', async () => {
  const s = await serve(engineBridge().handle);
  try {
    assert.equal((await s.call({}, { url: '/internal/code/other' })).status, 599, 'another path is not this bridge\'s');
    assert.deepEqual(await s.call({ user: 'qa-user', projectId: 'qa-project' }, { secret: 'wrong' }), { status: 404, body: { error: 'Not found' } });
    assert.deepEqual(await s.call({ user: 'qa-user', projectId: 'qa-project' }, { headers: { 'x-forwarded-for': '203.0.113.9' } }), { status: 404, body: { error: 'Not found' } });
    assert.deepEqual(await s.call(null, { method: 'GET' }), { status: 404, body: { error: 'Not found' } });
    assert.deepEqual(await s.call('{'), { status: 400, body: { error: 'invalid JSON' } });
    for (const body of [{}, { user: 'qa-user' }, { projectId: 'qa-project' }, { user: '', projectId: 'qa-project' }, { user: 'qa-user', projectId: 7 }]) {
      assert.deepEqual(await s.call(body), { status: 400, body: { error: 'A user and a project are required.' } }, JSON.stringify(body));
    }
  } finally { await s.close(); }
});

test('with the front owning Code, the facts bridge answers the flag only and opens no store', async () => {
  const opened = [];
  const handle = createTaskFactsBridge({
    secret: SECRET, json, readJson, log: () => {}, frontOwns: () => true,
    features: { enabled: () => true },
    services: { code: { facts: () => { opened.push('code'); return { approvals: {} }; } }, browser: { facts: () => { opened.push('browser'); return { approvals: {} }; } } },
    workspace: () => ({}), asUser: (user, fn) => fn(),
  });
  const s = await serve(handle);
  try {
    assert.deepEqual((await s.call({ user: 'u1', surface: 'code', admin: true }, { url: FACTS_PATH })).body, { enabled: true, owner: 'front' });
    assert.deepEqual((await s.call({ user: 'u1', surface: 'code', admin: false }, { url: FACTS_PATH })).body, { enabled: true });
    assert.deepEqual(opened, []);
    assert.deepEqual((await s.call({ user: 'u1', surface: 'browser', admin: true }, { url: FACTS_PATH })).body, { enabled: true, facts: { approvals: {} } });
    assert.deepEqual(opened, ['browser'], 'Browser mode is not the front\'s');
  } finally { await s.close(); }
});

function tenant() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-code-owner-'));
  // A task the front is running: created and started, not ended.
  const jobs = createJobs({ dir, kinds: ['code'] });
  const id = jobs.create({ kind: 'code', projectId: 'qa-project', capabilities: ['read_repository'] });
  jobs.append(id, 'job.started');
  // ...and its workspace, held by the front (an epoch that is not this process's).
  const tree = path.join(dir, 'qa-tree');
  fs.mkdirSync(tree);
  fs.mkdirSync(path.join(dir, 'code-workspaces'));
  fs.writeFileSync(path.join(dir, 'code-workspaces', `${id}.json`), JSON.stringify({ taskId: id, repo: tree, branch: 'qa/front', path: tree,
    status: 'held', mode: 'worktree', baseSha: null, capabilities: ['read_repository'], domains: [], pinned: [], epoch: 'front-qa', claimedAt: 1 }));
  return { dir, id };
}
const recordOf = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, 'code-workspaces', `${id}.json`), 'utf8'));

test('a service the front owns recovers nothing and refuses every task action; reads still answer', async () => {
  const { dir, id } = tenant();
  try {
    const service = createCodeService({ repos: [], connect: () => { throw Error('no harness in this test'); }, frontOwned: true });
    const workspace = { dir, userId: 'qa-user' };
    const project = { id: 'qa-project' };
    assert.equal(service.get(workspace, project, id).status, 'running', 'the front\'s live task is not marked interrupted');
    assert.equal(service.list(workspace, project)[0].status, 'running');
    assert.equal(recordOf(dir, id).status, 'held', 'the front\'s workspace is not recovered');
    for (const act of [() => service.start(workspace, project, { repository: 'x', prompt: 'QA' }), () => service.decide(workspace, project, id, 'approve', 'x'), () => service.cancel(workspace, project, id)]) {
      await assert.rejects(async () => act(), (e) => e.status === 409 && e.publicMessage === REFUSED);
    }
    assert.equal(service.get(workspace, project, id).status, 'running', 'the refused cancel changed nothing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // Unset, the same journal is recovered as today: a task from a process that no longer exists is interrupted.
  const other = tenant();
  try {
    const service = createCodeService({ repos: [], connect: () => { throw Error('no harness in this test'); } });
    assert.equal(service.get({ dir: other.dir, userId: 'qa-user' }, { id: 'qa-project' }, other.id).status, 'interrupted');
    assert.equal(recordOf(other.dir, other.id).status, 'interrupted');
  } finally { fs.rmSync(other.dir, { recursive: true, force: true }); }
});

test('index.cjs reads the switch once for the service, the facts bridge and the engine bridge', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.match(index, /frontOwned: codeExecutor\.frontOwnsCode\(\)/);
  assert.match(index, /frontOwns: \(\) => codeExecutor\.frontOwnsCode\(\)/);
  assert.match(index, /if \(codeExecutor\.frontOwnsCode\(\) && await codeEngineBridge\(req, res\)\) return;/);
  assert.match(index, /context: \(project\) => codeSharedContext\(currentWorkspace\(\), project\), role: codeRoleEndpoint,\n  roleWanted: \(\) => features\.enabled\('codePipeline'\) \|\| features\.enabled\('plannerReview'\),\n\}\);/);
});
