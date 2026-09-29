'use strict';
// #648: project_append_file / project_replace_text edit an upload in the project's storage folder
// in place, and fail closed everywhere else. Real pieces end to end: the project store and its
// write path (projects.cjs, uploads.ingest), the Project documents tools (mcp-internal-tools.cjs),
// the capability token (mcp-internal.cjs, mcp-wiring.cjs), executeToolCall (toolboxes.cjs) and the
// chat loop's approval gate (chat.cjs). Only storage, RAG and the model are fakes. Synthetic
// projects and text only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createProjectStore } = require('./projects.cjs');
const { createInternalTools } = require('./mcp-internal-tools.cjs');
const internal = require('./mcp-internal.cjs');
const skills = require('./instruction-skills.cjs');
const { EDIT_TOOLS, targetDigest, resolveEditTarget } = require('./project-edit-target.cjs');

const ROOT = 'noevia projects';

// ── The server side: a store with fake storage, the real tools, the real token path ──

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-648-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = {
    dir, userId: 'user-a', projects: [], freeChats: [],
    saveProjects() {}, saveFreeChats() {},
    historyPath: (id) => path.join(dir, `${id}.json`),
    assetDir: (id) => path.join(dir, 'assets', id),
  };
  // Fake WebDAV storage with ETags. `put(p, text)` is a change made in storage by someone else;
  // `beforePut` runs just before a PUT lands (a change racing the edit); `noEtag` models a server
  // that reports none. `writeCalls` counts every writeFile call, including refused ones.
  const storage = { connected: true, objects: new Map(), etags: new Map(), writes: [], writeCalls: [], versionChecks: [], reads: [], serial: 0, noEtag: false, beforePut: null };
  storage.put = (p, text) => { storage.objects.set(p, text); storage.etags.set(p, `etag-${++storage.serial}`); };
  const indexed = [], unindexed = [];
  const storageClient = {
    isBrowsable: () => storage.connected,
    createFolder: async () => {},
    fileVersion: async (_conn, p) => { storage.versionChecks.push(p); return storage.objects.has(p) ? { exists: true, etag: storage.noEtag ? '' : storage.etags.get(p) } : { exists: false }; },
    readBinaryFile: async (_conn, p) => {
      storage.reads.push(p);
      if (!storage.objects.has(p)) throw Object.assign(new Error('storage returned 404'), { status: 404 });
      return Buffer.from(storage.objects.get(p), 'utf8');
    },
    writeFile: async (_conn, p, bytes, opts = {}) => {
      storage.writeCalls.push({ path: p, ifMatch: opts.ifMatch });
      if (storage.beforePut) { const hook = storage.beforePut; storage.beforePut = null; hook(p); }
      if (opts.ifMatch !== undefined && storage.etags.get(p) !== opts.ifMatch) throw Object.assign(new Error(`"${p}" changed in storage before it could be written (412)`), { status: 409, code: 'changed' });
      storage.writes.push(p);
      storage.put(p, Buffer.from(bytes).toString('utf8'));
    },
  };
  const store = createProjectStore({
    fs, path,
    reasoningEffort: { validEffort: () => true },
    projectAppearance: () => ({ icon: 'folder' }),
    rag: { indexProjectFile: async (...args) => { indexed.push(args); return { ok: true, stored: 1, embedded: 1 }; }, deleteProjectFile: (...args) => unindexed.push(args) },
    storageClient,
    documentSources: { prune() {}, directory: () => path.join(dir, 'docs') },
    authService: { getStorage: () => (storage.connected ? { kind: 'webdav', url: 'http://storage.invalid/' } : { kind: 'local' }) },
    currentWorkspace: () => workspace,
    PROJECTS: workspace.projects, FREE_CHATS: workspace.freeChats,
    sanitizeToolboxes: (boxes) => (Array.isArray(boxes) ? boxes : null),
    defaultToolboxes: () => ['core'],
    PROJECT_ROOT_FOLDER: ROOT,
    createProjectFolder: async (_s, _c, root, project) => `${root}/${project.name}`,
    projectSweep: { afterDelete: async () => {} },
  });
  const tools = createInternalTools({
    getProject: store.getProject, diary: async () => ({}),
    readProjectFile: async () => 'unused', ragAvailable: () => false, search: async () => [],
    writeTextFile: store.writeProjectTextFile,
  });

  // noevia's own MCP server, reached the way production reaches it: the chat's executeToolCall puts
  // the project and the approved target in the request scope, mcpInternalAuth mints the token, the
  // handler verifies it and builds ctx from it.
  const scope = new AsyncLocalStorage();
  const key = crypto.randomBytes(32);
  const isWriteTool = (name) => EDIT_TOOLS.has(name) || name === 'project_create_file';
  const wiring = require('./mcp-wiring.cjs').createMcpWiring({
    servers: [], manifest: [], mcp: {}, bindBoxes: () => [], directoryMcp: { asServers: () => [] }, mcpOAuth: {},
    directoryUrlAllowed: async () => true, credentialOriginAllowed: () => false, scope, storageFor: () => ({ kind: 'local' }),
    isWriteTool, internal, internalKey: key, reduceToolResult: (text) => ({ text, reduced: false }), logger: { log() {}, warn() {} },
  });
  const handle = internal.createHandler({ key, definitions: tools, runAs: (_uid, fn) => fn() });
  const tokens = [];
  const { executeToolCall } = require('./toolboxes.cjs').createToolboxes({
    scope, getProject: store.getProject,
    mcpTools: () => new Map([...Object.keys(tools)].map((n) => [n, { serverId: 'noevia', readOnly: !tools[n].write }])),
    documentSources: { notice: () => '' },
    async executeMcp(name, args) {
      const token = wiring.mcpInternalAuth(name).Authorization.slice('Bearer '.length);
      tokens.push(internal.verifyToken(key, token).claims);
      const out = await handle({ id: 1, method: 'tools/call', params: { name, arguments: args } }, token);
      if (!out.body.result) return `ERROR: ${out.body.error.message}`;
      return out.body.result.content[0].text;
    },
  });
  const asUser = (fn) => scope.run({ workspace, authn: { user: { id: 'user-a' } } }, fn);

  async function project(name, uploads = {}) {
    const p = await store.createProject({ name });
    for (const [base, text] of Object.entries(uploads)) await store.writeProjectTextFile(p, base, text);
    return p;
  }
  const ctxFor = (p, stored) => ({ userId: 'user-a', projectId: p.id, ...(stored ? { editTarget: targetDigest(stored) } : {}) });
  return { workspace, storage, store, tools, indexed, unindexed, scope, executeToolCall, asUser, tokens, project, ctxFor, isWriteTool, dir };
}

const snapshot = (w, p) => ({ files: structuredClone(p.files), objects: new Map(w.storage.objects), writes: w.storage.writes.length, indexed: w.indexed.length });

test('fixtures are the shape ingest gives a connected upload', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'Day one: arrive.\n' });
  const [file] = p.files;
  assert.equal(p.projectFolder, `${ROOT}/Trip`);
  assert.equal(file.name, `${ROOT}/Trip/Text/notes.md`);
  assert.equal(file.source, p.projectFolder);
  assert.equal(file.attachment.group, 'Text');
  assert.equal(file.attachment.state, 'ready');
  assert.match(file.attachment.id, /^[a-f0-9]{64}$/);
  assert.equal(w.storage.objects.get(file.name), 'Day one: arrive.\n');
});

test('append and replace edit the same storage object in place, by bare name and by full path', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'Day one: arrive.\n' });
  const stored = `${ROOT}/Trip/Text/notes.md`;
  const before = w.storage.writes.length;

  assert.equal(await w.tools.project_append_file.handler({ name: 'notes.md', text: 'Day two: museum.' }, w.ctxFor(p, stored)), `Appended 16 chars to "${stored}".`);
  assert.equal(w.storage.objects.get(stored), 'Day one: arrive.\nDay two: museum.');
  assert.equal(await w.tools.project_replace_text.handler({ name: stored, find: 'museum', replace: 'gallery' }, w.ctxFor(p, stored)), `Replaced 1 occurrence in "${stored}".`);
  assert.equal(w.storage.objects.get(stored), 'Day one: arrive.\nDay two: gallery.');

  assert.deepEqual(w.storage.writes.slice(before), [stored, stored], 'both writes went to the one stored object');
  assert.deepEqual([...w.storage.objects.keys()], [stored], 'no second object in storage');
  assert.deepEqual(p.files.map((f) => f.name), [stored], 'the source list still holds one file under its stored name');
  assert.equal(p.files[0].content, 'Day one: arrive.\nDay two: gallery.');
  assert.equal(p.files[0].source, p.projectFolder, 'still a connected upload');
  assert.ok(!fs.readdirSync(w.dir).some((n) => n === 'notes.md'), 'no bare-named local copy');
});

test('the RAG index and the source list are updated as a re-upload updates them', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'old text\n' });
  const stored = `${ROOT}/Trip/Text/notes.md`;
  const oldAttachment = p.files[0].attachment.id;
  w.indexed.length = 0;
  await w.tools.project_append_file.handler({ name: 'notes.md', text: 'FRESH-CANARY' }, w.ctxFor(p, stored));
  assert.deepEqual(w.indexed, [[p.id, stored, 'old text\nFRESH-CANARY', 'user-a']], 'reindexed under the stored name with the new text');
  assert.notEqual(p.files[0].attachment.id, oldAttachment, 'the attachment record describes the new bytes');
  assert.equal(p.files[0].attachment.bytes, Buffer.byteLength('old text\nFRESH-CANARY'));
});

test('storage disconnected at write time: refused, and nothing is written anywhere', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'Day one.\n' });
  const stored = `${ROOT}/Trip/Text/notes.md`;
  w.storage.connected = false;
  const before = snapshot(w, p);
  for (const call of [
    () => w.tools.project_append_file.handler({ name: 'notes.md', text: 'lost?' }, w.ctxFor(p, stored)),
    () => w.tools.project_replace_text.handler({ name: stored, find: 'one', replace: 'two' }, w.ctxFor(p, stored)),
  ]) await assert.rejects(call, /is kept in this project's storage, which is not connected right now, so it cannot be edited in place; nothing was saved/);
  assert.deepEqual(snapshot(w, p), before, 'no storage write, no new or changed file, no reindex');
  assert.ok(!p.files.some((f) => f.name === 'notes.md'), 'no bare-named duplicate');
  const originals = path.join(w.dir, 'project-uploads');
  const kept = fs.readdirSync(originals, { recursive: true }).filter((n) => !String(n).includes(path.sep) && fs.statSync(path.join(originals, n)).isFile());
  assert.deepEqual(kept, [], 'the originals directory holds no new bytes at its top level');
  // The reverse: a local file while storage is now connected would be written into the folder.
  w.storage.connected = false;
  const local = await w.project('Local', { 'plain.md': 'local\n' });
  assert.equal(local.files[0].name, 'plain.md');
  w.storage.connected = true;
  local.projectFolder = `${ROOT}/Local`;
  const writes = w.storage.writes.length;
  await assert.rejects(() => w.tools.project_append_file.handler({ name: 'plain.md', text: 'x' }, w.ctxFor(local, 'plain.md')), /would write "noevia projects\/Local\/Text\/plain\.md" instead of editing "plain\.md" in place; nothing was saved/);
  assert.equal(w.storage.writes.length, writes);
  assert.deepEqual(local.files.map((f) => [f.name, f.content]), [['plain.md', 'local\n']]);
});

test('the write path refuses an edit whose file changed or vanished after it was read', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'v1\n' });
  const stored = `${ROOT}/Trip/Text/notes.md`;
  const writes = w.storage.writes.length;
  await assert.rejects(() => w.store.writeProjectTextFile(p, 'notes.md', 'x', { expectName: stored, expectContent: 'v0\n' }), /changed while this edit was being made; nothing was saved/);
  await assert.rejects(() => w.store.writeProjectTextFile(p, 'other.md', 'x', { expectName: `${ROOT}/Trip/Text/other.md`, expectContent: '' }), /no longer in this project; nothing was saved/);
  await assert.rejects(() => w.store.writeProjectTextFile(p, 'notes.md', 'x', { expectName: '' }), /must name the stored file/);
  // A plain name that lands elsewhere than the expected file: refused before storage is touched.
  await assert.rejects(() => w.store.writeProjectTextFile(p, 'notes.txt', 'x', { expectName: stored, expectContent: 'v1\n', expectAttachment: p.files[0].attachment.id }), /instead of editing/);
  // An edit that does not say which stored version it was planned against is refused too.
  await assert.rejects(() => w.store.writeProjectTextFile(p, 'notes.md', 'x', { expectName: stored, expectContent: 'v1\n' }), /changed since this edit was prepared/);
  assert.equal(w.storage.writes.length, writes);
  assert.equal(w.storage.objects.get(stored), 'v1\n');
});

test('files from an attached folder, and other non-editable files, are refused with their own messages', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'x\n' });
  p.sourceFolders = [...p.sourceFolders, 'Reference/Shared'];
  p.files.push({ name: 'Reference/Shared/plan.md', content: 'shared plan', source: 'Reference/Shared' });
  p.files.push({ name: `${ROOT}/Trip/plan-at-root.md`, content: 'misplaced', source: p.projectFolder, attachment: { id: 'b'.repeat(64), group: 'Text', state: 'ready' } });
  p.files.push({ name: `${ROOT}/Trip/Text/latin.txt`, content: 'café', source: p.projectFolder, attachment: { id: 'c'.repeat(64), group: 'Text', state: 'partial', reasonId: 'encoding' } });
  p.files.push({ name: `${ROOT}/Trip/Text/blob.txt`, content: '', source: p.projectFolder, attachment: { id: 'd'.repeat(64), group: 'Text', state: 'stored', reasonId: 'binaryText' } });
  const before = snapshot(w, p);
  const cases = [
    ['plan.md', 'Reference/Shared/plan.md', /comes from the attached folder "Reference\/Shared" and is kept in sync from there\. Edit it in that folder instead\./],
    ['plan-at-root.md', `${ROOT}/Trip/plan-at-root.md`, /is not stored where this project's uploads are kept/],
    ['latin.txt', `${ROOT}/Trip/Text/latin.txt`, /only read in part or in another encoding/],
    ['blob.txt', `${ROOT}/Trip/Text/blob.txt`, /stored in its original format and has no editable text/],
  ];
  for (const [name, stored, reason] of cases) {
    await assert.rejects(() => w.tools.project_append_file.handler({ name, text: 'y' }, w.ctxFor(p, stored)), reason);
    await assert.rejects(() => w.tools.project_replace_text.handler({ name, find: 'a', replace: 'b' }, w.ctxFor(p, stored)), reason);
    assert.match(resolveEditTarget(p, JSON.stringify({ name })).error, reason, 'the approval gate refuses it too');
  }
  assert.deepEqual(snapshot(w, p), before);
});

test('traversal-shaped names are refused and nothing is written', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'x\n' });
  const before = snapshot(w, p);
  for (const name of ['../notes.md', `${ROOT}/Trip/Text/../Text/notes.md`, `/${ROOT}/Trip/Text/notes.md`, 'Text\\notes.md', '..%2Fnotes.md', 'notes.md\u0000', `${ROOT}//Trip/Text/notes.md`, '']) {
    const pin = w.ctxFor(p, `${ROOT}/Trip/Text/notes.md`);
    await assert.rejects(() => w.tools.project_append_file.handler({ name, text: 'y' }, pin), /not a usable project file name/);
    await assert.rejects(() => w.tools.project_replace_text.handler({ name, find: 'x', replace: 'y' }, pin), /not a usable project file name/);
    assert.match(resolveEditTarget(p, JSON.stringify({ name })).error, /not a usable project file name/);
  }
  assert.deepEqual(snapshot(w, p), before);
});

test("another project's upload cannot be edited, by its name or its full path", async (t) => {
  const w = world(t);
  const a = await w.project('Alpha', { 'mine.md': 'alpha\n' });
  const b = await w.project('Beta', { 'secret.md': 'BETA-SECRET\n' });
  const theirs = `${ROOT}/Beta/Text/secret.md`;
  const before = snapshot(w, b);
  for (const name of ['secret.md', theirs, 'Text/secret.md']) {
    await assert.rejects(() => w.tools.project_append_file.handler({ name, text: 'x' }, w.ctxFor(a, theirs)), /no project file named/);
    assert.match(resolveEditTarget(a, JSON.stringify({ name })).error, /no project file named/);
  }
  // The project comes from the token only; an injected projectId argument is ignored.
  await assert.rejects(() => w.tools.project_append_file.handler({ name: 'secret.md', text: 'x', projectId: b.id }, w.ctxFor(a, theirs)), /no project file named/);
  assert.deepEqual(snapshot(w, b), before);
  assert.equal(w.storage.objects.get(theirs), 'BETA-SECRET\n');
});

test('an edit is refused without a pin, or pinned to a different file than it now resolves to', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'x\n', 'other.md': 'y\n' });
  const before = snapshot(w, p);
  await assert.rejects(() => w.tools.project_append_file.handler({ name: 'notes.md', text: 'z' }, w.ctxFor(p)), /not tied to a file when it was approved/);
  await assert.rejects(() => w.tools.project_append_file.handler({ name: 'notes.md', text: 'z' }, w.ctxFor(p, `${ROOT}/Trip/Text/other.md`)), /now refers to "noevia projects\/Trip\/Text\/notes\.md", which is not the file that was approved/);
  assert.deepEqual(snapshot(w, p), before);
  // The pin travels inside the HMAC'd token: executeToolCall puts it there, the handler reads it.
  const out = await w.asUser(() => w.executeToolCall({ id: p.id }, 'project_append_file', JSON.stringify({ name: 'notes.md', text: 'z' }), null, undefined, {}, { editTarget: targetDigest(`${ROOT}/Trip/Text/notes.md`) }));
  assert.match(out, /^Appended 1 chars/);
  assert.equal(w.tokens.at(-1).t, targetDigest(`${ROOT}/Trip/Text/notes.md`));
  assert.equal(w.tokens.at(-1).w, 1);
  const unpinned = await w.asUser(() => w.executeToolCall({ id: p.id }, 'project_append_file', JSON.stringify({ name: 'notes.md', text: 'z' }), null));
  assert.match(unpinned, /^ERROR: this edit was not tied to a file/);
  assert.equal(w.tokens.at(-1).t, undefined, 'no pin in the token when none was approved');
  // A read never carries one, even if the scope had one.
  await w.asUser(() => w.executeToolCall({ id: p.id }, 'project_list_files', '{}', null, undefined, {}, { editTarget: 'x'.repeat(64) }));
  assert.equal(w.tokens.at(-1).t, undefined);
});

// ── Storage as the authority: never overwrite what changed there since the last sync ──

const originalsOf = (w) => {
  const dir = path.join(w.dir, 'project-uploads');
  return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : [];
};
const CHANGED = /changed in storage since noevia last read it .*Nothing was saved\. Sync this project's Sources first, then try again\./;

test('the edit reads the file back from storage and writes with If-Match on the ETag it saw', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'v1\n' });
  const stored = `${ROOT}/Trip/Text/notes.md`;
  const etag = w.storage.etags.get(stored);
  w.storage.writeCalls.length = 0;
  await w.tools.project_append_file.handler({ name: 'notes.md', text: 'v2' }, w.ctxFor(p, stored));
  assert.deepEqual(w.storage.versionChecks, [stored]);
  assert.deepEqual(w.storage.reads, [stored]);
  assert.deepEqual(w.storage.writeCalls, [{ path: stored, ifMatch: etag }], 'one conditional PUT on the ETag that was checked');
  assert.equal(w.storage.objects.get(stored), 'v1\nv2');
});

test('a file edited in storage since the last sync is refused, and writeFile is never called', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'v1\n' });
  const stored = `${ROOT}/Trip/Text/notes.md`;
  w.storage.put(stored, 'v1\nEDITED IN NEXTCLOUD\n'); // not re-synced: noevia still holds v1
  const before = snapshot(w, p), originals = originalsOf(w);
  w.storage.writeCalls.length = 0;
  await assert.rejects(() => w.tools.project_append_file.handler({ name: 'notes.md', text: 'v2' }, w.ctxFor(p, stored)), CHANGED);
  await assert.rejects(() => w.tools.project_replace_text.handler({ name: 'notes.md', find: 'v1', replace: 'v0' }, w.ctxFor(p, stored)), CHANGED);
  assert.deepEqual(w.storage.writeCalls, [], 'no PUT was attempted');
  assert.equal(w.storage.objects.get(stored), 'v1\nEDITED IN NEXTCLOUD\n', 'the edit made in storage survives');
  assert.deepEqual(snapshot(w, p).files, before.files);
  assert.equal(w.indexed.length, before.indexed);
  assert.deepEqual(originalsOf(w), originals);
  // Without an ETag the byte check alone still refuses.
  w.storage.noEtag = true;
  await assert.rejects(() => w.tools.project_append_file.handler({ name: 'notes.md', text: 'v2' }, w.ctxFor(p, stored)), CHANGED);
  assert.deepEqual(w.storage.writeCalls, []);
});

test('a server that reports no ETag gets no edit: refused even when the bytes match, and writeFile is never called', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'v1\n' });
  const stored = `${ROOT}/Trip/Text/notes.md`;
  w.storage.noEtag = true; // fileVersion answers { exists: true, etag: '' }; the bytes still match
  const before = snapshot(w, p), originals = originalsOf(w);
  w.storage.writeCalls.length = 0;
  for (const call of [
    () => w.tools.project_append_file.handler({ name: 'notes.md', text: 'v2' }, w.ctxFor(p, stored)),
    () => w.tools.project_replace_text.handler({ name: 'notes.md', find: 'v1', replace: 'v0' }, w.ctxFor(p, stored)),
  ]) await assert.rejects(call, /cannot be edited in place: this storage server does not report file versions \(ETags\).*Nothing was saved/);
  assert.deepEqual(w.storage.versionChecks.slice(-2), [stored, stored], 'the version was asked for');
  assert.deepEqual(w.storage.writeCalls, [], 'no PUT, conditional or not');
  assert.equal(w.storage.objects.get(stored), 'v1\n');
  assert.deepEqual(snapshot(w, p).files, before.files);
  assert.equal(w.indexed.length, before.indexed);
  assert.deepEqual(originalsOf(w), originals);
});

test('a file deleted or moved in storage (404) is refused and not resurrected; so is another account\'s storage', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'v1\n' });
  const stored = `${ROOT}/Trip/Text/notes.md`;
  w.storage.objects.delete(stored); w.storage.etags.delete(stored);
  w.storage.writeCalls.length = 0;
  const before = snapshot(w, p);
  await assert.rejects(() => w.tools.project_append_file.handler({ name: 'notes.md', text: 'v2' }, w.ctxFor(p, stored)), CHANGED);
  assert.deepEqual(w.storage.writeCalls, []);
  assert.equal(w.storage.objects.has(stored), false, 'not written back');
  assert.deepEqual(snapshot(w, p).files, before.files);
  // A reconnect to a different account: the same path holds other bytes there. Refused.
  w.storage.put(stored, 'someone else\'s notes.md\n');
  await assert.rejects(() => w.tools.project_append_file.handler({ name: 'notes.md', text: 'v2' }, w.ctxFor(p, stored)), CHANGED);
  assert.deepEqual(w.storage.writeCalls, []);
  assert.equal(w.storage.objects.get(stored), 'someone else\'s notes.md\n');
});

test('a change landing between the check and the PUT gets 412: refused, nothing half-written', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'v1\n' });
  const stored = `${ROOT}/Trip/Text/notes.md`;
  const before = snapshot(w, p), originals = originalsOf(w);
  w.storage.beforePut = (target) => w.storage.put(target, 'v1\nRACED IN\n');
  await assert.rejects(() => w.tools.project_append_file.handler({ name: 'notes.md', text: 'v2' }, w.ctxFor(p, stored)), CHANGED);
  assert.equal(w.storage.objects.get(stored), 'v1\nRACED IN\n', 'the concurrent change is what storage holds');
  assert.equal(w.storage.writes.length, before.writes, 'the conditional PUT did not land');
  assert.deepEqual(snapshot(w, p).files, before.files, 'the source list is unchanged');
  assert.equal(w.indexed.length, before.indexed, 'nothing reindexed');
  assert.deepEqual(originalsOf(w), originals, 'no new original saved');
});

test('a sync that makes the file partial (or re-reads it) between plan and lock is refused', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'v1\n' });
  const stored = `${ROOT}/Trip/Text/notes.md`;
  let release;
  const held = new Promise((r) => { release = r; });
  // A folder sync holds the source lock; the edit plans against the ready file, then queues.
  const sync = w.store.withSourceLock(p, async () => {
    await held;
    const [file] = p.files;
    p.files = [{ ...file, attachment: { ...file.attachment, state: 'partial', reasonId: 'encoding' } }];
  });
  const edit = w.tools.project_append_file.handler({ name: 'notes.md', text: 'v2' }, w.ctxFor(p, stored));
  await new Promise((r) => setImmediate(r));
  w.storage.writeCalls.length = 0;
  release();
  await sync;
  await assert.rejects(edit, /changed since this edit was prepared; nothing was saved\. Sync this project's Sources/);
  assert.deepEqual(w.storage.writeCalls, []);
  assert.equal(w.storage.objects.get(stored), 'v1\n');

  // Same text, different stored version (the sync re-read other bytes): refused as well.
  const q = await w.project('Other', { 'notes.md': 'same\n' });
  const qStored = `${ROOT}/Other/Text/notes.md`;
  let release2;
  const held2 = new Promise((r) => { release2 = r; });
  const sync2 = w.store.withSourceLock(q, async () => { await held2; q.files = [{ ...q.files[0], attachment: { ...q.files[0].attachment, id: 'f'.repeat(64) } }]; });
  const edit2 = w.tools.project_append_file.handler({ name: 'notes.md', text: 'x' }, w.ctxFor(q, qStored));
  await new Promise((r) => setImmediate(r));
  release2(); await sync2;
  await assert.rejects(edit2, /changed since this edit was prepared/);
  assert.equal(w.storage.objects.get(qStored), 'same\n');
});

// ── The chat loop: what the approval card shows and what runs after it ──

async function chat(t, w, p, { rounds, onApproval, chatWide = false, router = null }) {
  p.model = 'answer-model';
  const events = [], res = new EventEmitter(), audits = [], requests = [], approvals = [];
  let reply = null;
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6))); res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const step = rounds[requests.length - 1] || { content: 'synthetic reply' };
    const delta = step.tool ? { tool_calls: [{ index: 0, id: `call-${requests.length}`, function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } }] } : { content: step.content };
    return { ok: true, body: (async function* () {
      yield Buffer.from('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
      yield Buffer.from('data: [DONE]\n\n');
    })() };
  };
  const executed = [];
  const { handleChat } = require('./chat.cjs').createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit: (...a) => audits.push(a), diaryEnabled: () => true }, crypto, path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange: require('./tool-exchange.cjs').createToolExchange, currentWorkspace: () => w.workspace, getProject: w.store.getProject,
    skillsIndexFor: (proj) => skills.enabled(proj), getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid' }),
    providerHeaders: () => ({}), autoRoles: () => null, visionDescriptions: new Map(), visionProbe: require('./vision.cjs').createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async (rows) => (router ? router(rows) : { loaded: [] }) },
    oauthServerIds: () => new Set(), accountReady: () => true,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: (_u, _n, write) => (write ? 'ask' : 'allow') }, requestScope: w.scope,
    resolveTools: () => ({ tools: ['project_append_file', 'project_replace_text', 'project_list_files'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })), dropped: [] }),
    isWriteTool: w.isWriteTool,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (text) => ({ text }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: (_res, status, payload) => { reply = { status, payload }; }, saveChats: () => {},
    endpointApproved: () => true, diaryHeaders: () => ({}), lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [],
    modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null, allToolboxes: () => [{ id: 'core' }],
    executeToolCall: async (...args) => { executed.push(args[1]); return w.executeToolCall(...args); },
    chatWideApproved: () => chatWide,
    awaitApproval: async (a) => { approvals.push(a.id); await onApproval?.(); return 'approve'; }, recordUsage() {}, recordToolUse() {},
  });
  await w.asUser(() => handleChat({}, res, { projectId: p.id, chatId: 'chat-648', message: 'synthetic request' }, { user: { id: 'user-a' } }));
  assert.equal(reply, null, `the chat started: ${JSON.stringify(reply)}`);
  const results = events.filter((e) => e.type === 'tool_result');
  return { events, audits, requests, approvals, executed, pending: events.filter((e) => e.type === 'tool_pending'), results };
}

test('chat: the approval card carries the resolved full path beside the raw argument, and the edit lands there', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'Day one.\n' });
  const stored = `${ROOT}/Trip/Text/notes.md`;
  const r = await chat(t, w, p, { rounds: [{ tool: 'project_append_file', args: { name: 'notes.md', text: 'Day two.' } }] });
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].target, stored);
  assert.equal(JSON.parse(r.pending[0].args).name, 'notes.md', 'the model\'s own argument is shown unchanged');
  assert.equal(r.approvals.length, 1, 'the gate still asked');
  assert.match(r.results[0].text, new RegExp(`^Appended 8 chars to "${stored}"`));
  assert.equal(w.storage.objects.get(stored), 'Day one.\nDay two.');
  const write = r.audits.find(([kind]) => kind === 'tool.write');
  assert.equal(write[3].target, stored, 'the audit log names the file too');
});

test('chat: allow-for-this-chat still pins the edit to the file resolved at the gate', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'a\n' });
  const r = await chat(t, w, p, { chatWide: true, rounds: [{ tool: 'project_replace_text', args: { name: 'notes.md', find: 'a', replace: 'b' } }] });
  assert.equal(r.pending.length, 0);
  assert.match(r.results[0].text, /^Replaced 1 occurrence/);
  assert.equal(w.tokens.at(-1).t, targetDigest(`${ROOT}/Trip/Text/notes.md`));
});

test('chat: a name that cannot be edited is refused before any card is shown', async (t) => {
  const w = world(t);
  const p = await w.project('Trip', { 'notes.md': 'a\n' });
  p.files.push({ name: 'Reference/Shared/notes.md', content: 'shared', source: 'Reference/Shared' });
  const before = snapshot(w, p);
  for (const args of [{ name: 'notes.md', text: 'x' }, { name: '../notes.md', text: 'x' }, { name: 'Shared/notes.md', text: 'x' }, { name: 'absent.md', text: 'x' }]) {
    const r = await chat(t, w, p, { rounds: [{ tool: 'project_append_file', args }] });
    assert.equal(r.pending.length, 0, JSON.stringify(args));
    assert.deepEqual(r.executed, []);
    assert.match(r.results[0].text, /^ERROR: .*project_append_file was not run and nothing was changed\./);
    assert.ok(r.audits.some(([kind, , , d]) => kind === 'tool.denied' && d.reason === 'edit-target'));
  }
  assert.deepEqual(snapshot(w, p), before);
});

test('chat: a file-list change between approval and execution is refused', async (t) => {
  const w = world(t);
  // The approved file is replaced by a different one the same bare name reaches.
  const p = await w.project('Trip', { 'notes.md': 'approved file\n' });
  const stored = `${ROOT}/Trip/Text/notes.md`;
  const r = await chat(t, w, p, {
    rounds: [{ tool: 'project_append_file', args: { name: 'notes.md', text: 'x' } }],
    onApproval: () => { p.files = [{ name: 'notes.md', content: 'a different local file\n' }]; },
  });
  assert.equal(r.pending[0].target, stored);
  assert.deepEqual(r.executed, [], 'the tool never ran');
  assert.match(r.results[0].text, /^ERROR: the project's files changed after approval, so "noevia projects\/Trip\/Text\/notes\.md" is no longer the file this name refers to \(it now means "notes\.md"\)\. project_append_file was not run and nothing was changed/);
  assert.deepEqual(p.files.map((f) => [f.name, f.content]), [['notes.md', 'a different local file\n']]);
  assert.equal(w.storage.objects.get(stored), 'approved file\n');
  assert.ok(r.audits.some(([kind, , , d]) => kind === 'tool.denied' && d.reason === 'edit-target-changed'));

  // A second file with the same bare name makes it ambiguous: also refused.
  const w2 = world(t);
  const q = await w2.project('Trip', { 'notes.md': 'approved\n' });
  const r2 = await chat(t, w2, q, {
    rounds: [{ tool: 'project_replace_text', args: { name: 'notes.md', find: 'approved', replace: 'changed' } }],
    onApproval: () => { q.files.push({ name: 'Reference/Shared/notes.md', content: 'approved', source: 'Reference/Shared' }); },
  });
  assert.deepEqual(r2.executed, []);
  assert.match(r2.results[0].text, /^ERROR: the project's files changed after approval, so "noevia projects\/Trip\/Text\/notes\.md" can no longer be edited/);
  assert.equal(w2.storage.objects.get(`${ROOT}/Trip/Text/notes.md`), 'approved\n');
});

test('chat: editing an uploaded SKILL.md counts as loading it, so the changed skill is revoked', async (t) => {
  const w = world(t);
  const content = '---\nname: synthetic-helper\ndescription: A synthetic fixture skill\nversion: 1.0.0\n---\nAnswer in synthetic haiku.\n';
  const p = await w.project('Trip', { 'SKILL.md': content });
  const stored = `${ROOT}/Trip/Text/SKILL.md`;
  p.instructionSkills = { [stored]: { enabled: true, reviewedHash: skills.hash(content) } };
  assert.equal(skills.list(p)[0].status, 'enabled');
  const r = await chat(t, w, p, { rounds: [{ tool: 'project_append_file', args: { name: 'SKILL.md', text: 'Also answer in rhyme.' } }, { content: 'should never be asked for' }] });
  assert.equal(r.pending[0].target, stored);
  assert.match(r.results[0].text, new RegExp(`^Appended .* to "${stored}"`));
  assert.equal(w.storage.objects.get(stored), `${content}Also answer in rhyme.`);
  assert.equal(r.requests.length, 1, 'the edited skill was tracked and is revoked, so no further round ran');
  const error = r.events.find((e) => e.type === 'error');
  assert.equal(error?.code, 'skill_revoked');
  assert.match(error.text, /"synthetic-helper"/);
  assert.deepEqual(w.unindexed.at(-1).slice(0, 2), [p.id, stored], 'a skill file stays out of the RAG index');
});
