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

const ON = { NOEVIA_RUST_PROJECTS: '1', NOEVIA_FRONT: 'rust', NOEVIA_RUST_AUTH: '1', NOEVIA_RUST_AUTH_CONFIRMED: '1', NOEVIA_RUST_PROJECTS_CONFIRMED: '1', NOEVIA_RUST_FREE_CHATS_CONFIRMED: '1',
  NOEVIA_RUST_PROJECT_STORE: '1', NOEVIA_RUST_PROJECT_STORE_CONFIRMED: '1', NOEVIA_PROJECT_STORE_PORT: '19021', NOEVIA_PROJECT_STORE_TOKEN: TOKEN };

test('the store is used only with its switch, its confirmation, both confirmed slices, a port and the secret', () => {
  const warned = [];
  const warn = (m) => warned.push(m);
  assert.equal(psc.enabledFrom(ON, warn), true);
  // Live today: the slices confirmed, the store switch off. Silent.
  const { NOEVIA_RUST_PROJECT_STORE: _s, ...live } = ON;
  assert.equal(psc.enabledFrom(live, warn), false);
  assert.equal(warned.length, 0);
  for (const v of ['0', 'true', ' 1', '']) assert.equal(psc.enabledFrom({ ...ON, NOEVIA_RUST_PROJECT_STORE: v }, warn), false, v);
  for (const drop of ['NOEVIA_RUST_PROJECT_STORE_CONFIRMED', 'NOEVIA_RUST_FREE_CHATS_CONFIRMED', 'NOEVIA_RUST_PROJECTS_CONFIRMED', 'NOEVIA_PROJECT_STORE_PORT', 'NOEVIA_PROJECT_STORE_TOKEN']) {
    const env = { ...ON }; delete env[drop];
    assert.equal(psc.enabledFrom(env, () => {}), false, drop);
  }
  assert.equal(psc.enabledFrom({ ...ON, NOEVIA_PROJECT_STORE_TOKEN: 'short' }, () => {}), false);
});

test('off: a save takes the flock path (the lock is called); on: never', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-off-'));
  const file = path.join(dir, 'projects.json');
  let locks = 0;
  const lock = (_f, fn) => { locks += 1; return fn(); };
  const atomicJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
  const off = rp.createProjectsFile(file, { atomicJson, lock });
  const list = off.load();
  list.push({ id: 'p1' });
  assert.equal(off.save(list), undefined, 'synchronous, as before');
  assert.equal(locks, 1);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-on-'));
  fs.mkdirSync(path.join(root, 'users', USER), { recursive: true });
  const store = await fakeStore(root);
  try {
    const client = psc.createClient({ port: store.port, token: TOKEN });
    const remote = { client, user: USER, queue: psc.createQueue() };
    const on = rp.createProjectsFile(path.join(root, 'users', USER, 'projects.json'), { atomicJson: () => { throw Error('Node wrote the file'); }, lock: () => { throw Error('Node took the flock'); }, remote });
    const l2 = on.load();
    l2.push({ id: 'p1' });
    await on.save(l2);
    assert.deepEqual(store.writes, ['projects.json']);
  } finally { await store.close(); }
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
      const ws = createWorkspaceStore(root, { id: 'local', label: 'Local', baseUrl: '', apiKey: '' }, null, { rustProjects: true, rustFreeChats: true, projectStore: client }).get(USER);
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
    const views = [0, 1].map(() => createWorkspaceStore(root, { id: 'local', label: 'Local', baseUrl: '', apiKey: '' }, null, { rustProjects: true, rustFreeChats: true, projectStore: client }).get(USER));
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
