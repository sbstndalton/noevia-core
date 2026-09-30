'use strict';
// #687: a text file added in the Create-project dialog can be edited in place. With storage
// connected the dialog's files are stored like any upload (in the project folder); a project made
// before that fix (a plain-named copy kept by noevia, a reserved folder, no project folder) has the
// file moved into the folder on its first approved edit, at the path the approval card shows. The
// #648 safety stays: the card shows the resolved path, the call is pinned to it, nothing is written
// anywhere else, and an existing file in storage is never overwritten. Real project store, tools,
// token path and chat loop; fake storage, RAG and model. Synthetic projects and text only.
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
const { EDIT_TOOLS, targetDigest, resolveEditTarget, storageAccount } = require('./project-edit-target.cjs');

const ROOT = 'noevia projects';
const NOTES = 'Line one.\nLine two.\nLine three.\n';

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-687-'));
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
  const storage = { folderCreations: [], takenFolders: new Set(), folderFails: false, failWrites: false, connected: true, objects: new Map(), etags: new Map(), writes: [], writeCalls: [], versionChecks: [], reads: [], serial: 0, noEtag: false, beforePut: null };
  // Case-insensitive storage (as many Nextcloud/SMB-backed servers are) when `caseInsensitive`.
  const fold = (k) => (storage.caseInsensitive && typeof k === 'string' ? k.toLowerCase() : k);
  for (const m of [storage.objects, storage.etags]) for (const op of ['get', 'set', 'has', 'delete']) { const f = m[op].bind(m); m[op] = (k, ...rest) => f(fold(k), ...rest); }
  storage.user = 'synthetic-user-a';
  storage.conn = () => (storage.connected ? { kind: 'webdav', url: 'http://storage.invalid/', username: storage.user } : { kind: 'local' });
  storage.account = () => (storage.connected ? storageAccount(storage.conn()) : null);
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
      storage.writeCalls.push({ path: p, ifMatch: opts.ifMatch, ifNoneMatch: opts.ifNoneMatch });
      if (storage.beforePut) { const hook = storage.beforePut; storage.beforePut = null; hook(p); }
      if (opts.ifMatch !== undefined && storage.etags.get(p) !== opts.ifMatch) throw Object.assign(new Error(`"${p}" changed in storage before it could be written (412)`), { status: 409, code: 'changed' });
      if (opts.ifNoneMatch === '*' && storage.objects.has(p)) throw Object.assign(new Error(`"${p}" already exists in storage, so it was not overwritten (412)`), { status: 409, code: 'changed' });
      if (storage.failWrites) throw Object.assign(new Error('could not write (503)'), { status: 502 });
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
    authService: { getStorage: () => storage.conn() },
    currentWorkspace: () => workspace,
    PROJECTS: workspace.projects, FREE_CHATS: workspace.freeChats,
    sanitizeToolboxes: (boxes) => (Array.isArray(boxes) ? boxes : null),
    defaultToolboxes: () => ['core'],
    PROJECT_ROOT_FOLDER: ROOT,
    // Like project-folders.cjs: the reserved path unless MKCOL finds it taken, then "Name (2)".
    createProjectFolder: async (_s, _c, root, project) => {
      storage.folderCreations.push(project.id);
      if (storage.folderFails) throw new Error('storage returned 503');
      const base = project.reservedFolder || `${root}/${project.name}`;
      return storage.takenFolders.has(base) ? `${base} (2)` : base;
    },
    projectSweep: { afterDelete: async () => {} },
  });
  const tools = createInternalTools({
    getProject: store.getProject, diary: async () => ({}),
    readProjectFile: async () => 'unused', ragAvailable: () => false, search: async () => [],
    writeTextFile: store.writeProjectTextFile,
    storageAccount: () => storage.account(),
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


// ── The chat loop ──

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
    editStorageAccount: (userId) => (userId === 'user-a' ? w.storage.account() : null),
    awaitApproval: async (a) => { approvals.push(a.id); await onApproval?.(); return 'approve'; }, recordUsage() {}, recordToolUse() {},
  });
  await w.asUser(() => handleChat({}, res, { projectId: p.id, chatId: 'chat-687', message: 'synthetic request' }, { user: { id: 'user-a' } }));
  assert.equal(reply, null, `the chat started: ${JSON.stringify(reply)}`);
  const results = events.filter((e) => e.type === 'tool_result');
  return { events, audits, requests, approvals, executed, pending: events.filter((e) => e.type === 'tool_pending'), results };
}


// A project as the Create-project dialog left it before this fix (the live r15 shape): storage was
// connected, so a folder was reserved, but the file stayed a plain-named copy with no project folder.
function legacyProject(w, name = 'qa-687-project', file = 'qa-687-notes.md', content = NOTES) {
  const p = {
    id: `proj-legacy-${name}`, name, pinned: false, archived: false, sourceFolders: [], routing: 'auto', modes: ['chat'],
    toolboxes: ['core', 'project-docs'], chats: [], memories: [], createdAt: 1, updatedAt: 1,
    reservedFolder: `${ROOT}/${name}`, files: [{ name: file, content }],
  };
  w.workspace.projects.unshift(p);
  return p;
}
// A token for an approved edit: a move into the folder is bound to the storage account as well.
const ctx = (w, p, target, account = w.storage.account()) => ({ userId: 'user-a', projectId: p.id, editTarget: targetDigest(target, target.includes('/') ? account : null) });

test('create with files, storage connected: the file is stored in the project folder like an upload', async (t) => {
  const w = world(t);
  const p = await w.store.createProject({ name: 'Trip', files: [{ name: 'qa-687-notes.md', content: NOTES }] });
  const stored = `${ROOT}/Trip/Text/qa-687-notes.md`;
  assert.equal(p.projectFolder, `${ROOT}/Trip`);
  assert.deepEqual(p.sourceFolders, [p.projectFolder]);
  assert.equal(p.files.length, 1);
  assert.equal(p.files[0].name, stored);
  assert.equal(p.files[0].source, p.projectFolder);
  assert.equal(p.files[0].attachment.state, 'ready');
  assert.equal(w.storage.objects.get(stored), NOTES);
  assert.deepEqual(w.storage.writeCalls.map((c) => c.path), [stored]);
  assert.ok(w.indexed.some((a) => a[1] === stored), 'indexed under its stored name');
  assert.ok(!w.indexed.some((a) => a[1] === 'qa-687-notes.md'), 'never indexed under the plain name');
  assert.equal(resolveEditTarget(p, JSON.stringify({ name: 'qa-687-notes.md' }), { storageAccount: 'acct' }).path, stored);
});

test('create with files, then append: edited in place with If-Match, the card path is the stored path', async (t) => {
  const w = world(t);
  const p = await w.store.createProject({ name: 'Trip', files: [{ name: 'qa-687-notes.md', content: NOTES }] });
  const stored = `${ROOT}/Trip/Text/qa-687-notes.md`;
  const r = await chat(t, w, p, { rounds: [{ tool: 'project_append_file', args: { name: 'qa-687-notes.md', text: 'Zusatz: 687' } }] });
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].target, stored, 'the card shows the storage path, not the bare name');
  assert.match(r.results[0].text, new RegExp(`^Appended 11 chars to "${stored}"`));
  assert.equal(w.storage.objects.get(stored), `${NOTES}Zusatz: 687`);
  const put = w.storage.writeCalls.at(-1);
  assert.equal(put.path, stored);
  assert.ok(put.ifMatch, 'a conditional write on the ETag it read');
  assert.equal(p.files.length, 1);
});

test('create with files, storage not connected: kept in noevia and edited under the plain name', async (t) => {
  const w = world(t);
  w.storage.connected = false;
  const p = await w.store.createProject({ name: 'Local', files: [{ name: 'notes.md', content: 'a\n' }] });
  assert.equal(p.projectFolder, undefined);
  assert.deepEqual(p.files.map((f) => f.name), ['notes.md']);
  assert.equal(w.storage.folderCreations.length, 0);
  const r = await chat(t, w, p, { rounds: [{ tool: 'project_append_file', args: { name: 'notes.md', text: 'b' } }] });
  assert.equal(r.pending[0].target, 'notes.md');
  assert.match(r.results[0].text, /^Appended 1 chars to "notes.md"/);
  assert.equal(p.files.find((f) => f.name === 'notes.md').content, 'a\nb');
  assert.deepEqual(w.storage.writeCalls, []);
});

test('create with files, storage failing: the project is still created and the file kept in noevia', async (t) => {
  const w = world(t);
  w.storage.failWrites = true;
  const p = await w.store.createProject({ name: 'Flaky', files: [{ name: 'notes.md', content: 'a\n' }] });
  assert.ok(w.store.getProject(p.id));
  assert.deepEqual(p.files.map((f) => f.name), ['notes.md']);
  assert.equal(p.files[0].content, 'a\n');
  // Folder creation failing is the same: created, kept.
  const w2 = world(t);
  w2.storage.folderFails = true;
  const q = await w2.store.createProject({ name: 'NoFolder', files: [{ name: 'notes.md', content: 'a\n' }] });
  assert.deepEqual(q.files.map((f) => f.name), ['notes.md']);
  assert.equal(q.projectFolder, undefined);
});

test('an existing affected project: the first edit moves the file into the folder shown on the card', async (t) => {
  const w = world(t);
  const p = legacyProject(w);
  const target = `${ROOT}/qa-687-project/Text/qa-687-notes.md`;
  const r = await chat(t, w, p, { rounds: [{ tool: 'project_append_file', args: { name: 'qa-687-notes.md', text: 'Zusatz: r15' } }] });
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].target, target, 'the card shows where it will be stored');
  assert.equal(r.approvals.length, 1, 'still asked');
  assert.match(r.results[0].text, new RegExp(`^Appended 11 chars to "${target}"`));
  assert.equal(p.projectFolder, `${ROOT}/qa-687-project`, 'the reserved folder became the project folder');
  assert.deepEqual(p.sourceFolders, [p.projectFolder]);
  assert.equal(w.storage.objects.get(target), `${NOTES}Zusatz: r15`);
  assert.deepEqual(w.storage.writeCalls.map((c) => [c.path, c.ifNoneMatch]), [[target, '*']], 'one create-only write, nowhere else');
  assert.deepEqual(p.files.map((f) => f.name), [target], 'the plain-named copy is gone');
  assert.equal(p.files[0].source, p.projectFolder);
  assert.equal(p.files[0].attachment.state, 'ready');
  assert.ok(w.unindexed.some((a) => a[0] === p.id && a[1] === 'qa-687-notes.md' && a[2] === 'user-a'), 'the plain name leaves the index');
  assert.equal(r.audits.find(([k]) => k === 'tool.write')[3].target, target);
  // From now on it is an ordinary connected upload: the next edit is in place with If-Match.
  const again = await chat(t, w, p, { rounds: [{ tool: 'project_replace_text', args: { name: 'qa-687-notes.md', find: 'r15', replace: 'r16' } }] });
  assert.equal(again.pending[0].target, target);
  assert.ok(w.storage.writeCalls.at(-1).ifMatch);
  assert.equal(w.storage.objects.get(target), `${NOTES}Zusatz: r16`);
});

test('an existing affected project whose reserved folder is taken: refused, nothing written, next card shows the real folder', async (t) => {
  const w = world(t);
  const p = legacyProject(w);
  w.storage.takenFolders.add(`${ROOT}/qa-687-project`);
  const shown = `${ROOT}/qa-687-project/Text/qa-687-notes.md`;
  await assert.rejects(w.tools.project_append_file.handler({ name: 'qa-687-notes.md', text: 'x' }, ctx(w, p, shown)),
    /saving now would write "noevia projects\/qa-687-project \(2\)\/Text\/qa-687-notes\.md" instead of "noevia projects\/qa-687-project\/Text\/qa-687-notes\.md", the file that was approved; nothing was saved/);
  assert.deepEqual(w.storage.writeCalls, []);
  assert.deepEqual(p.files.map((f) => [f.name, f.content]), [['qa-687-notes.md', NOTES]], 'the file is untouched');
  // The folder that now exists is recorded, so the next card tells the truth and the edit lands there.
  assert.equal(p.projectFolder, `${ROOT}/qa-687-project (2)`);
  const real = `${ROOT}/qa-687-project (2)/Text/qa-687-notes.md`;
  assert.equal(resolveEditTarget(p, JSON.stringify({ name: 'qa-687-notes.md' }), { storageAccount: 'acct' }).path, real);
  await w.asUser(() => w.tools.project_append_file.handler({ name: 'qa-687-notes.md', text: 'x' }, ctx(w, p, real)));
  assert.equal(w.storage.objects.get(real), `${NOTES}x`);
});

test('an existing affected project: a file already at the destination in storage is never overwritten', async (t) => {
  const w = world(t);
  const p = legacyProject(w);
  const target = `${ROOT}/qa-687-project/Text/qa-687-notes.md`;
  w.storage.put(target, 'someone else\'s file\n');
  await assert.rejects(w.tools.project_append_file.handler({ name: 'qa-687-notes.md', text: 'x' }, ctx(w, p, target)),
    /already exists in storage and noevia has not read it, so it was not overwritten\. Nothing was saved/);
  assert.equal(w.storage.objects.get(target), 'someone else\'s file\n');
  assert.deepEqual(w.storage.writeCalls, []);
  assert.deepEqual(p.files.map((f) => f.name), ['qa-687-notes.md']);
  // One appearing between the check and the PUT: the create-only PUT gets 412.
  const w2 = world(t);
  const q = legacyProject(w2);
  w2.storage.beforePut = (at) => w2.storage.put(at, 'raced in\n');
  await assert.rejects(w2.tools.project_append_file.handler({ name: 'qa-687-notes.md', text: 'x' }, ctx(w2, q, target)),
    /appeared in storage while this edit was being saved, so it was not overwritten\. Nothing was saved/);
  assert.equal(w2.storage.objects.get(target), 'raced in\n');
  assert.deepEqual(q.files.map((f) => f.name), ['qa-687-notes.md']);
});

test('an existing affected project: storage state changing between the card and the write is refused', async (t) => {
  const w = world(t);
  const p = legacyProject(w);
  const target = `${ROOT}/qa-687-project/Text/qa-687-notes.md`;
  // Card shown with storage connected, disconnected before the call runs: it now means the plain name.
  const approved = ctx(w, p, target);
  w.storage.connected = false;
  await assert.rejects(w.tools.project_append_file.handler({ name: 'qa-687-notes.md', text: 'x' }, approved),
    /now refers to "qa-687-notes\.md", which is not the file that was approved\. Nothing was changed/);
  // And the reverse: approved as the plain name, storage connected meanwhile.
  w.storage.connected = true;
  await assert.rejects(w.tools.project_append_file.handler({ name: 'qa-687-notes.md', text: 'x' }, ctx(w, p, 'qa-687-notes.md', null)),
    /not the file that was approved/);
  // The write path on its own refuses an adoption with storage disconnected.
  w.storage.connected = false;
  await assert.rejects(w.store.writeProjectTextFile(p, 'qa-687-notes.md', 'x', { expectName: 'qa-687-notes.md', expectContent: NOTES, expectAttachment: null, adoptTo: target, adoptAccount: storageAccount({ kind: 'webdav', url: 'http://storage.invalid/', username: 'synthetic-user-a' }) }),
    /which is not connected right now, so nothing was saved/);
  assert.deepEqual(w.storage.writeCalls, []);
  assert.deepEqual(p.files.map((f) => [f.name, f.content]), [['qa-687-notes.md', NOTES]]);
  assert.equal(p.projectFolder, undefined);
});

test('the refusal stays when the destination genuinely differs from the stored file', async (t) => {
  const w = world(t);
  // A connected upload moved away from the upload path: never rewritten at the upload path.
  const p = await w.store.createProject({ name: 'Trip', files: [{ name: 'notes.md', content: 'a\n' }] });
  const stored = `${ROOT}/Trip/Text/notes.md`;
  await assert.rejects(w.store.writeProjectTextFile(p, 'other.md', 'x', { expectName: stored, expectContent: 'a\n', expectAttachment: p.files[0].attachment.id }),
    /saving now would write "noevia projects\/Trip\/Text\/other\.md" instead of editing "noevia projects\/Trip\/Text\/notes\.md" in place; nothing was saved/);
  // A plain-named file with a separate stored file already at its destination: refused at the card.
  const q = legacyProject(w, 'Dup', 'notes.md');
  q.projectFolder = `${ROOT}/Dup`;
  q.files.push({ name: `${ROOT}/Dup/Text/notes.md`, content: 'stored\n', source: q.projectFolder, attachment: { id: 'e'.repeat(64), group: 'Text', state: 'ready', bytes: 7 } });
  const plain = resolveEditTarget(q, JSON.stringify({ name: 'notes.md' }), { storageAccount: 'acct' });
  assert.ok(plain.error, 'ambiguous or refused, never a silent second target');
  // No folder known at all: refused with a way forward, nothing written.
  const r = legacyProject(w, 'NoReservation');
  delete r.reservedFolder;
  assert.match(resolveEditTarget(r, JSON.stringify({ name: 'qa-687-notes.md' }), { storageAccount: 'acct' }).error, /has no storage folder yet/);
  assert.deepEqual(w.storage.writeCalls.map((c) => c.path), [stored], 'only the create-time store');
});

test('tenant scope: another account\'s affected project is not reachable', async (t) => {
  const w = world(t);
  const p = legacyProject(w);
  const target = `${ROOT}/qa-687-project/Text/qa-687-notes.md`;
  await assert.rejects(w.tools.project_append_file.handler({ name: 'qa-687-notes.md', text: 'x' }, { userId: 'user-b', projectId: 'proj-other', editTarget: targetDigest(target) }),
    /not in a project/);
  assert.deepEqual(w.storage.writeCalls, []);
  assert.equal(p.projectFolder, undefined);
});

test('an existing affected project: storage reconnected to another account after approval is refused', async (t) => {
  const w = world(t);
  const p = legacyProject(w);
  const target = `${ROOT}/qa-687-project/Text/qa-687-notes.md`;
  const approved = ctx(w, p, target);
  const first = w.storage.account();
  // Same server, another user; then another server. The path is the same, the account is not.
  for (const change of [() => { w.storage.user = 'synthetic-user-b'; }, () => { w.storage.user = 'synthetic-user-a'; w.storage.conn = () => ({ kind: 'webdav', url: 'http://other-storage.invalid/', username: 'synthetic-user-a' }); }]) {
    change();
    assert.notEqual(w.storage.account(), first);
    assert.equal(resolveEditTarget(p, JSON.stringify({ name: 'qa-687-notes.md' }), { storageAccount: w.storage.account() }).path, target, 'the path alone would still match');
    await assert.rejects(w.tools.project_append_file.handler({ name: 'qa-687-notes.md', text: 'x' }, approved), /not the file that was approved\. Nothing was changed/);
    // And at the write path itself, the lock-held check: approved for the first account, another connected now.
    await assert.rejects(w.store.writeProjectTextFile(p, 'qa-687-notes.md', 'x', { expectName: 'qa-687-notes.md', expectContent: NOTES, expectAttachment: null, adoptTo: target, adoptAccount: first }),
      /in a different storage account than the one connected now, so nothing was saved/);
    await assert.rejects(w.store.writeProjectTextFile(p, 'qa-687-notes.md', 'x', { expectName: 'qa-687-notes.md', expectContent: NOTES, expectAttachment: null, adoptTo: target }),
      /different storage account/, 'no account bound: refused too');
  }
  assert.deepEqual(w.storage.writeCalls, []);
  assert.equal(w.storage.folderCreations.length, 0, 'not even the folder was created');
  assert.deepEqual(p.files.map((f) => [f.name, f.content]), [['qa-687-notes.md', NOTES]]);
  // The chat loop binds the account too: the token's digest is path + account.
  const w2 = world(t);
  const q = legacyProject(w2);
  const r = await chat(t, w2, q, { rounds: [{ tool: 'project_append_file', args: { name: 'qa-687-notes.md', text: 'y' } }], onApproval: () => { w2.storage.user = 'synthetic-user-b'; } });
  assert.equal(r.pending[0].target, target);
  assert.match(r.results[0].text, /files changed after approval|not the file that was approved|different storage account/);
  assert.deepEqual(w2.storage.writeCalls, []);
});

test('create-time storing is create-only: a case-variant name on case-insensitive storage stays in noevia', async (t) => {
  const w = world(t);
  w.storage.caseInsensitive = true;
  const p = await w.store.createProject({ name: 'Case', files: [{ name: 'Notes.md', content: 'first\n' }, { name: 'notes.md', content: 'second\n' }] });
  const upper = `${ROOT}/Case/Text/Notes.md`;
  assert.equal(w.storage.objects.get(upper), 'first\n', 'the first file is not overwritten');
  assert.deepEqual(w.storage.writeCalls.map((c) => c.ifNoneMatch), ['*', '*'], 'every create-time PUT is create-only');
  assert.deepEqual(p.files.map((f) => f.name), [upper, 'notes.md'], 'the refused one stays in noevia');
  assert.equal(p.files[1].content, 'second\n');
  // A file already in the folder (an upload that landed first) is not replaced either.
  const w2 = world(t);
  w2.storage.put(`${ROOT}/Pre/Text/a.md`, 'already there\n');
  const q = await w2.store.createProject({ name: 'Pre', files: [{ name: 'a.md', content: 'dialog\n' }] });
  assert.equal(w2.storage.objects.get(`${ROOT}/Pre/Text/a.md`), 'already there\n');
  assert.deepEqual(q.files.map((f) => f.name), ['a.md']);
});

test('create-time storing makes no folder when no file will be stored (#589)', async (t) => {
  const w = world(t);
  const p = await w.store.createProject({ name: 'Nothing', files: [{ name: 'empty.md', content: '' }, { name: 'bad\u0001name.md', content: 'x' }, { name: 'image.png', content: 'x' }] });
  assert.equal(w.storage.folderCreations.length, 0, 'no folder created');
  assert.equal(p.projectFolder, undefined);
  assert.deepEqual(p.sourceFolders, []);
  assert.deepEqual(w.storage.writeCalls, []);
  assert.equal(p.files.length, 3, 'the files stay in noevia');
  // One storable file among them: the folder is made and only that file stored.
  const q = await w.store.createProject({ name: 'Some', files: [{ name: 'empty.md', content: '' }, { name: 'ok.md', content: 'ok\n' }] });
  assert.equal(q.projectFolder, `${ROOT}/Some`);
  assert.deepEqual(w.storage.writeCalls.map((c) => c.path), [`${ROOT}/Some/Text/ok.md`]);
  assert.deepEqual(q.files.map((f) => f.name), ['empty.md', `${ROOT}/Some/Text/ok.md`]);
});
