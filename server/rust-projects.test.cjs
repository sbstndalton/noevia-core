'use strict';
// rust-projects.cjs (M4): the switch, the shared projects.json lock, the three-way merge Node saves
// with while the Rust front writes the same file, and the workspace store using them. Synthetic
// data in throwaway directories only.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const rp = require('./rust-projects.cjs');
const { atomicJson, createWorkspaceStore } = require('./workspace.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rust-projects-test-'));
const USER = '11111111-2222-4333-8444-555555555555';
const DEFAULT = { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '' };
const write = (file, projects) => atomicJson(file, { projects });
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).projects;

test('the switch needs the M3 switch confirmed, NOEVIA_FRONT=rust and its own confirmation', () => {
  const warned = [];
  const warn = (m) => warned.push(m);
  const full = { NOEVIA_RUST_PROJECTS: '1', NOEVIA_FRONT: 'rust', NOEVIA_RUST_AUTH: '1', NOEVIA_RUST_AUTH_CONFIRMED: '1', NOEVIA_RUST_PROJECTS_CONFIRMED: '1' };
  assert.equal(rp.enabledFrom(full, warn), true);
  assert.equal(rp.enabledFrom({}, warn), false);
  assert.equal(warned.length, 0, 'off is silent');
  assert.equal(rp.enabledFrom({ ...full, NOEVIA_RUST_PROJECTS: 'true' }, warn), false);
  for (const drop of ['NOEVIA_FRONT', 'NOEVIA_RUST_AUTH', 'NOEVIA_RUST_AUTH_CONFIRMED', 'NOEVIA_RUST_PROJECTS_CONFIRMED']) {
    const env = { ...full }; delete env[drop];
    assert.equal(rp.enabledFrom(env, warn), false, drop);
  }
  assert.equal(rp.enabledFrom({ ...full, NOEVIA_FRONT: 'node' }, warn), false);
  assert.equal(warned.length, 5);
});

// flock(1) is util-linux (the web image, CI); without it (a Mac) the lock tests are skipped.
const NO_FLOCK = spawnSync('flock', ['--version']).error ? 'flock(1) not on PATH' : false;
const RP = JSON.stringify(path.join(__dirname, 'rust-projects.cjs'));
const exitOf = (c) => new Promise((resolve) => c.on('exit', (code, sig) => resolve(sig || code)));

test('the lock is exclusive, released after the write and after a throw; the file is long-lived', { skip: NO_FLOCK }, () => {
  const dir = tmp(); const file = path.join(dir, 'projects.json');
  const out = rp.withFileLock(file, () => {
    assert.equal((fs.statSync(file + '.lock').mode & 0o777), 0o600);
    // Held: another descriptor (as another process would) cannot take it.
    assert.equal(spawnSync('flock', ['-n', file + '.lock', 'true']).status, 1);
    return 7;
  });
  assert.equal(out, 7);
  assert.ok(fs.existsSync(file + '.lock'), 'never unlinked');
  assert.equal(spawnSync('flock', ['-n', file + '.lock', 'true']).status, 0, 'released');
  assert.throws(() => rp.withFileLock(file, () => { throw new Error('boom'); }), /boom/);
  assert.equal(spawnSync('flock', ['-n', file + '.lock', 'true']).status, 0, 'released after a throw');
});

test('a held lock makes a writer wait LOCK_WAIT_MS, then answer 503 PROJECTS_BUSY; no flock(1) is a 500', { skip: NO_FLOCK }, async () => {
  const dir = tmp(); const file = path.join(dir, 'projects.json');
  const holder = spawn('flock', ['-x', file + '.lock', 'sleep', '30'], { stdio: 'ignore' });
  try {
    const until = Date.now() + 5000;
    while (spawnSync('flock', ['-n', file + '.lock', 'true']).status === 0) { assert.ok(Date.now() < until); await new Promise((r) => setTimeout(r, 10)); }
    const t0 = Date.now();
    assert.throws(() => rp.withFileLock(file, () => 1), (e) => e.status === 503 && e.code === 'PROJECTS_BUSY');
    const waited = Date.now() - t0;
    assert.ok(waited >= rp.LOCK_WAIT_MS - 100 && waited < rp.LOCK_WAIT_MS + 2000, `waited ${waited} ms`);
  } finally { holder.kill('SIGKILL'); await exitOf(holder); }
  assert.throws(() => rp.withFileLock(file, () => 1, { flockBin: path.join(dir, 'no-such-flock') }), (e) => e.status === 500 && e.code === 'PROJECTS_LOCK_UNAVAILABLE');
});

test('a holder that is killed mid-hold releases the lock with its descriptor', { skip: NO_FLOCK }, async () => {
  const dir = tmp(); const file = path.join(dir, 'projects.json');
  const script = `require(${RP}).withFileLock(process.argv[1], () => { require('fs').writeFileSync(process.argv[1] + '.held', ''); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); });`;
  const c = spawn(process.execPath, ['-e', script, file], { stdio: 'inherit' });
  const until = Date.now() + 10000;
  while (!fs.existsSync(file + '.held')) { assert.ok(Date.now() < until, 'holder never held'); await new Promise((r) => setTimeout(r, 10)); }
  assert.equal(spawnSync('flock', ['-n', file + '.lock', 'true']).status, 1, 'held while alive');
  c.kill('SIGKILL');
  assert.equal(await exitOf(c), 'SIGKILL');
  const t0 = Date.now();
  assert.equal(rp.withFileLock(file, () => 2), 2);
  assert.ok(Date.now() - t0 < 1000, 'no staleness wait');
});

test('N processes incrementing under the lock are never both inside and lose no update', { skip: NO_FLOCK }, async () => {
  const dir = tmp(); const file = path.join(dir, 'counter.json');
  fs.writeFileSync(file, JSON.stringify({ n: 0 }));
  const script = `
    const fs = require('fs'); const rp = require(${RP}); const f = process.argv[1];
    for (let i = 0; i < 100; i++) rp.withFileLock(f, () => {
      fs.mkdirSync(f + '.inside'); // EEXIST: two inside
      const v = JSON.parse(fs.readFileSync(f, 'utf8')); v.n += 1;
      fs.writeFileSync(f + '.' + process.pid + '.tmp', JSON.stringify(v)); fs.renameSync(f + '.' + process.pid + '.tmp', f);
      fs.rmdirSync(f + '.inside');
    });`;
  const runs = [0, 1, 2, 3].map(() => exitOf(spawn(process.execPath, ['-e', script, file], { stdio: 'inherit' })));
  assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 400);
});

test('merge: assets and retiredAssets are merged per id (adds union, removals from either side)', () => {
  const p = (assets, extra = {}) => ({ id: 'p', name: 'P', ...extra, ...(assets ? { assets: assets.map((id) => (typeof id === 'string' ? { id } : id)) } : {}) });
  const run = (base, disk, node) => rp.merge([node], new Map([['p', JSON.stringify(base)]]), [disk]).result[0];
  const ids = (x, k = 'assets') => (x[k] || []).map((a) => a.id);
  // Node removed a; Rust added b: [b].
  assert.deepEqual(ids(run(p(['a']), p(['a', 'b']), p([]))), ['b']);
  // Rust deleted b; Node (stale) added c: b stays deleted.
  assert.deepEqual(ids(run(p(['a', 'b']), p(['a']), p(['a', 'b', 'c']))), ['a', 'c']);
  // Same id on both: the disk's unless Node changed that item.
  const r = run(p(['a', 'b']), p([{ id: 'a', v: 'disk' }, { id: 'b', v: 'disk' }]), p([{ id: 'a' }, { id: 'b', v: 'node' }]));
  assert.deepEqual(r.assets, [{ id: 'a', v: 'disk' }, { id: 'b', v: 'node' }]);
  // retiredAssets alike; Node deleting the emptied field (uploads.prune) is a removal of every item.
  const retired = (l) => ({ retiredAssets: l.map((id) => ({ id })) });
  assert.deepEqual(ids(run(p(['a'], retired(['r1'])), p(['a'], retired(['r1', 'r2'])), p(['a', 'n'])), 'retiredAssets'), ['r2']);
  const gone = run(p(['a'], retired(['r1'])), p(['a', 'x'], retired(['r1'])), p(['a'], { name: 'Q' }));
  assert.equal(own(gone, 'retiredAssets'), false);
  assert.deepEqual(ids(gone), ['a', 'x']);
  assert.equal(gone.name, 'Q');
});

test('merge: changes on either side survive, a project both changed is merged per field', () => {
  const a = { id: 'a', name: 'A', chats: [] };
  const b = { id: 'b', name: 'B', assets: [] };
  const base = new Map([['a', JSON.stringify(a)], ['b', JSON.stringify(b)]]);
  // Here: a gets a chat; there: a gets an image, b is renamed.
  const local = [{ ...a, chats: [{ id: 'c1' }] }, { ...b }];
  const disk = [{ ...a, assets: [{ id: 'img-1' }] }, { ...b, name: 'B2' }];
  const { result, adopt } = rp.merge(local, base, disk);
  assert.deepEqual(result, [{ id: 'a', name: 'A', chats: [{ id: 'c1' }], assets: [{ id: 'img-1' }] }, { id: 'b', name: 'B2', assets: [] }]);
  assert.deepEqual([...adopt.keys()].sort(), ['a', 'b']);
  // The same field changed on both sides: this process's value.
  const both = rp.merge([{ ...a, name: 'mine' }], new Map([['a', JSON.stringify(a)]]), [{ ...a, name: 'theirs' }]).result;
  assert.equal(both[0].name, 'mine');
  // A field removed here stays removed; one removed there stays removed when unchanged here.
  const removed = rp.merge([{ id: 'a', chats: [] }], new Map([['a', JSON.stringify(a)]]), [{ id: 'a', name: 'A', chats: [], x: 1 }]).result;
  assert.deepEqual(removed, [{ id: 'a', chats: [], x: 1 }]);
});

test('merge: a list Node only normalised after its save ([] for a missing one) does not beat the other writer', () => {
  // The config route saves, then pruneDocuments sets project.assets = (project.assets || []).filter(...):
  // [] in memory, absent on disk. Meanwhile the front adds images.
  const saved = { id: 'a', name: 'A', chats: [] };
  const base = new Map([['a', JSON.stringify(saved)]]);
  const local = [{ ...saved, assets: [], retired: {} }];
  const disk = [{ ...saved, assets: [{ id: 'img-1' }, { id: 'img-2' }] }];
  const { result } = rp.merge(local, base, disk);
  assert.deepEqual(result[0].assets, [{ id: 'img-1' }, { id: 'img-2' }]);
  // A real change here still wins, and a normalised-but-absent-there field is kept as Node has it.
  // (per id: both sides' additions survive)
  assert.deepEqual(rp.merge([{ ...saved, assets: [{ id: 'mine' }] }], base, disk).result[0].assets, [{ id: 'img-1' }, { id: 'img-2' }, { id: 'mine' }]);
  assert.deepEqual(rp.merge(local, base, [{ ...saved, name: 'B' }]).result[0], { id: 'a', name: 'B', chats: [], assets: [], retired: {} });
});

test('the coordinated file: a post-save normalisation, then the front adds images, then a refresh and a save keep them', () => {
  const dir = tmp(); const file = path.join(dir, 'projects.json');
  const pf = rp.createProjectsFile(file, { atomicJson, warn: () => {} });
  const projects = pf.load();
  projects.push({ id: 'p', name: 'P', chats: [] });
  pf.save(projects);
  projects[0].assets = (projects[0].assets || []).filter(() => true); // uploads.prune after the save
  write(file, [{ id: 'p', name: 'P', chats: [], assets: [{ id: 'img-1' }] }]);
  pf.refresh(projects);
  assert.deepEqual(projects[0].assets, [{ id: 'img-1' }]);
  write(file, [{ id: 'p', name: 'P', chats: [], assets: [{ id: 'img-1' }, { id: 'img-2' }] }]);
  projects[0].chats.push({ id: 'c' });
  pf.save(projects);
  assert.deepEqual(read(file)[0], { id: 'p', name: 'P', chats: [{ id: 'c' }], assets: [{ id: 'img-1' }, { id: 'img-2' }] });
});

test('merge: deletes and creations on either side, and where new projects go', () => {
  const p = (id) => ({ id, name: id });
  const base = new Map(['a', 'b', 'c'].map((id) => [id, JSON.stringify(p(id))]));
  // Here: b deleted, n1 created first (createProject unshifts), n2 after c. There: c deleted, r1 created.
  const local = [p('n1'), p('a'), p('c'), p('n2')];
  const disk = [p('r1'), p('a'), p('b')];
  const { result } = rp.merge(local, base, disk);
  assert.deepEqual(result.map((x) => x.id), ['n1', 'r1', 'a', 'n2']);
  // A project deleted here but changed there is still deleted.
  assert.deepEqual(rp.merge([], new Map([['a', JSON.stringify(p('a'))]]), [{ id: 'a', name: 'changed' }]).result, []);
  // Entries without a string id come from disk only, duplicates once.
  assert.deepEqual(rp.merge([{ x: 1 }], new Map(), [{ y: 2 }, p('a'), p('a')]).result, [{ y: 2 }, p('a')]);
});

test('the coordinated file: refresh takes in the other writer in place; save merges under the lock', () => {
  const dir = tmp(); const file = path.join(dir, 'projects.json');
  write(file, [{ id: 'a', name: 'A', chats: [] }, { id: 'b', name: 'B' }]);
  const pf = rp.createProjectsFile(file, { atomicJson, warn: () => {} });
  const projects = pf.load();
  const heldA = projects[0];
  assert.equal(pf.refresh(projects), false, 'unchanged file: nothing to do');
  // The Rust front adds an image to a (its own atomic write).
  write(file, [{ id: 'a', name: 'A', chats: [], assets: [{ id: 'img-1', bytes: 3 }] }, { id: 'b', name: 'B' }]);
  assert.equal(pf.refresh(projects), true);
  assert.equal(projects[0], heldA, 'the object a handler holds is the current project');
  assert.deepEqual(heldA.assets, [{ id: 'img-1', bytes: 3 }]);
  // A long request changes a's chats; meanwhile the front removes the image and renames b.
  heldA.chats = [{ id: 'chat-1', title: 'Hi' }];
  write(file, [{ id: 'a', name: 'A', chats: [], assets: [] }, { id: 'b', name: 'B renamed' }]);
  pf.save(projects);
  assert.deepEqual(read(file), [{ id: 'a', name: 'A', chats: [{ id: 'chat-1', title: 'Hi' }], assets: [] }, { id: 'b', name: 'B renamed' }]);
  assert.equal(projects[0], heldA);
  assert.equal(projects[1].name, 'B renamed');
  assert.ok(fs.existsSync(file + '.lock'), 'the lock file is long-lived');
  assert.equal(pf.refresh(projects), false, 'its own write is not taken for the other writer');
  // The bytes are atomicJson's: JSON.stringify(value, null, 2).
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ projects: read(file) }, null, 2));
});

test('an unreadable file: the view is kept, and the next save replaces the file', () => {
  const dir = tmp(); const file = path.join(dir, 'projects.json');
  write(file, [{ id: 'a' }]);
  const warned = [];
  const pf = rp.createProjectsFile(file, { atomicJson, warn: (m) => warned.push(m) });
  const projects = pf.load();
  fs.writeFileSync(file, '{"projects": [');
  assert.equal(pf.refresh(projects), false);
  assert.deepEqual(projects, [{ id: 'a' }]);
  pf.save(projects);
  assert.deepEqual(read(file), [{ id: 'a' }]);
  assert.equal(warned.length, 1);
  const missing = rp.createProjectsFile(path.join(dir, 'none.json'), { atomicJson });
  assert.deepEqual(missing.load(), []);
});

test('the workspace store with rustProjects: requests see the other writer, saves keep its changes', () => {
  const root = tmp();
  const store = createWorkspaceStore(root, DEFAULT, null, { rustProjects: true });
  const ws = store.get(USER);
  ws.projects.push({ id: 'p1', name: 'One', modes: ['chat'], chats: [] });
  ws.saveProjects();
  const file = path.join(ws.dir, 'projects.json');
  const disk = read(file);
  disk[0].assets = [{ id: 'img-a', name: 'x.png', mime: 'image/png', bytes: 1 }];
  write(file, disk);
  const again = store.get(USER);
  assert.equal(again, ws);
  assert.deepEqual(ws.projects[0].assets, [{ id: 'img-a', name: 'x.png', mime: 'image/png', bytes: 1 }]);
  ws.projects[0].chats.push({ id: 'chat-1' });
  disk[0].assets = [];
  write(file, disk);
  ws.saveProjects();
  assert.deepEqual(read(file)[0], { id: 'p1', name: 'One', modes: ['chat'], chats: [{ id: 'chat-1' }], assets: [] });
  // Off: Node writes its own view, as before (the change on disk is overwritten).
  const plain = createWorkspaceStore(tmp(), DEFAULT, null);
  const w2 = plain.get(USER);
  w2.projects.push({ id: 'q', modes: ['chat'] }); w2.saveProjects();
  const f2 = path.join(w2.dir, 'projects.json');
  write(f2, [{ id: 'q', modes: ['chat'], assets: [1] }]);
  plain.get(USER).saveProjects();
  assert.deepEqual(read(f2), [{ id: 'q', modes: ['chat'] }]);
});

test('uploads.prune (a writer after an await) filters the lists as on disk now, and the save keeps them', () => {
  const uploads = require('./uploads.cjs');
  const store = createWorkspaceStore(tmp(), DEFAULT, null, { rustProjects: true });
  const ws = store.get(USER);
  ws.projects.push({ id: 'p1', name: 'One', modes: ['chat'], chats: [], files: [] });
  ws.saveProjects();
  const project = ws.projects[0];
  const file = path.join(ws.dir, 'projects.json');
  // The front adds an image after this request's start (no store.get in between).
  write(file, [{ ...read(file)[0], assets: [{ id: 'img-rust', name: 'r.png', mime: 'image/png', bytes: 1 }] }]);
  uploads.prune(ws, project);
  assert.deepEqual(project.assets.map((a) => a.id), ['img-rust'], 'refreshed before filtering');
  ws.saveProjects();
  assert.deepEqual(read(file)[0].assets.map((a) => a.id), ['img-rust']);
});

test("Node's copies of the Rust-owned writes answer 503 only while the switch is on", () => {
  const sent = [];
  const json = (res, status, body) => sent.push([status, body]);
  assert.equal(rp.refuseOwned(false, json, {}), false);
  assert.equal(sent.length, 0);
  assert.equal(rp.refuseOwned(true, json, {}), true);
  assert.equal(sent[0][0], 503);
  assert.equal(sent[0][1].code, 'RUST_PROJECTS_OWNED');
  assert.deepEqual([...rp.OWNED_ROUTES].sort(), ['DELETE /api/projects/{id}/assets/{assetId}', 'GET /api/projects/{id}/assets/{assetId}', 'POST /api/projects/{id}/assets']);
  // Off by default in a server that is not told otherwise.
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(path.join(__dirname, 'rust-projects.cjs'))}).enabledFrom({}, () => {})))`]);
  assert.equal(String(r.stdout), 'false');
});
