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
// #1264: the coordinated files are written only through the Rust project store; this stand-in has
// its protocol (a compare-and-swap) over the same files.
const { createStubStore, remoteFor } = require('../tests/server/project-store-stub.cjs');
const storeWith = (root, opts) => createWorkspaceStore(root, DEFAULT, null, { projectStore: createStubStore(root), ...opts });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rust-projects-test-'));
const USER = '11111111-2222-4333-8444-555555555555';
const DEFAULT = { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '' };
const write = (file, projects) => atomicJson(file, { projects });
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).projects;

// sbstndalton/noevia#1071: NOEVIA_RUST_PROJECTS and the slice confirmations are retired. Nothing
// turns the project routes back over to Node; a leftover switch only warns.
test('#1071: the projects switch is retired: no enable check is left and a leftover value only warns', () => {
  for (const gone of ['enabledFrom', 'chatsEnabledFrom', 'freeChatsEnabledFrom']) assert.equal(rp[gone], undefined, gone);
  for (const v of ['1', '0', '', 'true']) {
    const warned = [];
    assert.deepEqual(rp.warnRetired({ NOEVIA_RUST_PROJECTS: v }, (m) => warned.push(m)), ['NOEVIA_RUST_PROJECTS'], v);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /NOEVIA_RUST_PROJECTS is retired .*ignored/);
  }
  const quiet = [];
  assert.deepEqual(rp.warnRetired({}, (m) => quiet.push(m)), []);
  assert.equal(quiet.length, 0, 'unset is silent');
  // No server source reads the switch or a slice confirmation any more.
  const sources = fs.readdirSync(__dirname, { recursive: true })
    .filter((f) => f.endsWith('.cjs') && !f.endsWith('.test.cjs') && !f.includes('node_modules'))
    .map((f) => [f, fs.readFileSync(path.join(__dirname, f), 'utf8')]);
  for (const [f, src] of sources) {
    assert.equal(/env\.NOEVIA_RUST_PROJECTS\b(?!_)|env\.NOEVIA_RUST_(?:PROJECTS|PROJECT_CHATS|FREE_CHATS|PROJECT_STORE)_CONFIRMED\b/.test(src), false, f);
  }
});

test('#1071: every Rust-owned project route is refused here unconditionally, before anything is read; the rest is not', () => {
  const calls = [];
  const json = (res, status, body) => { calls.push({ status, body }); return true; };
  const owned = [
    ['POST', '/api/projects/p1/assets'],
    ['GET', '/api/projects/p1/assets/img-1'],
    ['DELETE', '/api/projects/p1/assets/img-1'],
    ['GET', '/api/projects/p1/chats'],
    ['POST', '/api/projects/p1/chats'],
    ['GET', '/api/freechats'],
    ['POST', '/api/freechats'],
  ];
  for (const [method, p] of owned) {
    calls.length = 0;
    assert.equal(rp.refuseOwnedRoute({ method }, {}, p, json), true, `${method} ${p}`);
    assert.deepEqual(calls, [{ status: 503, body: { error: 'This route is served by the Rust front.', code: 'RUST_PROJECTS_OWNED' } }]);
  }
  // The table matches OWNED_ROUTES method by method (noevia-rs routes.toml is the other half).
  const norm = (p) => p.replace(/\{[^}]*\}/g, 'x');
  assert.deepEqual(owned.map(([m, p]) => `${m} ${p.replace(/p1|img-1/g, 'x')}`).sort(), [...rp.OWNED_ROUTES].map((r) => norm(r)).sort());
  for (const [method, p] of [
    ['PUT', '/api/projects/p1/assets'], ['GET', '/api/projects/p1/assets'], ['POST', '/api/projects/p1/assets/img-1'],
    ['PUT', '/api/projects/p1/chats'], ['DELETE', '/api/projects/p1/chats'], ['GET', '/api/projects/p1/chats/c1'], ['DELETE', '/api/projects/p1/chats/c1'],
    ['DELETE', '/api/freechats/c1'], ['PUT', '/api/freechats'], ['GET', '/api/freechats/c1'], ['GET', '/api/freechatsx'],
    ['GET', '/api/chats/c1/context'], ['POST', '/api/chats/c1/move'], ['POST', '/api/projects'], ['GET', '/api/workspace'],
    ['POST', '/api/projects/p1/uploads'], ['GET', '/api/projects/p1/assets/img-1/extra'],
  ]) {
    calls.length = 0;
    assert.equal(rp.refuseOwnedRoute({ method }, {}, p, json), false, `${method} ${p}`);
    assert.equal(calls.length, 0);
  }
  assert.ok(![...rp.OWNED_ROUTES].some((r) => r.startsWith('DELETE /api/freechats')), "a free chat's delete stays Node's");
});

test('#1264: the project-writes slices need their own switch and confirmation (and no longer the retired projects switch)', async () => {
  const warned = [];
  const warn = (m) => warned.push(m);
  const on = { NOEVIA_RUST_PROJECT_WRITES: '1', NOEVIA_RUST_PROJECT_WRITES_CONFIRMED: '1' };
  assert.equal(rp.projectWritesEnabledFrom(on, warn), true);
  assert.equal(rp.projectWritesEnabledFrom({ NOEVIA_RUST_PROJECT_WRITES_CONFIRMED: '1' }, warn), false);
  assert.equal(warned.length, 0, 'off is not a misconfiguration');
  for (const v of ['0', 'true', ' 1', '']) assert.equal(rp.projectWritesEnabledFrom({ ...on, NOEVIA_RUST_PROJECT_WRITES: v }, warn), false, v);
  assert.equal(rp.projectWritesEnabledFrom({ ...on, NOEVIA_RUST_PROJECT_WRITES_CONFIRMED: '' }, warn), false);
  assert.match(warned.at(-1), /NOEVIA_RUST_PROJECT_WRITES_CONFIRMED/);
  // A leftover projects switch, on or off, changes nothing.
  for (const v of ['0', '1']) assert.equal(rp.projectWritesEnabledFrom({ ...on, NOEVIA_RUST_PROJECTS: v }, () => {}), true, v);
  assert.deepEqual([...rp.PROJECT_WRITE_ROUTES], ['GET /api/chats/{chatId}/context', 'POST /api/chats/{chatId}/context']);
  for (const r of rp.PROJECT_WRITE_ROUTES) assert.equal(rp.OWNED_ROUTES.has(r), false, `${r} is not one of the permanent routes`);
  assert.equal(rp.FREE_LIST_CAP, require('./chat-lists.cjs').LIST_CAP);
});

test('#1071: a workspace store without the Rust project store refuses to be made (no local writer to fall back to)', () => {
  assert.throws(() => createWorkspaceStore(tmp(), DEFAULT, null), /needs the Rust project store/);
  assert.throws(() => createWorkspaceStore(tmp(), DEFAULT, null, { onProjectsChanged: () => {} }), /needs the Rust project store/);
});

test('merge: assets and retiredAssets are merged per id (adds union, removals from either side)', async () => {
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

test('merge: changes on either side survive, a project both changed is merged per field', async () => {
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

test('merge: a list Node only normalised after its save ([] for a missing one) does not beat the other writer', async () => {
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

test('the coordinated file: a post-save normalisation, then the front adds images, then a refresh and a save keep them', async () => {
  const dir = tmp(); const file = path.join(dir, 'projects.json');
  const pf = rp.createProjectsFile(file, { remote: remoteFor(path.dirname(file)), warn: () => {} });
  const projects = pf.load();
  projects.push({ id: 'p', name: 'P', chats: [] });
  await pf.save(projects);
  projects[0].assets = (projects[0].assets || []).filter(() => true); // uploads.prune after the save
  write(file, [{ id: 'p', name: 'P', chats: [], assets: [{ id: 'img-1' }] }]);
  pf.refresh(projects);
  assert.deepEqual(projects[0].assets, [{ id: 'img-1' }]);
  write(file, [{ id: 'p', name: 'P', chats: [], assets: [{ id: 'img-1' }, { id: 'img-2' }] }]);
  projects[0].chats.push({ id: 'c' });
  await pf.save(projects);
  assert.deepEqual(read(file)[0], { id: 'p', name: 'P', chats: [{ id: 'c' }], assets: [{ id: 'img-1' }, { id: 'img-2' }] });
});

test('merge: deletes and creations on either side, and where new projects go', async () => {
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

test('the coordinated file: refresh takes in the other writer in place; save merges through the store', async () => {
  const dir = tmp(); const file = path.join(dir, 'projects.json');
  write(file, [{ id: 'a', name: 'A', chats: [] }, { id: 'b', name: 'B' }]);
  const pf = rp.createProjectsFile(file, { remote: remoteFor(path.dirname(file)), warn: () => {} });
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
  await pf.save(projects);
  assert.deepEqual(read(file), [{ id: 'a', name: 'A', chats: [{ id: 'chat-1', title: 'Hi' }], assets: [] }, { id: 'b', name: 'B renamed' }]);
  assert.equal(projects[0], heldA);
  assert.equal(projects[1].name, 'B renamed');
  assert.equal(pf.refresh(projects), false, 'its own write is not taken for the other writer');
  // The bytes are atomicJson's: JSON.stringify(value, null, 2).
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ projects: read(file) }, null, 2));
});

test('an unreadable file: the view is kept, and the next save replaces the file', async () => {
  const dir = tmp(); const file = path.join(dir, 'projects.json');
  write(file, [{ id: 'a' }]);
  const warned = [];
  const pf = rp.createProjectsFile(file, { remote: remoteFor(path.dirname(file)), warn: (m) => warned.push(m) });
  const projects = pf.load();
  fs.writeFileSync(file, '{"projects": [');
  assert.equal(pf.refresh(projects), false);
  assert.deepEqual(projects, [{ id: 'a' }]);
  await pf.save(projects);
  assert.deepEqual(read(file), [{ id: 'a' }]);
  assert.equal(warned.length, 1);
  const missing = rp.createProjectsFile(path.join(dir, 'none.json'), { remote: remoteFor(dir) });
  assert.deepEqual(missing.load(), []);
});

test('the workspace store: requests see the other writer, saves keep its changes', async () => {
  const root = tmp();
  const store = storeWith(root);
  const ws = store.get(USER);
  ws.projects.push({ id: 'p1', name: 'One', modes: ['chat'], chats: [] });
  await ws.saveProjects();
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
  await ws.saveProjects();
  assert.deepEqual(read(file)[0], { id: 'p1', name: 'One', modes: ['chat'], chats: [{ id: 'chat-1' }], assets: [] });
});

test('uploads.prune (a writer after an await) filters the lists as on disk now, and the save keeps them', async () => {
  const uploads = require('./uploads.cjs');
  const store = storeWith(tmp());
  const ws = store.get(USER);
  ws.projects.push({ id: 'p1', name: 'One', modes: ['chat'], chats: [], files: [] });
  await ws.saveProjects();
  const project = ws.projects[0];
  const file = path.join(ws.dir, 'projects.json');
  // The front adds an image after this request's start (no store.get in between).
  write(file, [{ ...read(file)[0], assets: [{ id: 'img-rust', name: 'r.png', mime: 'image/png', bytes: 1 }] }]);
  uploads.prune(ws, project);
  assert.deepEqual(project.assets.map((a) => a.id), ['img-rust'], 'refreshed before filtering');
  await ws.saveProjects();
  assert.deepEqual(read(file)[0].assets.map((a) => a.id), ['img-rust']);
});

test("Node's copies of the switched project writes answer 503 only while their slice is on; the permanent routes are fixed", async () => {
  const sent = [];
  const json = (res, status, body) => sent.push([status, body]);
  assert.equal(rp.refuseOwned(false, json, {}), false);
  assert.equal(sent.length, 0);
  assert.equal(rp.refuseOwned(true, json, {}), true);
  assert.equal(sent[0][0], 503);
  assert.equal(sent[0][1].code, 'RUST_PROJECTS_OWNED');
  assert.deepEqual([...rp.OWNED_ROUTES].sort(), ['DELETE /api/projects/{id}/assets/{assetId}', 'GET /api/freechats', 'GET /api/projects/{id}/assets/{assetId}', 'GET /api/projects/{id}/chats', 'POST /api/freechats', 'POST /api/projects/{id}/assets', 'POST /api/projects/{id}/chats']);
  // On in a server that is told nothing (#1071): the refusal reads no environment.
  const r = spawnSync(process.execPath, ['-e', `const json=(res,s)=>process.stdout.write(String(s)); require(${JSON.stringify(path.join(__dirname, 'rust-projects.cjs'))}).refuseOwnedRoute({ method: 'POST' }, {}, '/api/freechats', json)`], { env: { PATH: process.env.PATH, NOEVIA_RUST_PROJECTS: '0' } });
  assert.equal(String(r.stdout), '503');
});

test('chat metas are merged per item: a list the front saved survives a move or delete here, and the delete stands', async () => {
  const store = storeWith(tmp());
  const ws = store.get(USER);
  ws.projects.push({ id: 'p1', name: 'One', modes: ['chat'], chats: [{ id: 'keep', title: 'K' }, { id: 'gone', title: 'G' }] });
  await ws.saveProjects();
  const file = path.join(ws.dir, 'projects.json');
  // This request (no refresh since its start) deletes a chat; meanwhile the front saved a new one
  // and retitled another.
  ws.projects[0].chats = ws.projects[0].chats.filter((c) => c.id !== 'gone');
  write(file, [{ ...read(file)[0], chats: [{ id: 'new', title: 'N' }, { id: 'keep', title: 'K2' }, { id: 'gone', title: 'G' }] }]);
  await ws.saveProjects();
  assert.deepEqual(read(file)[0].chats, [{ id: 'new', title: 'N' }, { id: 'keep', title: 'K2' }]);
  // Both changed one meta: this process's wins; both added: both kept.
  ws.projects[0].chats = [...ws.projects[0].chats.map((c) => (c.id === 'new' ? { ...c, title: 'mine' } : c)), { id: 'local', title: 'L' }];
  write(file, [{ ...read(file)[0], chats: [...read(file)[0].chats.map((c) => (c.id === 'new' ? { ...c, title: 'theirs' } : c)), { id: 'front', title: 'F' }] }]);
  await ws.saveProjects();
  assert.deepEqual(read(file)[0].chats.map((c) => [c.id, c.title]), [['new', 'mine'], ['keep', 'K2'], ['front', 'F'], ['local', 'L']]);
});

test('a request start that takes in the front\'s change says so once; Node\'s own saves do not', async () => {
  const changed = [];
  const store = storeWith(tmp(), { onProjectsChanged: (id) => changed.push(id) });
  const ws = store.get(USER);
  ws.projects.push({ id: 'p1', name: 'One', modes: ['chat'], chats: [] });
  await ws.saveProjects();
  store.get(USER);
  assert.deepEqual(changed, []);
  const file = path.join(ws.dir, 'projects.json');
  write(file, [{ ...read(file)[0], chats: [{ id: 'c' }] }]);
  store.get(USER);
  store.get(USER);
  assert.deepEqual(changed, [USER]);
});

// ── free-chats.json (the free-chat slice) ──────────────────────────────────
const freeFile = (dir) => path.join(dir, 'free-chats.json');
const readFree = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const meta = (id, updatedAt, extra = {}) => ({ id, title: id, updatedAt, preview: '', pinned: false, archived: false, ...extra });

test('free chats, merged: additions from both sides, removals from either, a meta both changed is ours, newest first, capped', async () => {
  const base = [meta('a', 5), meta('b', 4), meta('c', 3)];
  // Here: b removed, a retitled, n added. There: c removed, a and b retitled, r added.
  const ours = [meta('n', 9), meta('a', 5, { title: 'ours' }), meta('c', 3)];
  const theirs = [meta('r', 7), meta('a', 6, { title: 'theirs' }), meta('b', 4, { title: 'theirs' })];
  assert.deepEqual(rp.mergeFreeChats(ours, base, theirs).map((c) => [c.id, c.title]), [['n', 'n'], ['r', 'r'], ['a', 'ours']]);
  // Equal times keep the merged order (a stable sort); a non-number time counts as 0.
  assert.deepEqual(rp.mergeFreeChats([meta('x', 1), meta('y', 'soon')], [], [meta('z', 1), meta('w', null)]).map((c) => c.id), ['z', 'x', 'w', 'y']);
  const many = Array.from({ length: 1001 }, (_, i) => meta(`m${i}`, i));
  assert.equal(rp.mergeFreeChats(many, [], [meta('t', 5000)]).length, rp.FREE_LIST_CAP);
  assert.equal(rp.mergeFreeChats(many, [], [meta('t', 5000)])[0].id, 't');
});

test('the coordinated free list: refresh takes in the front in place; an unchanged save keeps this order; a stale one merges', async () => {
  const dir = tmp(); const file = freeFile(dir);
  atomicJson(file, [meta('a', 2), meta('b', 1)]);
  const ff = rp.createFreeChatsFile(file, { remote: remoteFor(path.dirname(file)), warn: () => {} });
  const ws = { freeChats: ff.load() };
  const held = ws.freeChats;
  assert.equal(ff.refresh(ws), false, 'unchanged file: nothing to do');
  // The front saves a new chat (its own atomic write).
  atomicJson(file, [meta('f', 3), meta('a', 2), meta('b', 1)]);
  assert.equal(ff.refresh(ws), true);
  assert.equal(ws.freeChats, held, 'the array is updated in place');
  assert.deepEqual(ws.freeChats.map((c) => c.id), ['f', 'a', 'b']);
  assert.equal(ff.refresh(ws), false);
  // Nobody else wrote: this process's list is written as it is (its order too).
  ws.freeChats.splice(0, ws.freeChats.length, meta('b', 1), meta('a', 2));
  await ff.save(ws);
  assert.deepEqual(readFree(file).map((c) => c.id), ['b', 'a']);
  assert.equal(ff.refresh(ws), false, 'its own write is not taken for the other writer');
  // A delete here (a) while the front saved a new meta (g) and retitled b: both stand.
  ws.freeChats.splice(0, ws.freeChats.length, ...ws.freeChats.filter((c) => c.id !== 'a'));
  atomicJson(file, [meta('g', 9), meta('b', 1, { title: 'B2' }), meta('a', 2)]);
  await ff.save(ws);
  assert.deepEqual(readFree(file).map((c) => [c.id, c.title]), [['g', 'g'], ['b', 'B2']]);
  assert.deepEqual(ws.freeChats.map((c) => c.id), ['g', 'b'], 'this view is what was written');
  // Bytes are atomicJson's.
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(readFree(file), null, 2));
});

test('the coordinated free list: unsaved changes here survive a refresh; an unreadable file is kept until the next save', async () => {
  const dir = tmp(); const file = freeFile(dir);
  atomicJson(file, [meta('a', 1)]);
  const warned = [];
  const ff = rp.createFreeChatsFile(file, { remote: remoteFor(path.dirname(file)), warn: (m) => warned.push(m) });
  const ws = { freeChats: ff.load() };
  ws.freeChats.push(meta('local', 5)); // a failed save left this here
  atomicJson(file, [meta('a', 1), meta('front', 3)]);
  assert.equal(ff.refresh(ws), true);
  assert.deepEqual(ws.freeChats.map((c) => c.id), ['local', 'front', 'a']);
  fs.writeFileSync(file, '[{');
  assert.equal(ff.refresh(ws), false);
  assert.deepEqual(ws.freeChats.map((c) => c.id), ['local', 'front', 'a']);
  await ff.save(ws);
  assert.deepEqual(readFree(file).map((c) => c.id), ['local', 'front', 'a']);
  assert.equal(warned.length, 1);
  // A file that holds no list is read as Node's readJson reads it, and taken as it is.
  const odd = path.join(dir, 'odd.json');
  fs.writeFileSync(odd, '{"a":1}');
  const f2 = rp.createFreeChatsFile(odd, { remote: remoteFor(path.dirname(odd))  });
  const w2 = { freeChats: f2.load() };
  assert.deepEqual(w2.freeChats, { a: 1 });
  fs.writeFileSync(odd, '[{"id":"x"}]');
  fs.utimesSync(odd, new Date(), new Date(Date.now() + 5000));
  assert.equal(f2.refresh(w2), true);
  assert.deepEqual(w2.freeChats, [{ id: 'x' }]);
  assert.deepEqual(rp.createFreeChatsFile(path.join(dir, 'none.json'), { remote: remoteFor(dir) }).load(), []);
  fs.writeFileSync(path.join(dir, 'bad.json'), 'nope');
  assert.deepEqual(rp.createFreeChatsFile(path.join(dir, 'bad.json'), { remote: remoteFor(dir) }).load(), []);
});

test('the workspace store and free-chats.json: a request sees the front, says so once, and a delete here keeps the front\'s save', async () => {
  const changed = [];
  const store = storeWith(tmp(), { onProjectsChanged: (id) => changed.push(id) });
  const ws = store.get(USER);
  assert.ok(ws.freeChatsFile);
  ws.freeChats = [meta('keep', 2), meta('gone', 1)];
  await ws.saveFreeChats();
  store.get(USER);
  assert.deepEqual(changed, [], "Node's own save is not news");
  const file = freeFile(ws.dir);
  atomicJson(file, [meta('front', 3), ...readFree(file)]);
  store.get(USER); store.get(USER);
  assert.deepEqual(changed, [USER]);
  assert.deepEqual(ws.freeChats.map((c) => c.id), ['front', 'keep', 'gone']);
  // A delete here (no refresh since it started) while the front saved again.
  ws.freeChats = ws.freeChats.filter((c) => c.id !== 'gone');
  atomicJson(file, [meta('front2', 4), ...readFree(file)]);
  await ws.saveFreeChats();
  assert.deepEqual(readFree(file).map((c) => c.id), ['front2', 'front', 'keep']);
});

test('moveChat and deleteFreeChat through the coordinated free list keep a meta the front saved meanwhile', async () => {
  const { createProjectStore } = require('./projects.cjs');
  const store = storeWith(tmp());
  const ws = store.get(USER);
  ws.projects.push({ id: 'p1', name: 'One', modes: ['chat'], chats: [] });
  await ws.saveProjects();
  ws.freeChats = [meta('f1', 2), meta('f2', 1)];
  await ws.saveFreeChats();
  const proxy = (field) => new Proxy([], {
    get(_t, prop) { const v = ws[field][prop]; return typeof v === 'function' ? v.bind(ws[field]) : v; },
    set(_t, prop, v) { ws[field][prop] = v; return true; },
    ownKeys() { return Reflect.ownKeys(ws[field]); },
    getOwnPropertyDescriptor(_t, prop) { return Reflect.getOwnPropertyDescriptor(ws[field], prop); },
  });
  const projects = createProjectStore({ fs, path, currentWorkspace: () => ws, PROJECTS: proxy('projects'), FREE_CHATS: proxy('freeChats') });
  const file = freeFile(ws.dir);
  // The front saves a new free chat after this request started; the request moves f1 into p1.
  atomicJson(file, [meta('front', 5), ...readFree(file)]);
  assert.equal(projects.moveChat('f1', 'p1').status, 200);
  await ws.pendingStoreWrites();
  assert.deepEqual(readFree(file).map((c) => c.id), ['front', 'f2']);
  assert.deepEqual(read(path.join(ws.dir, 'projects.json'))[0].chats.map((c) => c.id), ['f1']);
  // Again for a delete.
  atomicJson(file, [meta('front2', 6), ...readFree(file)]);
  assert.equal(await projects.deleteFreeChat('f2'), true); // #1914: resolves once the save is written
  await ws.pendingStoreWrites();
  assert.deepEqual(readFree(file).map((c) => c.id), ['front2', 'front']);
});

test('setChatFlags reads both lists again first: a meta the front retitled during the turn keeps its title and gets the flags (sbstndalton/noevia#1426)', async () => {
  const { createProjectStore } = require('./projects.cjs');
  const changed = [];
  const store = storeWith(tmp());
  const ws = store.get(USER);
  ws.projects.push({ id: 'p1', name: 'One', modes: ['chat'], chats: [meta('c1', 1)] });
  await ws.saveProjects();
  ws.freeChats = [meta('f1', 2)];
  await ws.saveFreeChats();
  const proxy = (field) => new Proxy([], {
    get(_t, prop) { const v = ws[field][prop]; return typeof v === 'function' ? v.bind(ws[field]) : v; },
    set(_t, prop, v) { ws[field][prop] = v; return true; },
    ownKeys() { return Reflect.ownKeys(ws[field]); },
    getOwnPropertyDescriptor(_t, prop) { return Reflect.getOwnPropertyDescriptor(ws[field], prop); },
  });
  const projects = createProjectStore({ fs, path, currentWorkspace: () => ws, PROJECTS: proxy('projects'), FREE_CHATS: proxy('freeChats'), onProjectsChanged: (id) => changed.push(id) });
  const free = freeFile(ws.dir), projectsJson = path.join(ws.dir, 'projects.json');
  // While the turn waited for its route choice, the front retitled f1 and saved a new chat n1.
  atomicJson(free, [{ ...meta('f1', 9), title: 'Retitled' }, meta('n1', 8)]);
  assert.equal(projects.setChatFlags(null, 'n1', { allowCloud: true }), true, 'a chat the front first saved during the turn');
  await ws.pendingStoreWrites();
  assert.equal(projects.setChatFlags(null, 'f1', { forceLocal: true }), true);
  await ws.pendingStoreWrites();
  const saved = readFree(free);
  assert.deepEqual(saved.map((c) => [c.id, c.title, c.forceLocal, c.allowCloud]), [['f1', 'Retitled', true, undefined], ['n1', meta('n1', 8).title, undefined, true]]);
  // The same for a project's chat list.
  const onDisk = read(projectsJson);
  onDisk[0].chats = [{ ...meta('c1', 9), title: 'Retitled' }];
  atomicJson(projectsJson, { projects: onDisk });
  assert.equal(projects.setChatFlags('p1', 'c1', { forceLocal: false }), true);
  await ws.pendingStoreWrites();
  const chat = read(projectsJson)[0].chats[0];
  assert.deepEqual([chat.id, chat.title, chat.forceLocal], ['c1', 'Retitled', false]);
  assert.deepEqual(changed, [USER, USER], 'each refresh that took in the front nudged the mirror once');
  assert.equal(projects.setChatFlags(null, 'missing', { forceLocal: true }), false);
  await ws.pendingStoreWrites();
});
