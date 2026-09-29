'use strict';
// #659: a project with uploads gets its Project documents tools; Google Drive writes name the
// Drive file on the approval card and never overwrite a file changed since this chat read it; and
// the tool descriptions steer project files to the project tools. Synthetic data, a fake Google.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { Readable, } = require('node:stream');
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const { applyProjectDocsDefault } = require('./project-docs-default.cjs');
const { createProjectRoutes } = require('./routes/projects.cjs');
const { createGoogleDrive } = require('./gdrive.cjs');
const { createDriveAccounts } = require('./drive-accounts.cjs');
const { createDriveTools } = require('./gdrive-tools.cjs');
const { driveFiles } = require('./gdrive-files.cjs');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { startFakeGoogle } = require('../qa/fake-google.cjs');
const { selectedToolboxIds } = require('./toolboxes-permitted.cjs');

const temps = [];
const temp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(d); return d; };
let google;
test.before(async () => { google = await startFakeGoogle({ autoApprove: true }); });
test.after(async () => { await google.close(); for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

// ── (a) Project documents by default for a project with uploads ─────────────────────────────
const OFFERED = { offered: (id) => ['core', 'project-docs', 'web-search'].includes(id), defaults: ['core'], hadUploads: false };

test('the default toolboxes of a project with an upload include the project edit tools; others keep least privilege', () => {
  const upload = { name: 'notes.md', content: 'Zahl: 1' };
  const fresh = { id: 'p', toolboxes: ['core'], files: [upload] };
  assert.equal(applyProjectDocsDefault(fresh, OFFERED), true);
  assert.deepEqual(fresh.toolboxes, ['core', 'project-docs']);
  // What the chat loop, the catalogue and the composer all read (#354) now carries the box.
  assert.deepEqual(selectedToolboxIds({ project: fresh, defaultToolboxes: ['core'], connectorBoxes: new Set(['gdrive']), connected: ['gdrive'] }), ['core', 'project-docs', 'gdrive']);

  const stored = { id: 'p', toolboxes: ['core'], projectFolder: 'noevia projects/P', files: [{ name: 'noevia projects/P/Text/n.md', source: 'noevia projects/P', attachment: { id: 'x' } }] };
  assert.equal(applyProjectDocsDefault(stored, OFFERED), true, 'an upload in the project folder counts');

  // No files, or only files read from a folder the user attached: nothing added.
  for (const project of [{ id: 'p', toolboxes: ['core'], files: [] }, { id: 'p', toolboxes: ['core'], projectFolder: 'noevia projects/P', files: [{ name: 'Docs/a.md', source: 'Docs' }] }]) {
    assert.equal(applyProjectDocsDefault(project, OFFERED), false);
    assert.deepEqual(project.toolboxes, ['core']);
    assert.equal(project.docsToolboxDefaulted, undefined);
  }
  // Unticked afterwards: the choice stands, the next upload does not add it back.
  fresh.toolboxes = ['core'];
  fresh.files.push({ name: 'more.md', content: 'x' });
  assert.equal(applyProjectDocsDefault(fresh, OFFERED), false);
  assert.deepEqual(fresh.toolboxes, ['core']);
  // "No tools" chosen on purpose, and a server without the internal MCP box: left alone.
  const none = { id: 'p', toolboxes: [], files: [upload] };
  assert.equal(applyProjectDocsDefault(none, OFFERED), false);
  assert.deepEqual(none.toolboxes, []);
  const noBox = { id: 'p', toolboxes: ['core'], files: [upload] };
  assert.equal(applyProjectDocsDefault(noBox, { ...OFFERED, offered: (id) => id === 'core' }), false);
  assert.equal(noBox.docsToolboxDefaulted, undefined, 'decided again once the box is offered');
  // A project predating toolboxes resolves to the defaults, plus the box.
  const legacy = { id: 'p', files: [upload] };
  applyProjectDocsDefault(legacy, OFFERED);
  assert.deepEqual(legacy.toolboxes, ['core', 'project-docs']);
  // #659 review: only when uploads FIRST appear. A project that already had uploads (maybe with the
  // box deliberately unticked) is never changed; nor are noevia's internal projects.
  const existing = { id: 'p', toolboxes: ['core'], files: [upload, { name: 'new.md', content: 'y' }] };
  assert.equal(applyProjectDocsDefault(existing, { ...OFFERED, hadUploads: true }), false);
  assert.equal(applyProjectDocsDefault(existing, { offered: OFFERED.offered, defaults: ['core'] }), false, 'hadUploads is required');
  assert.deepEqual(existing.toolboxes, ['core']);
  for (const id of ['cowork-chat-context-abc', 'cowork-diary-extras']) {
    const internal = { id, toolboxes: ['core'], files: [upload] };
    assert.equal(applyProjectDocsDefault(internal, OFFERED), false, id);
    assert.deepEqual(internal.toolboxes, ['core']);
  }
});

function routesFixture(projects) {
  const dir = temp('noevia-659-routes-');
  const sent = [];
  const store = {
    getProject: (id) => projects.find((p) => p.id === id) || null, saveProjects: () => { store.saves += 1; }, saves: 0,
    createProject: async () => null, pruneDocuments() {}, sweepDeletedProject() {}, purgeProjectChats() {},
    withSourceLock: (_p, op) => op(), ensureProjectFolder: async () => null, indexSource() {}, ownsFile: () => false,
    loadChats: () => [], saveChats() {}, deleteChat: () => false,
  };
  const routes = createProjectRoutes({
    json: (_res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: require('./http.cjs').readJson, requestScope: new AsyncLocalStorage(), dispatch: async () => {},
    currentWorkspace: () => ({ dir, userId: 'u1', ragDir: () => path.join(dir, 'rag'), assetDir: () => path.join(dir, 'assets') }),
    authService: { diaryEnabled: () => false, getStorage: () => ({ kind: 'local' }) },
    storageClient: { isBrowsable: () => false, TEXT_EXTENSIONS: new Set(['.md', '.txt']), safeRelativePath: (f) => f },
    documents: { isDocument: () => false }, documentSources: {}, rag: { deleteProjectFile() {} }, fs, path,
    reasoningEffort: { validEffort: () => true }, projectAppearance: () => ({}),
    diaryExtras: { PROJECT_ID: 'diary-extras', chatProjectId: () => null, newProject: () => ({ id: 'diary-extras' }) },
    PROJECTS: projects, DEFAULT_TOOLBOXES: ['core'], sanitizeToolboxes: (b) => (Array.isArray(b) ? b : null),
    allToolboxes: () => [{ id: 'core' }, { id: 'project-docs' }], getProvider: () => ({ id: 'default' }), ensureRolesLoaded() {},
    servedCatalogue: async () => [], DEFAULT_PROVIDER_ID: 'default', store,
  });
  const upload = (id, name, text) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ name, dataBase64: Buffer.from(text).toString('base64') }))]);
    Object.assign(req, { method: 'POST', url: `/api/projects/${id}/upload`, headers: {}, socket: {} });
    return routes(req, { writeHead() {}, end() {} }, { path: `/api/projects/${id}/upload`, authn: { user: { id: 'u1', role: 'member' } }, url: new URL(`http://localhost/api/projects/${id}/upload`) });
  };
  const sync = (id) => {
    const req = Readable.from([]);
    Object.assign(req, { method: 'POST', url: `/api/projects/${id}/sources/sync`, headers: {}, socket: {} });
    return routes(req, { writeHead() {}, end() {} }, { path: `/api/projects/${id}/sources/sync`, authn: { user: { id: 'u1', role: 'member' } }, url: new URL(`http://localhost/api/projects/${id}/sources/sync`) });
  };
  return { upload, sync, sent, store };
}

test('uploading the first file to a fresh project turns its Project documents box on, and saves it', async () => {
  const projects = [{ id: 'p1', name: 'Fresh', toolboxes: ['core'], files: [], chats: [] },
    { id: 'diary-extras', name: 'Diary extras', toolboxes: [], files: [], chats: [] }];
  const f = routesFixture(projects);
  await f.upload('p1', 'qa-notes.md', 'Zahl: 1');
  assert.equal(f.sent.at(-1).status, 200, JSON.stringify(f.sent.at(-1)));
  assert.deepEqual(projects[0].toolboxes, ['core', 'project-docs']);
  assert.equal(projects[0].docsToolboxDefaulted, true);
  assert.ok(f.store.saves >= 1, 'saved with the upload');
  // The Diary's extras project chooses its tools per session: never changed by an upload.
  projects[1].toolboxes = ['core'];
  await f.upload('diary-extras', 'extra.md', 'x');
  assert.deepEqual(projects[1].toolboxes, ['core']);
});

test('an existing project that already had uploads keeps its toolboxes after a sync or another upload (#659 review)', async () => {
  // Uploaded before this change, Project documents never ticked (or unticked on purpose).
  const projects = [{ id: 'p-old', name: 'Old', toolboxes: ['core'], files: [{ name: 'old.md', content: 'x' }], sourceFolders: [], chats: [] },
    { id: 'cowork-chat-context-c1', name: 'Chat attachments c1', toolboxes: ['core'], files: [], chats: [] }];
  const f = routesFixture(projects);
  await f.sync('p-old');
  assert.equal(f.sent.at(-1).status, 200, JSON.stringify(f.sent.at(-1)));
  assert.deepEqual(projects[0].toolboxes, ['core'], 'the automatic sync after deploy changes nothing');
  await f.upload('p-old', 'more.md', 'y');
  assert.equal(f.sent.at(-1).status, 200);
  assert.deepEqual(projects[0].toolboxes, ['core'], 'nor does a later upload');
  assert.equal(projects[0].docsToolboxDefaulted, undefined);
  // A free chat's hidden attachments project: its edit tools stay opt-in.
  await f.upload('cowork-chat-context-c1', 'attached.md', 'z');
  assert.equal(f.sent.at(-1).status, 200);
  assert.deepEqual(projects[1].toolboxes, ['core']);
});

// ── (b)-(d) Google Drive writes ───────────────────────────────────────────────────────────
const key = crypto.randomBytes(32);
const member = { id: 'u-member', role: 'member' };
async function connectedDrive() {
  const dir = temp('noevia-659-drive-');
  const makeDrive = ({ tokenFile, backupKey }) => createGoogleDrive({ clientId: 'fake-client', clientSecret: 'fake-secret', tokenFile, backupKey,
    oauthBase: google.base, apiBase: `${google.base}/drive`, uploadBase: `${google.base}/upload` });
  const backupDrive = makeDrive({ tokenFile: path.join(dir, 'google-drive.sealed'), backupKey: () => key });
  const accounts = createDriveAccounts({ backupDrive, dataDir: dir, userKey: () => key, makeDrive });
  const { drive } = accounts.forUser(member);
  await drive.connect(() => {}, { owner: member.id });
  for (let i = 0; i < 100 && drive.state().state !== 'connected'; i++) await new Promise((r) => setTimeout(r, 50));
  return { accounts, drive, tools: createDriveTools({ accounts, cap: 8000 }) };
}
const idOf = (text) => /id ([\w-]+)/.exec(text)[1];

test('drive_update_file is conditional: it runs on the version this chat read, and refuses a file changed since', async () => {
  const { tools, drive } = await connectedDrive();
  const id = idOf(await tools.execute(member, 'drive_create_file', { name: 'plan.md', content: 'v1', mimeType: 'text/markdown' }, { chatKey: 'other-chat' }));
  const updatesBefore = () => google.state.updates || 0;

  // Never read in this chat: refused, nothing written.
  let before = updatesBefore();
  assert.match(await tools.execute(member, 'drive_update_file', { fileId: id, content: 'blind' }, { chatKey: 'chat-1' }), /^ERROR: .*read in full with drive_read_file in this same reply.*Nothing was changed/);
  assert.equal(updatesBefore(), before);

  // Read here, then updated: runs, once.
  assert.match(await tools.execute(member, 'drive_read_file', { fileId: id }, { chatKey: 'chat-1' }), /v1/);
  assert.match(await tools.execute(member, 'drive_update_file', { fileId: id, content: 'v2' }, { chatKey: 'chat-1' }), /^Updated plan\.md/);
  assert.equal(google.files.get(id).body.toString(), 'v2');
  // What this chat wrote is what it knows: a follow-up edit here is allowed.
  assert.match(await tools.execute(member, 'drive_update_file', { fileId: id, content: 'v3' }, { chatKey: 'chat-1' }), /^Updated/);

  // Changed elsewhere (another app edits it in Drive) after this chat's read: refused, the other edit survives.
  assert.match(await tools.execute(member, 'drive_read_file', { fileId: id }, { chatKey: 'chat-2' }), /v3/);
  const f = google.files.get(id); f.body = Buffer.from('edited in Drive'); f.version += 1;
  before = updatesBefore();
  const refused = await tools.execute(member, 'drive_update_file', { fileId: id, content: 'overwrite' }, { chatKey: 'chat-2' });
  assert.match(refused, /^ERROR: plan\.md changed in Google Drive after it was read in this chat, so it was not overwritten\. Nothing was changed\./);
  assert.equal(updatesBefore(), before, 'no PATCH was sent');
  assert.equal(google.files.get(id).body.toString(), 'edited in Drive');

  // A read that was cut short cannot be the base of a whole-file replace.
  const long = idOf(await tools.execute(member, 'drive_create_file', { name: 'long.txt', content: 'a'.repeat(9000) }, { chatKey: 'x' }));
  await tools.execute(member, 'drive_read_file', { fileId: long }, { chatKey: 'chat-3' });
  assert.match(await tools.execute(member, 'drive_update_file', { fileId: long, content: 'short' }, { chatKey: 'chat-3' }), /^ERROR: only part of this file was read/);

  // The version check itself, at the file layer.
  const files = driveFiles(drive);
  const meta = await files.metadata({ fileId: id });
  await assert.rejects(files.update({ fileId: id, content: 'x' }, { expectVersion: String(Number(meta.version) - 1) }), (e) => e.status === 409 && e.code === 'changed');
  const ok = await files.update({ fileId: id, content: 'y' }, { expectVersion: meta.version });
  assert.equal(String(ok.version), String(Number(meta.version) + 1));
});

test('the Drive approval card carries the resolved target through the chat gate; a project path is refused before the card', async (t) => {
  const { tools } = await connectedDrive();
  const id = idOf(await tools.execute(member, 'drive_create_file', { name: 'budget.md', content: 'x' }, { chatKey: 'c' }));
  assert.deepEqual(await tools.describeTarget(member, 'drive_update_file', JSON.stringify({ fileId: id, content: 'y' })), { target: `budget.md (id ${id})`, kind: 'drive' });
  assert.deepEqual(await tools.describeTarget(member, 'drive_create_file', JSON.stringify({ name: 'new.md', content: 'y' })), { target: 'new.md', kind: 'drive-new' });
  assert.equal(await tools.describeTarget(member, 'drive_read_file', JSON.stringify({ fileId: id })), null, 'a read has no card');
  const projectPath = await tools.describeTarget(member, 'drive_update_file', JSON.stringify({ fileId: 'noevia projects/qa/Text/qa-notes.md', content: 'x' }));
  assert.match(projectPath.error, /is not a Google Drive file id.*use the project file tools \(project_append_file or project_replace_text\)/);
  assert.match((await tools.describeTarget(member, 'drive_trash_file', JSON.stringify({ fileId: 'nope' }))).error, /no such file/);

  // Through the real chat loop: the card event names the file; the refusal never shows a card.
  const dir = temp('noevia-659-chat-');
  const turns = [];
  const fetch = async () => ({ ok: true, body: (async function* () { for (const c of (turns.shift() || [])) yield Buffer.from(`data: ${JSON.stringify(c)}\n\n`); })() });
  const call = (name, args) => [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name, arguments: JSON.stringify(args) } }] } }] }];
  const executed = [];
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'm', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto, path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: member.id, dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'p', model: 'm', assets: [] }), skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid' }),
    providerHeaders: () => ({}), autoRoles: () => null, visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => ['gdrive'],
    toolPolicy: { mode: (_u, _n, write) => (write ? 'ask' : 'allow') },
    requestScope: { getStore: () => ({ workspace: { userId: member.id }, authn: { user: member } }) },
    resolveTools: () => ({ tools: tools.box.tools, dropped: [] }), isWriteTool: (n) => !tools.reads.has(n),
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (x) => ({ text: String(x) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], executeToolCall: async (_p, name, args, _a, _s, outcome, options) => { executed.push({ name, options }); return tools.execute(member, name, JSON.parse(args), options); },
    chatWideApproved: () => false, awaitApproval: async () => 'deny', recordUsage() {}, recordToolUse() {},
    writeTargetFor: (name, raw, { user }) => (tools.names.has(name) ? tools.describeTarget(user, name, raw) : null),
  });
  const run = async (body) => {
    const events = [], res = new EventEmitter();
    res.writeHead = () => {}; res.write = (l) => { if (l.startsWith('data: ')) events.push(JSON.parse(l.slice(6))); }; res.end = () => { res.writableEnded = true; res.emit('finish'); };
    await handleChat({}, res, { projectId: 'p', chatId: 'chat-x', ...body });
    return events;
  };
  // The card is declined, which ends the reply (#666): no second model turn is scripted.
  turns.push(call('drive_update_file', { fileId: id, content: 'new text' }));
  const events = await run({ message: 'Update budget.md in my Drive' });
  const card = events.find((e) => e.type === 'tool_pending');
  assert.equal(card.target, `budget.md (id ${id})`);
  assert.equal(card.targetKind, 'drive');
  assert.equal(card.args, JSON.stringify({ fileId: id, content: 'new text' }), 'the raw arguments are still shown in full');

  turns.push(call('drive_update_file', { fileId: 'noevia projects/qa/Text/qa-notes.md', content: 'x' }), []);
  const refused = await run({ message: 'append to qa-notes.md' });
  assert.equal(refused.some((e) => e.type === 'tool_pending'), false, 'no card for a file that is not in Drive');
  // (The chip shows the first 300 characters.)
  assert.match(refused.find((e) => e.type === 'tool_result').text, /^ERROR: .*is not a Google Drive file id.*use the project file tools.*drive_update_file was not run/);
  assert.equal(executed.length, 0, 'nothing reached Drive');
});

test('descriptions: Drive tools say Google Drive by Drive id and not project files; project edit tools claim uploads', () => {
  const { box } = createDriveTools({ accounts: { forUser: () => ({ drive: { state: () => ({ state: 'disconnected' }) } }) } });
  const d = Object.fromEntries(box.tools.map((x) => [x.function.name, x.function.description]));
  for (const name of ['drive_read_file', 'drive_create_file', 'drive_update_file']) {
    assert.match(d[name], /Google Drive/, name);
    assert.match(d[name], /Not for files uploaded to this project; use the project file tools/, name);
  }
  assert.match(d.drive_update_file, /by Drive file id/);
  assert.match(d.drive_update_file, /Read it with drive_read_file first, in the same reply/);
  const { createInternalTools } = require('./mcp-internal-tools.cjs');
  const internal = createInternalTools({});
  for (const name of ['project_append_file', 'project_replace_text']) {
    assert.match(internal[name].description, /upload/, name);
    assert.match(internal[name].description, /not (Google Drive|a Google Drive)/i, name);
  }
});

// ── #659 review: "read in full" means what the model received, in this exchange ─────────────
test('a read counts as full only when the exact string the model gets held the whole file (header included)', async () => {
  const { tools } = await connectedDrive();
  const cap = 8000;
  // The boundary the review found: the text alone fits the cap, the header pushes the result over.
  const tight = idOf(await tools.execute(member, 'drive_create_file', { name: 'b.md', content: 'a'.repeat(cap - 'b.md'.length) }, { exchangeKey: 'x0' }));
  const read = await tools.execute(member, 'drive_read_file', { fileId: tight }, { exchangeKey: 'x1' });
  assert.ok(read.length <= cap, `the result fits the chat's cap, so the chat loop never cuts it again (${read.length})`);
  assert.match(read, /\n\[truncated\]$/);
  const before = google.state.updates || 0;
  assert.match(await tools.execute(member, 'drive_update_file', { fileId: tight, content: 'short' }, { exchangeKey: 'x1' }), /^ERROR: only part of this file was read/);
  assert.equal(google.state.updates || 0, before, 'no PATCH');
  assert.equal(google.files.get(tight).body.length, cap - 'b.md'.length, 'the file keeps its tail');
  // Exactly fitting, header included: complete, and the update runs.
  const exact = idOf(await tools.execute(member, 'drive_create_file', { name: 'c.md', content: 'a'.repeat(cap - 'c.md:\n'.length) }, { exchangeKey: 'x0' }));
  const whole = await tools.execute(member, 'drive_read_file', { fileId: exact }, { exchangeKey: 'x2' });
  assert.equal(whole.length, cap);
  assert.doesNotMatch(whole, /\[truncated\]/);
  assert.match(await tools.execute(member, 'drive_update_file', { fileId: exact, content: 'short' }, { exchangeKey: 'x2' }), /^Updated c\.md/);
});

test('a read (or the reply\'s own update) counts only in the exchange that made it', async () => {
  const { tools } = await connectedDrive();
  const id = idOf(await tools.execute(member, 'drive_create_file', { name: 'plan.md', content: 'v1' }, { chatKey: 'chat', exchangeKey: 'A0' }));
  await tools.execute(member, 'drive_read_file', { fileId: id }, { chatKey: 'chat', exchangeKey: 'A' });
  const before = google.state.updates || 0;
  assert.match(await tools.execute(member, 'drive_update_file', { fileId: id, content: 'from memory' }, { chatKey: 'chat', exchangeKey: 'B' }),
    /^ERROR: .*in this same reply \(a read from an earlier message does not count\).*Nothing was changed/);
  assert.equal(google.state.updates || 0, before);
  assert.match(await tools.execute(member, 'drive_update_file', { fileId: id, content: 'v2' }, { chatKey: 'chat', exchangeKey: 'A' }), /^Updated/);
  // The record left by A's own update does not carry into a later request either.
  assert.match(await tools.execute(member, 'drive_update_file', { fileId: id, content: 'v3' }, { chatKey: 'chat', exchangeKey: 'C' }), /^ERROR: /);
  assert.equal(google.files.get(id).body.toString(), 'v2');
});

test('through the chat loop: read in one request, update in the next is refused; read and update in one request runs', async () => {
  const { tools } = await connectedDrive();
  const id = idOf(await tools.execute(member, 'drive_create_file', { name: 'notes.md', content: 'v1' }, { exchangeKey: 'setup' }));
  const dir = temp('noevia-659-exchange-');
  const turns = [];
  const fetch = async () => ({ ok: true, body: (async function* () { for (const c of (turns.shift() || [])) yield Buffer.from(`data: ${JSON.stringify(c)}\n\n`); })() });
  const call = (name, args, cid = 'call-1') => [{ choices: [{ delta: { tool_calls: [{ index: 0, id: cid, function: { name, arguments: JSON.stringify(args) } }] } }] }];
  const say = (text) => [{ choices: [{ delta: { content: text } }] }];
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'm', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto, path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: member.id, dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'p', model: 'm', assets: [] }), skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid' }),
    providerHeaders: () => ({}), autoRoles: () => null, visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => ['gdrive'],
    toolPolicy: { mode: (_u, _n, write) => (write ? 'ask' : 'allow') },
    requestScope: { getStore: () => ({ workspace: { userId: member.id }, authn: { user: member } }) },
    resolveTools: () => ({ tools: tools.box.tools, dropped: [] }), isWriteTool: (n) => !tools.reads.has(n),
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (x) => ({ text: String(x) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], executeToolCall: async (_p, name, args, _a, _s, _o, options) => tools.execute(member, name, JSON.parse(args), options),
    chatWideApproved: () => false, awaitApproval: async () => 'approve', recordUsage() {}, recordToolUse() {},
    writeTargetFor: (name, raw, { user }) => (tools.names.has(name) ? tools.describeTarget(user, name, raw) : null),
  });
  const run = async (message) => {
    const events = [], res = new EventEmitter();
    res.writeHead = () => {}; res.write = (l) => { if (l.startsWith('data: ')) events.push(JSON.parse(l.slice(6))); }; res.end = () => { res.writableEnded = true; res.emit('finish'); };
    await handleChat({}, res, { projectId: 'p', chatId: 'chat-x', message });
    return events.filter((e) => e.type === 'tool_result');
  };
  turns.push(call('drive_read_file', { fileId: id }), say('It says v1.'));
  assert.match((await run('What does notes.md say?'))[0].text, /v1/);
  turns.push(call('drive_update_file', { fileId: id, content: 'v1 plus more' }), say('ok'));
  const later = await run('Now add "plus more" to it.');
  assert.match(later[0].text, /^ERROR: drive_update_file replaces the whole file/, 'a later request cannot rely on the earlier read');
  assert.equal(later[0].applied, undefined);
  assert.equal(google.files.get(id).body.toString(), 'v1');
  turns.push(call('drive_read_file', { fileId: id }), call('drive_update_file', { fileId: id, content: 'v1 plus more' }, 'call-2'), say('done'));
  const same = await run('Read it again and add "plus more".');
  assert.match(same[1].text, /^Updated notes\.md/);
  assert.equal(same[1].applied, true);
  assert.equal(google.files.get(id).body.toString(), 'v1 plus more');
});
