'use strict';
// #2257: the Code and Browser task reads are the Rust front's. Node refuses them before authentication, keeps the POSTs,
// and offers the front only what it alone knows, as the asking user, on the loopback check.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-task-reads.cjs');
const { createTaskFactsBridge, PATH } = require('./rust-task-facts.cjs');
const { createJobs } = require('./jobs.cjs');
const { createBrowserService } = require('./browser-service.cjs');
const { json, readJson } = require('./http.cjs');

const SECRET = 's'.repeat(40);
const TASK = '0123abcd-0123-4abc-8def-0123456789ab';

test('the reads are refused, whoever asks, and the POSTs beside them are not', () => {
  assert.equal(ROUTE_REFUSAL.code, 'RUST_TASK_READS_OWNED');
  assert.equal(OWNED_ROUTES.size, 5);
  for (const [m, p] of [['GET', '/api/code/active'], ['POST', '/api/code/active'], ['GET', '/api/projects/p/code'], ['GET', `/api/projects/p/code/${TASK}`], ['GET', '/api/projects/p/browser'], ['GET', `/api/projects/p/browser/${TASK}`]]) assert.equal(owned(m, p), true, `${m} ${p}`);
  for (const [m, p] of [['POST', '/api/projects/p/code'], ['POST', '/api/projects/p/browser'], ['POST', `/api/projects/p/code/${TASK}/approve`], ['GET', `/api/projects/p/code/${TASK}/approve`], ['POST', `/api/projects/p/browser/${TASK}/cancel`], ['GET', '/api/projects/p/code/not-a-task'], ['HEAD', '/api/projects/p/code'], ['GET', '/api/code/active/x']]) assert.equal(owned(m, p), false, `${m} ${p}`);
  const seen = [];
  const parseRequestUrl = (req) => new URL(req.url, 'http://localhost');
  assert.equal(refuseOwned({ method: 'GET', url: '/api/code/active' }, {}, { parseRequestUrl, json: (_, s, b) => seen.push([s, b]) }), true);
  assert.deepEqual(seen, [[503, ROUTE_REFUSAL]]);
  assert.equal(refuseOwned({ method: 'GET', url: '/x' }, {}, { parseRequestUrl: () => null, json }), false, 'an unparseable target falls through');
});

test('index.cjs mounts the refusal and the bridge, and the old read branches are gone', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.match(index, /require\('\.\/rust-task-reads\.cjs'\)\.refuseOwned\(req, res, \{ parseRequestUrl, json \}\)/);
  assert.match(index, /await taskFactsBridge\(req, res\)/);
  assert.doesNotMatch(index, /'\/api\/code\/active'/);
  for (const file of ['routes/code.cjs', 'routes/browser.cjs']) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, file), 'utf8'), /service\.(list|get|listActive)\(/, file);
});

async function bridge(deps = {}) {
  const asked = [];
  const handle = createTaskFactsBridge({
    secret: SECRET, json, readJson, log: () => {},
    features: { enabled: (name) => { asked.push(['flag', name]); return (deps.flags ?? { codeHarness: true, browserExecutor: true })[name]; } },
    services: deps.services ?? { code: { facts: (ws) => { asked.push(['facts', ws]); return { approvals: {} }; } }, browser: { facts: () => ({ approvals: {} }) } },
    workspace: () => asked.at(-1)[1],
    asUser: (user, fn) => { asked.push(['user', user]); return fn(); },
  });
  const server = http.createServer(async (req, res) => { if (!await handle(req, res)) { res.statusCode = 599; res.end(); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const call = async (body, { secret = SECRET, method = 'POST', url = PATH } = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { 'x-noevia-store-token': secret }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { asked, call, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('the bridge answers the flag first, then the role, and only an administrator reaches a service, as that user', async () => {
  const b = await bridge();
  try {
    const off = await bridge({ flags: { codeHarness: false } });
    assert.deepEqual((await off.call({ user: 'u1', surface: 'code', admin: true })).body, { enabled: false });
    assert.equal(off.asked.some(([k]) => k === 'user'), false);
    await off.close();
    assert.deepEqual((await b.call({ user: 'u1', surface: 'code', admin: false })).body, { enabled: true });
    assert.equal(b.asked.some(([k]) => k === 'user'), false, 'a member opens nothing');
    assert.deepEqual((await b.call({ user: 'u1', surface: 'code', admin: true })).body, { enabled: true, facts: { approvals: {} } });
    assert.deepEqual(b.asked.at(-2), ['user', 'u1']);
  } finally { await b.close(); }
});

test('the bridge is an unknown path to anyone else, and refuses a malformed call', async () => {
  const b = await bridge();
  try {
    assert.equal((await b.call({ user: 'u1', surface: 'code', admin: true }, { secret: 'wrong' })).status, 404);
    assert.equal((await b.call(null, { method: 'GET' })).status, 404);
    assert.equal((await b.call('{bad')).status, 400);
    assert.equal((await b.call({ surface: 'code' })).status, 400);
    assert.equal((await b.call({ user: 'u1', surface: 'constructor', admin: true })).status, 400);
    assert.equal(b.asked.length, 0);
  } finally { await b.close(); }
});

test('a fault behind the bridge is a 503 that says nothing about it', async () => {
  const b = await bridge({ services: { code: { facts: () => { throw Error('secret detail'); } } } });
  try {
    const r = await b.call({ user: 'u1', surface: 'code', admin: true });
    assert.equal(r.status, 503);
    assert.doesNotMatch(JSON.stringify(r.body), /secret detail/);
  } finally { await b.close(); }
});

test('asking for the facts recovers a task left by a previous process, so the front never reads it as running', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-task-facts-'));
  try {
    const before = createJobs({ dir, kinds: ['browser'] });
    const id = before.create({ kind: 'browser', projectId: 'p1', capabilities: [] });
    before.append(id, 'job.started');
    const service = createBrowserService({ launch: async () => ({}) });
    const facts = service.facts({ dir });
    assert.deepEqual(facts.capabilities, ['open_browser']);
    assert.equal(facts.networkState, 'unconfigured');
    assert.deepEqual(facts.approvals, {});
    const raw = fs.readFileSync(path.join(dir, 'jobs', `${id}.jsonl`), 'utf8');
    assert.match(raw, /job\.interrupted/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
