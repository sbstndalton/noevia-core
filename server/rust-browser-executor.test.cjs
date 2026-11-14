'use strict';
// Rust port R5 (shift 2): NOEVIA_RUST_BROWSER=1 hands Browser tasks to the Rust front. Unset, nothing changes; set,
// this process recovers no browser journal, starts, runs, answers, finishes and cancels nothing, the facts bridge
// answers the flag only, and Browser mode's availability is the front's engine (NOEVIA_BROWSER_ENGINE).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { REFUSED, NO_ENGINE, frontOwnsBrowser, nativeBrowserReason } = require('./rust-browser-executor.cjs');
const { createTaskFactsBridge, PATH: FACTS_PATH } = require('./rust-task-facts.cjs');
const { createBrowserService } = require('./browser-service.cjs');
const { createJobs } = require('./jobs.cjs');
const { REGISTRY } = require('./features.cjs');
const { json, readJson } = require('./http.cjs');

const SECRET = 's'.repeat(40);

test('only NOEVIA_RUST_BROWSER=1 hands Browser tasks to the front', () => {
  assert.equal(frontOwnsBrowser({}), false);
  assert.equal(frontOwnsBrowser(undefined), false);
  for (const value of ['', '0', 'true', 'rust', ' 1', '1 ', 'yes']) assert.equal(frontOwnsBrowser({ NOEVIA_RUST_BROWSER: value }), false, value);
  assert.equal(frontOwnsBrowser({ NOEVIA_RUST_BROWSER: '1' }), true);
});

test('owned by the front, Browser mode is available exactly when the front has an engine', () => {
  assert.equal(nativeBrowserReason({}), NO_ENGINE);
  assert.equal(nativeBrowserReason({ NOEVIA_BROWSER_ENGINE: '  ' }), NO_ENGINE);
  assert.equal(nativeBrowserReason({ NOEVIA_BROWSER_ENGINE: 'ws://qa-chromium.invalid:9222' }), null);
  const probe = REGISTRY.browserExecutor.unavailable;
  assert.equal(probe({ NOEVIA_RUST_BROWSER: '1' }), NO_ENGINE);
  assert.equal(probe({ NOEVIA_RUST_BROWSER: '1', NOEVIA_BROWSER_ENGINE: 'ws://qa-chromium.invalid:9222' }), null);
  // Unset, the probe is this process's Playwright check, whatever the engine says.
  assert.equal(probe({ NOEVIA_BROWSER_ENGINE: 'ws://qa-chromium.invalid:9222' }), require('./features.cjs').browserRuntimeReason());
});

test('the feature runtime\'s boot facts read the native engine when the front owns Browser mode', () => {
  // createReadOnlyFeatures maps the exact reason texts to its boot facts and refuses any other: the switch's reason
  // must stay one it knows (review of noevia-core#383).
  const Database = require('better-sqlite3');
  const { createReadOnlyFeatures } = require('./features.cjs');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value)');
  const availability = Object.fromEntries(['stepSupervision', 'toolGate', 'systemOneRouting', 'chatFraming', 'framingReasoner'].map((n) => [n, () => null]));
  try {
    const boot = (env) => createReadOnlyFeatures({ db, env, availability, runtime: () => null }).bootFacts.browser;
    assert.equal(boot({ NOEVIA_RUST_BROWSER: '1' }), 'chromium');
    assert.equal(boot({ NOEVIA_RUST_BROWSER: '1', NOEVIA_BROWSER_ENGINE: 'ws://qa-chromium.invalid:9222' }), 'available');
  } finally { db.close(); }
});

async function serve(handle) {
  const server = http.createServer(async (req, res) => { if (!await handle(req, res)) { res.statusCode = 599; res.end(); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const call = async (body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${FACTS_PATH}`, { method: 'POST',
      headers: { 'x-noevia-store-token': SECRET }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('with the front owning Browser mode, the facts bridge answers the flag only and opens no store', async () => {
  const opened = [];
  let enabled = true;
  const handle = createTaskFactsBridge({
    secret: SECRET, json, readJson, log: () => {}, browserOwns: () => true,
    features: { enabled: () => enabled },
    services: { code: { facts: () => { opened.push('code'); return { approvals: {} }; } }, browser: { facts: () => { opened.push('browser'); return { approvals: {} }; } } },
    workspace: () => ({}), asUser: (user, fn) => fn(),
  });
  const s = await serve(handle);
  try {
    assert.deepEqual((await s.call({ user: 'qa-admin', surface: 'browser', admin: true })).body, { enabled: true, owner: 'front' });
    assert.deepEqual((await s.call({ user: 'qa-member', surface: 'browser', admin: false })).body, { enabled: true });
    assert.deepEqual(opened, []);
    assert.deepEqual((await s.call({ user: 'qa-admin', surface: 'code', admin: true })).body, { enabled: true, facts: { approvals: {} } });
    assert.deepEqual(opened, ['code'], 'Code mode is not the front\'s here');
    enabled = false;
    assert.deepEqual((await s.call({ user: 'qa-admin', surface: 'browser', admin: true })).body, { enabled: false });
  } finally { await s.close(); }
});

function tenant() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-browser-owner-'));
  // A task the front is running: created and started, not ended.
  const jobs = createJobs({ dir, kinds: ['browser'] });
  const id = jobs.create({ kind: 'browser', projectId: 'qa-project', capabilities: ['open_browser'] });
  jobs.append(id, 'job.started');
  return { dir, id };
}

test('a service the front owns recovers nothing and refuses every task action; reads still answer', async () => {
  const launch = () => { throw Error('no browser in this test'); };
  const { dir, id } = tenant();
  try {
    const service = createBrowserService({ launch, frontOwned: true });
    const workspace = { dir }, project = { id: 'qa-project' };
    assert.equal(service.get(workspace, project, id).status, 'running', 'the front\'s live task is not marked interrupted');
    assert.equal(service.list(workspace, project)[0].status, 'running');
    for (const act of [
      () => service.start(workspace, project, { domains: ['shop.example.test'] }),
      () => service.act(workspace, project, id, { type: 'extract' }),
      () => service.decide(workspace, project, id, 'approve', 'x'),
      () => service.finish(workspace, project, id, null),
      () => service.cancel(workspace, project, id),
    ]) {
      await assert.rejects(async () => act(), (e) => e.status === 409 && e.publicMessage === REFUSED);
    }
    assert.equal(service.get(workspace, project, id).status, 'running', 'the refused cancel changed nothing');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['jobs'], 'no downloads directory was made');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // Unset, the same journal is recovered as today: a task from a process that no longer exists is interrupted.
  const other = tenant();
  try {
    const service = createBrowserService({ launch });
    assert.equal(service.get({ dir: other.dir }, { id: 'qa-project' }, other.id).status, 'interrupted');
  } finally { fs.rmSync(other.dir, { recursive: true, force: true }); }
});

test('index.cjs reads the switch once for the service and the facts bridge', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.match(index, /const browserExecutor = require\('\.\/rust-browser-executor\.cjs'\);/);
  assert.match(index, /createBrowserService\(\{\n  frontOwned: browserExecutor\.frontOwnsBrowser\(\),/);
  assert.match(index, /browserOwns: \(\) => browserExecutor\.frontOwnsBrowser\(\),/);
});
