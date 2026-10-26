'use strict';
// sbstndalton/noevia#1264: Node's projects.json / free-chats.json saves through the Rust front's
// internal store (project-store-client.cjs). A loopback stand-in for the store (same protocol and
// compare-and-swap as noevia-rs src/project_store.rs, which has its own HTTP tests) records every
// write. Off: the flock path, unchanged. On: no flock child is spawned (flock is not even on PATH)
// and the files are written only by the store. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const psc = require('./project-store-client.cjs');
const rp = require('./rust-projects.cjs');
const { createWorkspaceStore } = require('./workspace.cjs');

const USER = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'synthetic-store-token-0123456789abcdef';
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

/** The store's protocol over real files; `writes` counts the files it wrote. */
async function fakeStore(root) {
  const writes = [];
  const fileOf = (user, file) => path.join(root, 'users', user, file);
  const now = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers['x-noevia-store-token'] !== TOKEN) return send(401, { error: 'unauthorised' });
      const b = JSON.parse(raw);
      const f = fileOf(b.user, b.file);
      const text = now(f);
      const version = text === null ? '' : sha(text);
      if (req.url === '/v1/read') return send(200, { version, text });
      if (b.version !== version) return send(409, { version, text });
      fs.writeFileSync(`${f}.store.tmp`, b.text); fs.renameSync(`${f}.store.tmp`, f);
      writes.push(b.file);
      return send(200, { version: sha(b.text) });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, writes, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/** A direct compare-and-swap edit, as a Rust native route would make it. */
async function nativeEdit(client, file, edit) {
  for (;;) {
    const snap = await client.read(USER, file);
    const out = edit(snap.text === null ? null : JSON.parse(snap.text));
    if ((await client.write(USER, file, snap.version, JSON.stringify(out, null, 2))).ok) return;
  }
}

function withoutFlock(fn) {
  const saved = process.env.PATH;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-flock-'));
  process.env.PATH = empty;
  return Promise.resolve().then(fn).finally(() => { process.env.PATH = saved; });
}

const ON = { NOEVIA_PROJECT_STORE_PORT: '19021', NOEVIA_PROJECT_STORE_TOKEN: TOKEN };

test('the store is permanent: used with a port and the secret alone; the retired switches and confirmations are never read (#1071)', () => {
  const warned = [];
  const warn = (m) => warned.push(m);
  assert.equal(psc.enabledFrom(ON, warn), true);
  // Whatever the retired switches and confirmations say, set or not.
  for (const k of ['NOEVIA_RUST_PROJECT_STORE', 'NOEVIA_RUST_PROJECTS', 'NOEVIA_RUST_PROJECTS_CONFIRMED', 'NOEVIA_RUST_FREE_CHATS_CONFIRMED', 'NOEVIA_RUST_PROJECT_CHATS_CONFIRMED', 'NOEVIA_RUST_PROJECT_STORE_CONFIRMED']) {
    for (const v of ['0', 'true', '', '1']) assert.equal(psc.enabledFrom({ ...ON, [k]: v }, warn), true, `${k}=${v}`);
  }
  assert.equal(warned.length, 0);
  // Without the port or the secret there is no store, and it says so (index.cjs then refuses to start).
  for (const drop of ['NOEVIA_PROJECT_STORE_PORT', 'NOEVIA_PROJECT_STORE_TOKEN']) {
    const env = { ...ON }; delete env[drop];
    assert.equal(psc.enabledFrom(env, warn), false, drop);
  }
  assert.equal(warned.length, 2);
  for (const port of ['0', '65536', 'x', '']) assert.equal(psc.enabledFrom({ ...ON, NOEVIA_PROJECT_STORE_PORT: port }, () => {}), false, port);
  assert.equal(psc.enabledFrom({ ...ON, NOEVIA_PROJECT_STORE_TOKEN: 'short' }, () => {}), false);
  const src = fs.readFileSync(path.join(__dirname, 'project-store-client.cjs'), 'utf8') + fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.equal(/env\.NOEVIA_RUST_PROJECT_STORE\b(?!_)/.test(src), false, 'no source reads the retired switch');
  assert.equal(/NOEVIA_RUST_PROJECT_STORE_CONFIRMED|NOEVIA_RUST_FREE_CHATS_CONFIRMED|NOEVIA_RUST_PROJECTS_CONFIRMED/.test(src), false, 'nor a retired confirmation');
});

test('source start retries a lost reply with the same request key and never creates a second job', async () => {
  for (const lost of ['transport', 'empty-200']) {
    const calls = [], committed = new Map();
    const fetchImpl = async (url, init) => {
      assert.match(url, /\/v1\/source-jobs\/start$/);
      const body = JSON.parse(init.body);
      calls.push(body);
      if (!committed.has(body.request)) committed.set(body.request, { id: '11111111-1111-4111-8111-111111111111', run: '22222222-2222-4222-8222-222222222222' });
      if (calls.length === 1 && lost === 'transport') throw Error('reply lost after commit');
      return new Response(calls.length === 1 && lost === 'empty-200' ? '' : JSON.stringify(committed.get(body.request)), { status: 200 });
    };
    const client = psc.createClient({ port: 1, token: TOKEN, fetchImpl }).sourceJobsFor(USER);
    const owner = { start: 'a'.repeat(32), born: '100', owner: '33333333-3333-4333-8333-333333333333' };
    const request = '44444444-4444-4444-8444-444444444444';
    const job = await client.start(owner, 'project', request);
    assert.equal(job.id, committed.get(request).id);
    assert.equal(committed.size, 1, lost);
    assert.equal(calls.length, 2, lost);
    assert.deepEqual(calls[0], calls[1], lost);
  }
});

test('research report retries a malformed 200 acknowledgement with the exact result', async () => {
  const calls = [];
  const client = psc.createClient({ port: 1, token: TOKEN, fetchImpl: async (url, init) => {
    assert.match(url, /\/v1\/research-jobs\/report$/);
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify(calls.length === 1 ? {} : { ok: true }), { status: 200 });
  } }).researchJobsFor(USER);
  const owner = { start: 'a'.repeat(32), born: '100', owner: '33333333-3333-4333-8333-333333333333' };
  const result = { markdown: '# Report', sources: [] };
  assert.deepEqual(await client.report(owner, '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', result), { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1], 'the exact committed report is retried, never replaced');
});

test('research report and cancel refuse repeated malformed 200 replies', async () => {
  const owner = { start: 'a'.repeat(32), born: '100', owner: '33333333-3333-4333-8333-333333333333' };
  const id = '11111111-1111-4111-8111-111111111111';
  const run = '22222222-2222-4222-8222-222222222222';
  for (const op of ['report', 'cancel']) {
    const calls = [];
    const client = psc.createClient({ port: 1, token: TOKEN, fetchImpl: async (url, init) => {
      assert.match(url, new RegExp(`/v1/research-jobs/${op}$`));
      calls.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    } }).researchJobsFor(USER);
    const action = op === 'report'
      ? client.report(owner, id, run, { markdown: '# Report', sources: [] })
      : client.cancel(owner, 'project-a', id, run);
    await assert.rejects(action, (error) => error.status === 503);
    assert.equal(calls.length, 2, op);
    assert.deepEqual(calls[0], calls[1], op);
  }
});

test('research cancel retries a malformed snapshot and accepts only the bound job', async () => {
  const calls = [];
  const owner = { start: 'a'.repeat(32), born: '100', owner: '33333333-3333-4333-8333-333333333333' };
  const id = '11111111-1111-4111-8111-111111111111';
  const run = '22222222-2222-4222-8222-222222222222';
  const client = psc.createClient({ port: 1, token: TOKEN, fetchImpl: async (url, init) => {
    assert.match(url, /\/v1\/research-jobs\/cancel$/);
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify(calls.length === 1
      ? { id, projectId: 'another-project', kind: 'deep_research', status: 'running' }
      : { id, projectId: 'project-a', kind: 'deep_research', status: 'running' }), { status: 200 });
  } }).researchJobsFor(USER);
  assert.equal((await client.cancel(owner, 'project-a', id, run)).projectId, 'project-a');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
});

test('no flock path is left: a coordinated file without the store is refused', () => {
  assert.throws(() => rp.createProjectsFile('/nonexistent/projects.json', {}), /Rust project store/);
  assert.throws(() => rp.createFreeChatsFile('/nonexistent/free-chats.json', {}), /Rust project store/);
  assert.equal(rp.withFileLock, undefined);
});

test('on: a whole workspace saves both files only through the store, with no flock on PATH, and responses can wait for it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-ws-'));
  fs.mkdirSync(path.join(root, 'users', USER), { recursive: true });
  const store = await fakeStore(root);
  const writeFileSync = fs.writeFileSync;
  const nodeWrites = [];
  fs.writeFileSync = function spy(f, ...rest) { if (/(projects|free-chats)\.json/.test(String(f)) && !String(f).endsWith('.store.tmp')) nodeWrites.push(String(f)); return writeFileSync.call(this, f, ...rest); };
  try {
    await withoutFlock(async () => {
      const client = psc.createClient({ port: store.port, token: TOKEN });
      const ws = createWorkspaceStore(root, { id: 'local', label: 'Local', baseUrl: '', apiKey: '' }, null, { projectStore: client }).get(USER);
      ws.projects.push({ id: 'p1', name: 'One', chats: [], instructionSkills: {} });
      const a = ws.saveProjects();
      ws.freeChats.push({ id: 'f1', title: 'F', updatedAt: 1 });
      const b = ws.saveFreeChats();
      assert.ok(ws.pendingStoreWrites(), 'in flight');
      await Promise.all([a, b]);
      await ws.pendingStoreWrites();
      assert.equal(ws.pendingStoreWrites(), null);
    });
    assert.deepEqual(nodeWrites, [], 'Node wrote neither file');
    assert.deepEqual(store.writes.sort(), ['free-chats.json', 'projects.json']);
    const dir = path.join(root, 'users', USER);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8')).projects.map((p) => p.id), ['p1']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'free-chats.json'), 'utf8')).map((c) => c.id), ['f1']);
    assert.equal(fs.existsSync(path.join(dir, 'projects.json.lock')), false, 'no flock file either');
  } finally { fs.writeFileSync = writeFileSync; await store.close(); }
});

test('concurrency: N Node saves from two workspace views plus native writes lose no update', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-race-'));
  fs.mkdirSync(path.join(root, 'users', USER), { recursive: true });
  const store = await fakeStore(root);
  try {
    const client = psc.createClient({ port: store.port, token: TOKEN });
    // Two processes' views of one account (two stores), each with its own cache and queue.
    const views = [0, 1].map(() => createWorkspaceStore(root, { id: 'local', label: 'Local', baseUrl: '', apiKey: '' }, null, { projectStore: client }).get(USER));
    const saves = [];
    for (let i = 0; i < 12; i += 1) {
      for (const [v, ws] of views.entries()) {
        ws.projects.push({ id: `node-${v}-${i}`, chats: [], instructionSkills: {} });
        saves.push(ws.saveProjects());
        ws.freeChats.push({ id: `free-${v}-${i}`, updatedAt: i });
        saves.push(ws.saveFreeChats());
      }
      saves.push(nativeEdit(client, 'projects.json', (v) => ({ projects: [...((v && v.projects) || []), { id: `rust-${i}`, chats: [] }] })));
      saves.push(nativeEdit(client, 'free-chats.json', (v) => [...(v || []), { id: `rust-free-${i}`, updatedAt: 0 }]));
    }
    await Promise.all(saves);
    // A last save from each view takes in whatever it had not merged yet.
    for (const ws of views) { await ws.saveProjects(); await ws.saveFreeChats(); }
    const dir = path.join(root, 'users', USER);
    const projects = new Set(JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8')).projects.map((p) => p.id));
    const free = new Set(JSON.parse(fs.readFileSync(path.join(dir, 'free-chats.json'), 'utf8')).map((c) => c.id));
    for (let i = 0; i < 12; i += 1) {
      for (const v of [0, 1]) { assert.ok(projects.has(`node-${v}-${i}`), `node-${v}-${i}`); assert.ok(free.has(`free-${v}-${i}`), `free-${v}-${i}`); }
      assert.ok(projects.has(`rust-${i}`), `rust-${i}`);
      assert.ok(free.has(`rust-free-${i}`), `rust-free-${i}`);
    }
    assert.equal(projects.size, 36);
    assert.equal(free.size, 36);
  } finally { await store.close(); }
});

test('the store\'s errors become Node\'s: busy 503 PROJECTS_BUSY, removed account 410, unreachable busy; bounded retries', async () => {
  const answers = [];
  const fetchImpl = async () => { const a = answers.shift(); if (a instanceof Error) throw a; return { status: a.status, json: async () => a.body }; };
  const client = psc.createClient({ port: 1, token: TOKEN, fetchImpl });
  answers.push({ status: 503, body: { error: 'The project store is busy. Try again shortly.', code: 'PROJECTS_BUSY' } });
  await assert.rejects(client.read(USER, 'projects.json'), (e) => e.status === 503 && e.code === 'PROJECTS_BUSY');
  answers.push({ status: 410, body: { error: 'account no longer exists' } });
  await assert.rejects(client.write(USER, 'projects.json', '', '{}'), (e) => e.status === 410 && e.message === 'account no longer exists');
  answers.push(new Error('ECONNREFUSED'));
  await assert.rejects(client.read(USER, 'projects.json'), (e) => e.code === 'PROJECTS_BUSY');
  await assert.rejects(client.read(USER, '../cowork.db'), /not a store file/);
  // Always a conflict: the save gives up after MAX_ATTEMPTS with PROJECTS_BUSY.
  let reads = 0;
  const conflicting = { read: async () => { reads += 1; return { version: String(reads), text: '{"projects":[]}' }; }, write: async () => ({ conflict: true, version: 'x', text: null }) };
  const f = rp.createProjectsFile('/nonexistent/projects.json', { atomicJson() {}, remote: { client: conflicting, user: USER, queue: psc.createQueue() } });
  await assert.rejects(f.save([{ id: 'p' }]), (e) => e.code === 'PROJECTS_BUSY');
  assert.equal(reads, psc.MAX_ATTEMPTS);
});

// ── #1264 review: a save that fails is the request's error, and memory goes back to the disk ──

/** A store whose writes answer `status` (503 busy, 409 conflict forever) or that is down. */
async function failingStore(root, mode) {
  const s = await fakeStore(root);
  if (mode === 'down') { await s.close(); return s; }
  s.server.removeAllListeners('request');
  s.server.on('request', (req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const b = JSON.parse(raw);
      const f = path.join(root, 'users', b.user, b.file);
      const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
      const version = text === null ? '' : sha(text);
      res.writeHead(req.url === '/v1/read' ? 200 : mode === 'busy' ? 503 : 409, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/v1/read' ? { version, text }
        : mode === 'busy' ? { error: 'The project store is busy. Try again shortly.', code: 'PROJECTS_BUSY' } : { version: `${version}x`, text }));
    });
  });
  return s;
}

/** A request as index.cjs runs it: its saves counted, its answer held (holdForStoreSaves). */
async function request(port, route) {
  const server = http.createServer((req, res) => {
    const saves = [];
    psc.holdForStoreSaves(res, saves);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    route(saves, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/`);
    return { status: r.status, headers: r.headers, body: await r.json() };
  } finally { await new Promise((r) => server.close(r)); }
}

for (const mode of ['busy', 'conflict', 'down']) {
  test(`store ${mode}: the route answers 503 PROJECTS_BUSY and a fresh read shows the old state`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `store-fail-${mode}-`));
    const dir = path.join(root, 'users', USER);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ projects: [{ id: 'p1', name: 'Before', chats: [], instructionSkills: {} }] }, null, 2));
    const store = await failingStore(root, mode);
    try {
      let collect = null;
      const client = psc.createClient({ port: store.port, token: TOKEN, timeoutMs: 2000 });
      const wsStore = createWorkspaceStore(root, { id: 'local', label: 'Local', baseUrl: '', apiKey: '' }, null, { projectStore: client, onStoreSave: (p) => collect && collect.push(p) });
      const res = await request(store.port, (saves, out) => {
        collect = saves;
        const ws = wsStore.get(USER);
        ws.projects[0].name = 'After';
        ws.saveProjects();
        collect = null;
        out.writeHead(200, { 'Content-Type': 'application/json' });
        out.end(JSON.stringify({ ok: true }));
      });
      assert.equal(res.status, 503);
      assert.deepEqual(res.body, { error: 'The project store is busy. Try again shortly.', code: 'PROJECTS_BUSY' });
      assert.equal(res.headers.get('retry-after'), '1');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', 'headers set before the route stay');
      // Memory agrees with the disk again: the next access reads the file.
      assert.equal(wsStore.get(USER).projects[0].name, 'Before');
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8')).projects[0].name, 'Before');
    } finally { if (mode !== 'down') await store.close(); }
  });
}

test('a save queued behind a failed one never writes the failed change later', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-poison-'));
  fs.mkdirSync(path.join(root, 'users', USER), { recursive: true });
  const store = await fakeStore(root);
  try {
    let fail = true;
    const real = psc.createClient({ port: store.port, token: TOKEN });
    const client = { read: real.read, write: async (...a) => { if (fail) throw psc.busy(); return real.write(...a); } };
    const ws = createWorkspaceStore(root, { id: 'local', label: 'Local', baseUrl: '', apiKey: '' }, null, { projectStore: client }).get(USER);
    ws.projects.push({ id: 'lost', chats: [], instructionSkills: {} });
    const first = ws.saveProjects();
    const second = ws.saveProjects();
    await assert.rejects(first, (e) => e.code === 'PROJECTS_BUSY');
    fail = false;
    await assert.rejects(second, (e) => e.code === 'PROJECTS_BUSY');
    await assert.rejects(ws.saveProjects(), (e) => e.code === 'PROJECTS_BUSY');
    assert.deepEqual(store.writes, [], 'the stale view wrote nothing');
  } finally { await store.close(); }
});

test('success is unchanged: the held answer goes out as written, after the save', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-ok-'));
  fs.mkdirSync(path.join(root, 'users', USER), { recursive: true });
  const store = await fakeStore(root);
  try {
    let collect = null;
    const client = psc.createClient({ port: store.port, token: TOKEN });
    const wsStore = createWorkspaceStore(root, { id: 'local', label: 'Local', baseUrl: '', apiKey: '' }, null, { projectStore: client, onStoreSave: (p) => collect && collect.push(p) });
    const res = await request(store.port, (saves, out) => {
      collect = saves;
      const ws = wsStore.get(USER);
      ws.projects.push({ id: 'p2', chats: [], instructionSkills: {} });
      ws.saveProjects();
      collect = null;
      out.writeHead(201, { 'Content-Type': 'application/json', 'X-Route': 'yes' });
      out.end(JSON.stringify({ created: 'p2' }));
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { created: 'p2' });
    assert.equal(res.headers.get('x-route'), 'yes');
    assert.deepEqual(store.writes, ['projects.json'], 'written before the answer');
  } finally { await store.close(); }
});

test('a streamed answer is not held; with no saves nothing waits', async () => {
  const res = await request(1, (_saves, out) => { out.writeHead(200, { 'Content-Type': 'application/json' }); out.write('{"a"'); out.end(':1}'); });
  assert.deepEqual([res.status, res.body], [200, { a: 1 }]);
});

test('a request start does not take this process\'s own store save for the other writer\'s; a native write it does', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-stamp-'));
  fs.mkdirSync(path.join(root, 'users', USER), { recursive: true });
  const store = await fakeStore(root);
  try {
    const changed = [];
    const client = psc.createClient({ port: store.port, token: TOKEN });
    const wsStore = createWorkspaceStore(root, { id: 'local', label: 'Local', baseUrl: '', apiKey: '' }, null, { projectStore: client, onProjectsChanged: (id) => changed.push(id) });
    const ws = wsStore.get(USER);
    ws.projects.push({ id: 'p1', chats: [], instructionSkills: {} });
    await ws.saveProjects();
    ws.freeChats.push({ id: 'f1', updatedAt: 1 });
    await ws.saveFreeChats();
    wsStore.get(USER);
    assert.deepEqual(changed, [], 'own saves');
    await nativeEdit(client, 'projects.json', (v) => ({ projects: [...v.projects, { id: 'rust', chats: [] }] }));
    wsStore.get(USER);
    assert.deepEqual(changed, [USER]);
    assert.deepEqual(ws.projects.map((p) => p.id), ['p1', 'rust']);
  } finally { await store.close(); }
});

test('the queue: a save that settled is no longer pending for the code awaiting it', async () => {
  const q = psc.createQueue();
  const p = q.run('k', async () => 1);
  assert.ok(q.pending());
  assert.equal(await p, 1);
  assert.equal(q.pending(), null);
  const f = q.run('k', async () => { throw psc.busy(); });
  await assert.rejects(f);
  assert.equal(q.pending(), null);
  // A not-yet-started save is shared.
  let runs = 0;
  const gate = q.run('a', () => new Promise((r) => setTimeout(r, 20)));
  const one = q.run('b', async () => { runs += 1; });
  const two = q.run('b', async () => { runs += 1; });
  assert.equal(one, two);
  await Promise.all([gate, one]);
  assert.equal(runs, 1);
});

// sbstndalton/noevia#1071 slice 4: the transcript ops over HTTP (the loopback stand-in of the Rust store,
// tests/server/project-store-server.cjs, same protocol as noevia-rs src/project_store.rs /v1/history/*).
test('#1071 slice 4: transcripts are read and written through the store, bound to one account, fail closed', async (t) => {
  const { startProjectStore } = require('../tests/server/project-store-server.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-history-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const OTHER = '99999999-2222-4333-8444-555555555555';
  for (const u of [USER, OTHER]) fs.mkdirSync(path.join(root, 'users', u), { recursive: true });
  const store = await startProjectStore(root);
  t.after(() => store.close());
  const client = psc.createClient({ port: store.port, token: store.token, timeoutMs: 2000 });
  const mine = psc.transcriptsFor(client, USER), theirs = psc.transcriptsFor(client, OTHER);
  const empty = await mine.read('c1');
  assert.deepEqual(empty, { history: [], revision: sha('[]'), exists: false });
  const saved = await mine.write('c1', [{ role: 'user', content: 'qa mine' }], { baseRevision: empty.revision });
  assert.deepEqual(saved, { ok: true, revision: sha(JSON.stringify([{ role: 'user', content: 'qa mine' }])) });
  const stale = await mine.write('c1', ['qa other'], { baseRevision: empty.revision });
  assert.equal(stale.conflict, true);
  assert.deepEqual(stale.history, [{ role: 'user', content: 'qa mine' }]);
  assert.equal(stale.revision, saved.revision);
  assert.deepEqual(await theirs.read('c1'), empty, 'another account never sees it');
  assert.equal(await theirs.appendIfLast('c1', 'qa mine', { role: 'assistant', content: 'x' }), 'no-user-message');
  assert.equal(await mine.appendIfLast('c1', 'qa mine', { role: 'assistant', content: 'qa kept' }), 'saved');
  assert.equal((await mine.read('c1')).history.length, 2);
  assert.equal(await mine.removeIf('c1', ['nope']), false);
  require('./chat-lists.cjs').addTombstone(path.join(root, 'users', USER), 'c1');
  assert.deepEqual(await mine.write('c1', []), { deleted: true });
  assert.equal(await mine.appendIfLast('c1', 'qa mine', { role: 'assistant' }), 'deleted');
  await assert.rejects(mine.write('c2', { not: 'a list' }), (e) => e.status === 400);
  // A removed account: 410, and its directory is not made again.
  const gone = psc.transcriptsFor(client, '22222222-2222-4333-8444-555555555555');
  await assert.rejects(gone.write('c1', []), (e) => e.status === 410);
  assert.equal(fs.existsSync(path.join(root, 'users', '22222222-2222-4333-8444-555555555555')), false);
  // Another start's secret, or none: refused as a store failure, nothing written.
  const wrong = psc.transcriptsFor(psc.createClient({ port: store.port, token: 'synthetic-previous-start-token-0123456789' }), USER);
  await assert.rejects(wrong.write('c3', ['qa']), (e) => e.status === 500 && e.code === 'PROJECT_STORE_FAILED');
  assert.equal(fs.existsSync(path.join(root, 'users', USER, 'history-c3.json')), false);
  // The store unreachable: busy (503), never a local write.
  await store.close();
  await assert.rejects(mine.write('c4', ['qa']), (e) => e.status === 503 && e.code === 'PROJECTS_BUSY');
  assert.equal(fs.existsSync(path.join(root, 'users', USER, 'history-c4.json')), false);
});

test('#1071 slice 6: a chat\'s delete is one store call, bound to one account; its answers and failures', async () => {
  const sent = [];
  const answers = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body), token: init.headers['x-noevia-store-token'] }); const a = answers.shift(); if (a instanceof Error) throw a; return { status: a.status, json: async () => a.body }; };
  const client = psc.createClient({ port: 1, token: TOKEN, fetchImpl });
  const mine = psc.transcriptsFor(client, USER);
  answers.push({ status: 200, body: { deleted: true, swept: false, leftovers: 0 } });
  assert.deepEqual(await mine.deleteChat('qa-c1', { kind: 'project', projectId: 'qa-p' }), { deleted: true, swept: false, leftovers: 0 });
  assert.deepEqual(sent.pop(), { url: 'http://127.0.0.1:1/v1/chat/delete', token: TOKEN, body: { user: USER, chat: 'qa-c1', kind: 'project', origin: 'remove', projectId: 'qa-p' } });
  answers.push({ status: 200, body: { deleted: false, swept: true, leftovers: 1 } });
  assert.deepEqual(await mine.deleteChat('qa-c1', { kind: 'free', projectId: 'ignored', origin: 'turn' }), { deleted: false, swept: true, leftovers: 1 });
  assert.deepEqual(sent.pop().body, { user: USER, chat: 'qa-c1', kind: 'free', origin: 'turn' }, 'no projectId for the free list');
  answers.push({ status: 409, body: { error: 'a list still holds this chat', code: 'CHAT_LISTED' } });
  assert.equal((await mine.deleteChat('qa-c1', { kind: 'unlisted', origin: 'bogus' })).listed, true);
  assert.equal(sent.pop().body.origin, 'other', 'an unknown origin is sent as other');
  answers.push({ status: 503, body: { error: 'busy', code: 'PROJECTS_BUSY' } });
  await assert.rejects(mine.deleteChat('qa-c1', { kind: 'free' }), (e) => e.status === 503 && e.code === 'PROJECTS_BUSY');
  answers.push({ status: 410, body: { error: 'account no longer exists' } });
  await assert.rejects(mine.deleteChat('qa-c1', { kind: 'free' }), (e) => e.status === 410);
  answers.push({ status: 400, body: { error: 'invalid chat id' } });
  await assert.rejects(mine.deleteChat('', { kind: 'free' }), (e) => e.status === 400);
  answers.push({ status: 500, body: { error: 'Internal error' } });
  await assert.rejects(mine.deleteChat('qa-c1', { kind: 'free' }), (e) => e.status === 500 && e.code === 'PROJECT_STORE_FAILED');
  answers.push(new Error('ECONNREFUSED'));
  await assert.rejects(mine.deleteChat('qa-c1', { kind: 'free' }), (e) => e.code === 'PROJECTS_BUSY');
  assert.ok(sent.every((s) => s.body.user === USER), 'every call names the bound account only');
  // The release pairing marker (noevia assemble-release.sh reads the quoted literal, #2161).
  assert.equal(psc.CHAT_DELETE_CLIENT_MARKER, 'noevia-chat-delete-client/1');
  assert.ok(fs.readFileSync(path.join(__dirname, 'project-store-client.cjs'), 'utf8').includes(`'${psc.CHAT_DELETE_CLIENT_MARKER}'`));
});

test('slice7 workspace context/move methods bind the actual account and refuse a revoked view',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qa-move-client-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const calls=[],stub=require('../tests/server/project-store-stub.cjs').createStubStore(root);
 stub.grantContext=async(user,chat)=>{calls.push({op:'context',user,chat});return require('../tests/server/chat-grant-fixture.cjs').context(chat);};
 stub.chatMove=async(user,chat,projectId,patch)=>{calls.push({op:'move',user,chat,projectId,patch});return{status:200,from:null};};
 const store=createWorkspaceStore(root,{id:'default'},null,{projectStore:stub});
 const other='99999999-2222-4333-8444-555555555555',mine=store.get(USER),theirs=store.get(other);
 await mine.chatPermissions.context('qa c!');await theirs.chatPermissions.move('qa c!',null,{frame:null,user:USER});
 assert.deepEqual(calls,[{op:'context',user:USER,chat:'qa c!'},{op:'move',user:other,chat:'qa c!',projectId:null,patch:{frame:null,user:USER}}]);
 mine.revoked=true;assert.throws(()=>mine.chatPermissions.context('qa'),e=>e.status===410);assert.throws(()=>mine.chatPermissions.move('qa',null),e=>e.status===410);
 assert.equal(calls.length,2);
});

test('slice7 real loopback authority double preserves latest metadata, CAS, tenant and attachment boundaries',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qa-move-protocol-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const other='99999999-2222-4333-8444-555555555555';
 for(const user of [USER,other]){
  const dir=path.join(root,'users',user);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'free-chats.json'),JSON.stringify([{id:'qa raw!',title:user,updatedAt:1},{id:'qa-unrelated',updatedAt:2}]));
  fs.writeFileSync(path.join(dir,'projects.json'),JSON.stringify({projects:[{id:'qa-p',chats:[]}]}));
  fs.writeFileSync(path.join(dir,'history-qaraw.json'),'sentinel transcript');
 }
 const standin=await require('../tests/server/project-store-server.cjs').startProjectStore(root,{token:TOKEN,changes:true});t.after(()=>standin.close());
 const client=psc.createClient({port:standin.port,token:TOKEN});
 const before=await client.read(USER,'free-chats.json');
 assert.equal((await client.grantContext(USER,'qa raw!')).generation,'0');
 const moved=await client.chatMove(USER,'qa raw!','qa-p',{frame:null});
 assert.equal(moved.from,null);assert.equal(moved.generation,'1');
 const projects=JSON.parse((await client.read(USER,'projects.json')).text).projects;
 assert.equal(projects[0].chats[0].title,USER);assert.equal(projects[0].chats[0].frame,null);
 assert.deepEqual(JSON.parse((await client.read(USER,'free-chats.json')).text).map(c=>c.id),['qa-unrelated']);
 assert.equal((await client.write(USER,'free-chats.json',before.version,before.text)).conflict,true,'stale CAS cannot undo move');
 assert.equal((await client.grantContext(other,'qa raw!')).generation,'0','other tenant unchanged');
 assert.equal(fs.readFileSync(path.join(root,'users',USER,'history-qaraw.json'),'utf8'),'sentinel transcript');
 assert.equal((await client.chatMove(USER,'qa raw!',null)).generation,'2');
 const notices=await client.changesRead(USER);
 assert.equal(notices.entries.filter(e=>e.op==='move').length,2);
 assert.ok(notices.entries.every(e=>e.delivery==='live'&&e.rawChatId==='qa raw!'&&e.chatId==='qaraw'));
 const bad=psc.createClient({port:standin.port,token:'wrong-token'});
 await assert.rejects(bad.chatMove(USER,'qa raw!','qa-p'));
 await assert.rejects(client.chatMove('88888888-2222-4333-8444-555555555555','qa raw!',null),e=>e.status===410);
});
