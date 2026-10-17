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
