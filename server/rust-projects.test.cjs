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

test('the lock is exclusive, released after the write and after a throw', () => {
  const dir = tmp(); const file = path.join(dir, 'projects.json');
  const out = rp.withFileLock(file, () => {
    assert.ok(fs.existsSync(file + '.lock'));
    assert.match(fs.readFileSync(file + '.lock', 'utf8'), /^\d+ \d+\n$/);
    assert.equal((fs.statSync(file + '.lock').mode & 0o777), 0o600);
    return 7;
  });
  assert.equal(out, 7);
  assert.equal(fs.existsSync(file + '.lock'), false);
  assert.throws(() => rp.withFileLock(file, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(file + '.lock'), false);
});

test('a held lock makes a writer wait, then answer 503 PROJECTS_BUSY; a stale one is removed', () => {
  const dir = tmp(); const file = path.join(dir, 'projects.json');
  fs.writeFileSync(file + '.lock', '1 1\n');
  let clock = Date.now(); let slept = 0;
  const opts = { now: () => clock, sleep: (ms) => { slept += ms; clock += ms; } };
  assert.throws(() => rp.withFileLock(file, () => 1, opts), (e) => e.status === 503 && e.code === 'PROJECTS_BUSY');
  assert.ok(slept >= rp.LOCK_WAIT_MS, `waited ${slept} ms`);
  assert.ok(fs.existsSync(file + '.lock'), 'a live lock is not broken');
  // The same lock, older than LOCK_STALE_MS: a dead writer's. It is removed and the write runs.
  const old = new Date(Date.now() - rp.LOCK_STALE_MS - 1000);
  fs.utimesSync(file + '.lock', old, old);
  assert.equal(rp.withFileLock(file, () => 2), 2);
  assert.equal(fs.existsSync(file + '.lock'), false);
});

test('two processes incrementing under the lock lose no update', async () => {
  const dir = tmp(); const file = path.join(dir, 'counter.json');
  fs.writeFileSync(file, JSON.stringify({ n: 0 }));
  const script = `
    const fs = require('fs'); const rp = require(${JSON.stringify(path.join(__dirname, 'rust-projects.cjs'))});
    for (let i = 0; i < 200; i++) rp.withFileLock(process.argv[1], () => {
      const v = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); v.n += 1;
      fs.writeFileSync(process.argv[1] + '.' + process.pid + '.tmp', JSON.stringify(v)); fs.renameSync(process.argv[1] + '.' + process.pid + '.tmp', process.argv[1]);
    });`;
  const runs = [0, 1].map(() => new Promise((resolve) => { const c = spawn(process.execPath, ['-e', script, file], { stdio: 'inherit' }); c.on('exit', resolve); }));
  assert.deepEqual(await Promise.all(runs), [0, 0]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 400);
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
  assert.deepEqual(rp.merge([{ ...saved, assets: [{ id: 'mine' }] }], base, disk).result[0].assets, [{ id: 'mine' }]);
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
  assert.equal(fs.existsSync(file + '.lock'), false);
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
