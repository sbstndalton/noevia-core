'use strict';
// The project routes against a fake store: what is left alone, what is refused and with which
// words, and that the front's source worker call re-enters the router with the same headers. The
// store is projects.test.cjs; uploads end to end are document-routes.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createProjectRoutes } = require('./projects.cjs');
const { createProviderRegistry } = require('../providers.cjs');

function fixture({ projects = [], diary = true, catalogue = null, onToolboxesChange } = {}) {
  const sent = [];
  const dispatched = [];
  const requestScope = new AsyncLocalStorage();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-project-routes-'));
  const workspace = { dir, userId: 'u1', ragDir: () => path.join(dir, 'rag'), assetDir: () => path.join(dir, 'assets') };
  const providers = [{ id: 'default' }, { id: 'prov-cloud' }];
  // Use production fallback semantics: an unknown ID resolves to default.
  const { getProvider } = createProviderRegistry({ currentWorkspace: () => ({}), PROVIDERS: providers, DEFAULT_PROVIDER_ID: 'default' });
  const store = {
    getProject: (id) => projects.find((p) => p.id === id) || null,
    saveProjects: () => { store.saves += 1; }, saves: 0,
    createProject: async (body) => { if (!body.name) throw Object.assign(Error('name required'), { status: 400 }); const p = { id: 'proj-new', ...body }; projects.unshift(p); return p; },
    pruneDocuments() {},
    // The whole delete cleanup is the store's (projects.cjs deleteProject, shared with #788).
    deleteProject: (id) => { const i = projects.findIndex((p) => p.id === id); if (i < 0) return false; projects.splice(i, 1); store.deleted = id; return true; },
    withSourceLock: (_p, op) => op(), ensureProjectFolder: async () => null, indexSource() {},
    ownsFile: () => false, loadChats: (id) => (store.getProject(id) || { chats: [] }).chats || [], saveChats: (id, chats) => { store.savedChats = [id, chats]; },
  };
  const routes = createProjectRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: require('../http.cjs').readJson,
    requestScope,
    dispatch: async (req, res) => { dispatched.push({ url: req.url, method: req.method, headers: req.headers, progress: requestScope.getStore()?.sourceProgress }); res.writeHead(200); res.end('{"ok":true}'); },
    currentWorkspace: () => workspace,
    authService: { diaryEnabled: () => diary, getStorage: () => ({ kind: 'local' }) },
    storageClient: { isBrowsable: () => false, TEXT_EXTENSIONS: new Set(['.txt']), safeRelativePath: (f) => f },
    documents: { isDocument: (name) => /\.pdf$/i.test(name) },
    documentSources: {}, rag: { deleteProjectFile() {} },
    fs, path,
    reasoningEffort: { validEffort: (e) => ['default', 'low', 'high'].includes(e) },
    projectAppearance: () => ({}),
    diaryExtras: { PROJECT_ID: 'diary-extras', chatProjectId: (id) => (id === 'bad' ? null : `chat-${id}`), newProject: () => ({ id: 'diary-extras', name: 'Diary' }) },
    PROJECTS: projects, DEFAULT_TOOLBOXES: ['core'], sanitizeToolboxes: (b) => (Array.isArray(b) ? b : null),
    getProvider, ensureRolesLoaded() {},
    servedCatalogue: async () => catalogue, DEFAULT_PROVIDER_ID: 'default',
    store, onToolboxesChange,
  });
  const streamed = [];
  const call = (method, path, body, search = '', role = 'member', extra = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    Object.assign(req, { method, url: path + search, headers: { cookie: 'session=x', ...extra }, socket: {} });
    const res = { writeHead(status, headers) { streamed.push({ status, headers }); }, write(text) { streamed.push(JSON.parse(text)); }, end() { streamed.push('end'); } };
    return routes(req, res, { path, authn: { user: { id: 'u1', role } }, url: new URL(`http://localhost${path}${search}`) });
  };
  return { call, sent, dispatched, streamed, store, projects, providers, dir };
}

test('paths and methods outside the project surface fall through', async () => {
  const f = fixture({ projects: [{ id: 'p1', chats: [], assets: [{ id: 'a' }] }] });
  assert.equal(await f.call('GET', '/api/workspace'), false);
  assert.equal(await f.call('GET', '/api/projects'), false, 'the list is served by /api/workspace');
  assert.equal(await f.call('PUT', '/api/projects/p1/chats'), false, 'an unhandled method keeps falling through');
  assert.equal(await f.call('PATCH', '/api/projects/p1/assets/a'), false);
  assert.equal(f.sent.length, 0);
});

test('portable skill routes preserve the legacy body list and require an exact enabled version', async () => {
  const skills = require('../instruction-skills.cjs');
  const content = '---\nname: Review\ndescription: Synthetic notes\nversion: 1\n---\nDraft from synthetic notes.';
  const project = { id: 'p1', files: [{ name: 'review.md', content }], toolboxes: ['core'] };
  skills.reconcile(project);
  const f = fixture({ projects: [project] });
  const base = '/api/projects/p1/instruction-skills';
  await f.call('GET', base);
  const row = f.sent.pop().body.skills[0];
  assert.equal(row.content, content, 'existing UI list retains its body');
  await f.call('GET', `${base}/manifests`);
  const item = f.sent.pop().body.skills[0];
  // #272: the Sources list also shows where the skill came from, under its portable id.
  assert.equal(row.id, item.id);
  assert.deepEqual(row.origin, { kind: 'project-file' });
  assert.deepEqual(row.scripts, []);
  assert.equal(JSON.stringify(item).includes('Draft from synthetic notes.'), false);
  await f.call('GET', `${base}/manifests/${item.id}/content`, undefined, `?version=${item.version}`);
  assert.equal(f.sent.pop().status, 409);
  await f.call('PUT', base, { file: 'review.md', enabled: true, hash: item.version });
  assert.equal(f.sent.pop().status, 200);
  await f.call('GET', `${base}/manifests/${item.id}/content`, undefined, `?version=${item.version}`);
  assert.equal(f.sent.pop().body.content, content);
  await f.call('GET', `${base}/manifests/${item.id}/content`, undefined, '?version=' + '0'.repeat(64));
  assert.equal(f.sent.pop().status, 409);
  await f.call('PUT', base, { file: 'review.md', enabled: false });f.sent.pop();
  await f.call('GET', `${base}/manifests/${item.id}/content`, undefined, `?version=${item.version}`);
  assert.equal(f.sent.pop().status, 409);
  await f.call('GET', '/api/projects/missing/instruction-skills/manifests');
  assert.equal(f.sent.pop().status, 404);
});

test('an unchanged source patch retains published provenance; a local edit clears it', async () => {
  const content = '---\nname: Review\ndescription: Synthetic notes\n---\nDraft.';
  const digest = require('../instruction-skills.cjs').hash(content);
  const origin = { kind: 'published', publisher: 'Anthropic', digest, sourceRef: 'main' };
  const project = { id: 'p1', files: [{ name: 'review.md', content, skillOrigin: origin }], toolboxes: ['core'] };
  const f = fixture({ projects: [project] });
  await f.call('POST', '/api/projects/p1/config', { files: [{ name: 'review.md', content }] });
  assert.equal(f.sent.pop().status, 200);
  assert.deepEqual(project.files[0].skillOrigin, origin);
  await f.call('POST', '/api/projects/p1/config', { files: [{ name: 'review.md', content: content + '\nLocal edit.' }] });
  assert.equal(f.sent.pop().status, 200);
  assert.equal(project.files[0].skillOrigin, undefined);
});

// #2191 round 2: a project's create and delete are the Rust front's (rust-project-lifecycle.cjs refuses
// them before this mount; noevia-rs tests/project_lifecycle.rs keeps their status codes and messages).
test('the project create and delete are no longer handled here', async () => {
  const f = fixture({ projects: [{ id: 'p1', files: [] }] });
  assert.equal(await f.call('POST', '/api/projects', { name: 'New' }), false);
  assert.equal(await f.call('DELETE', '/api/projects/p1'), false);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.projects.map((p) => p.id), ['p1']);
});

test('the config patch validates each field with the same words as before', async () => {
  const f = fixture({ projects: [{ id: 'p1', files: [] }] });
  await f.call('POST', '/api/projects/p1/config', { routing: 'sometimes' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: "routing must be 'auto' or 'manual'" } });
  await f.call('POST', '/api/projects/p1/config', { provider: 'ghost' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'no such provider' } });
  assert.equal(f.projects[0].provider, undefined);
  assert.equal(f.store.saves, 0);
  await f.call('POST', '/api/projects/p1/config', { provider: 'prov-cloud' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(f.projects[0].provider, 'prov-cloud');
  await f.call('POST', '/api/projects/p1/config', { provider: 'lemonade' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(f.projects[0].provider, 'lemonade');
  await f.call('POST', '/api/projects/p1/config', { toolboxes: 'core' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'toolboxes must be an array of toolbox ids' } });
  await f.call('POST', '/api/projects/p1/config', { reasoningEffort: 'max' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Invalid reasoning effort' } });
  await f.call('POST', '/api/projects/nope/config', {});
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'no such project' } });
  await f.call('POST', '/api/projects/p1/config', { name: ' Renamed ', pinned: true, memories: ['  keep ', 7] });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(f.projects[0].name, 'Renamed');
  assert.equal(f.projects[0].pinned, true);
  assert.deepEqual(f.projects[0].memories, ['keep']);
  assert.equal(f.store.saves, 3);
});

test('the sampling patch is sanitized, and null clears an explicit override (issue #194)', async () => {
  const f = fixture({ projects: [{ id: 'p1', files: [] }] });
  await f.call('POST', '/api/projects/p1/config', { sampling: { temperature: 0.4, top_p: 5, mirostat: 2 } });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.deepEqual(f.projects[0].sampling, { temperature: 0.4 }); // out-of-range top_p and unknown key dropped
  await f.call('POST', '/api/projects/p1/config', { sampling: {} });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(f.projects[0].sampling, undefined); // nothing valid survived sanitization
  assert.equal(Object.hasOwn(f.projects[0], 'sampling'), false);
  await f.call('POST', '/api/projects/p1/config', { sampling: { temperature: 0.6 } });
  assert.deepEqual(f.projects[0].sampling, { temperature: 0.6 });
  await f.call('POST', '/api/projects/p1/config', { sampling: null });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(f.projects[0].sampling, undefined);
  assert.equal(Object.hasOwn(f.projects[0], 'sampling'), false);
});

test('rejected config patches do not clear the active sampling override', async () => {
  for (const sampling of [null, {}]) {
    const project = { id: 'p1', files: [], sampling: { temperature: 0.6 } };
    const f = fixture({ projects: [project] });
    await f.call('POST', '/api/projects/p1/config', { sampling, toolboxes: 'invalid' });
    assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'toolboxes must be an array of toolbox ids' } });
    assert.deepEqual(project, { id: 'p1', files: [], sampling: { temperature: 0.6 } });
    assert.equal(f.store.saves, 0);
  }
});

// A project's chat list (GET and POST /api/projects/{id}/chats) is the Rust front's (#1071): this
// mount no longer has it, and index.cjs refuses it first (rust-projects.test.cjs). Deleting one chat
// stays here.
test('chat metas: the list and one chat\'s delete are not this mount\'s any more (#1071 slice 6)', async () => {
  const f = fixture({ projects: [{ id: 'p1', chats: [{ id: 'c1', title: 'one' }] }] });
  for (const m of ['GET', 'POST']) assert.equal(await f.call(m, '/api/projects/p1/chats', m === 'POST' ? { chats: [{ id: 'c2' }] } : undefined), false, m);
  assert.equal(await f.call('DELETE', '/api/projects/p1/chats/c1'), false, 'the Rust front answers the delete');
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.savedChats, undefined, 'nothing saved');
});


test('Diary context remains Node-owned and respects the add-on permission', async () => {
  const off = fixture({ diary: false });
  await off.call('POST', '/api/diary/context');
  assert.deepEqual(off.sent.pop(), { status: 404, body: { error: 'Diary add-on is disabled' } });
  const on = fixture();
  await on.call('GET', '/api/diary/context');
  assert.deepEqual(on.sent.pop(), { status: 200, body: { project: null } });
  await on.call('POST', '/api/diary/context');
  assert.equal(on.sent.pop().body.project.id, 'diary-extras');
  assert.equal(on.store.saves, 1);
});

// Context behavior (#352/#788/#1522/#1902) is exercised through the real Rust
// HTTP routes in noevia-rs project_routes and its pinned Node differential corpus.
// This router must have no fallback implementation to read or write the store.
test('#1264/#1071: chat context has no Node handler, including malformed and tombstoned ids', async () => {
  const f = fixture({ projects: [{ id: 'chat-kept', chats: [] }] });
  require('../chat-lists.cjs').addTombstone(f.dir, 'gone');
  for (const id of ['abc', 'bad%E0%A4%A', 'gone', 'kept']) {
    for (const method of ['GET', 'POST']) {
      assert.equal(await f.call(method, `/api/chats/${id}/context`), false);
    }
  }
  assert.deepEqual(f.sent, []);
  assert.equal(f.store.saves, 0);
  assert.deepEqual(f.projects, [{ id: 'chat-kept', chats: [] }]);
});

test('an explicit routing choice is marked so the #352 migration never reverts it', async () => {
  const f = fixture({ projects: [{ id: 'p1', routing: 'auto' }] });
  await f.call('POST', '/api/projects/p1/config', { routing: 'manual' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(f.projects[0].routing, 'manual');
  assert.equal(f.projects[0].routingChosen, true);
});

test('picking a model without sending routing still pins it to manual (#384)', async () => {
  // The picker itself now sends {model, routing:'manual'} atomically, but older or other
  // callers that patch `model` alone must have the same effect — otherwise the next send
  // reads `routing` (still 'auto') and silently routes the message away from the pick.
  const f = fixture({ projects: [{ id: 'p1', routing: 'auto' }] });
  await f.call('POST', '/api/projects/p1/config', { model: 'qwen3.5-9b' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(f.projects[0].model, 'qwen3.5-9b');
  assert.equal(f.projects[0].routing, 'manual');
  assert.equal(f.projects[0].routingChosen, true);
});

test('a routing-only patch keeps its existing model, unaffected by the #384 model-implies-manual rule', async () => {
  const f = fixture({ projects: [{ id: 'p1', routing: 'manual', model: 'llama-8b' }] });
  await f.call('POST', '/api/projects/p1/config', { routing: 'auto' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(f.projects[0].routing, 'auto');
  assert.equal(f.projects[0].routingChosen, true);
  assert.equal(f.projects[0].model, 'llama-8b', 'routing alone must not touch the stored model');
});

test('an explicit routing in the same patch always wins over the model-implies-manual default', async () => {
  // A patch that names both fields is a deliberate combination — e.g. keeping Auto while still
  // recording which model was picked for it — and the caller's explicit `routing` value must be
  // the one that lands, not the implicit manual default from #384.
  const f = fixture({ projects: [{ id: 'p1', routing: 'manual' }] });
  await f.call('POST', '/api/projects/p1/config', { model: 'qwen3.5-9b', routing: 'auto' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(f.projects[0].model, 'qwen3.5-9b');
  assert.equal(f.projects[0].routing, 'auto');
  assert.equal(f.projects[0].routingChosen, true);
});


// #409: the composer's Manual model pick had no server-side guard at all — unlike PUT
// /api/auto-roles (#343) and benchmark/start, which both already reject an embedding, reranking
// or Laya (routing) model through the same chat-model-kind.cjs helper this now shares.
test('a project config patch rejects Laya (the internal routing model) as a manual chat model, for both a member and an admin', async () => {
  for (const role of ['member', 'admin']) {
    const f = fixture({ projects: [{ id: 'p1', files: [] }], catalogue: [{ name: 'laya_multilingual_f16', labels: ['routing'] }, { name: 'chat-model', labels: [] }] });
    await f.call('POST', '/api/projects/p1/config', { model: 'laya_multilingual_f16' }, '', role);
    assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'laya_multilingual_f16 is an embedding, reranking or routing model and cannot be used as a chat model — pick a chat model instead.' } });
    assert.equal(f.projects[0].model, undefined, `${role}: the rejected model must not be saved`);
  }
});

test('a project config patch rejects an embedding model as a manual chat model, for both a member and an admin', async () => {
  for (const role of ['member', 'admin']) {
    const f = fixture({ projects: [{ id: 'p1', files: [] }], catalogue: [{ name: 'nomic-embed-text-v1', labels: ['embeddings'] }] });
    await f.call('POST', '/api/projects/p1/config', { model: 'nomic-embed-text-v1' }, '', role);
    assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'nomic-embed-text-v1 is an embedding, reranking or routing model and cannot be used as a chat model — pick a chat model instead.' } });
    assert.equal(f.projects[0].model, undefined);
  }
});

test('a project config patch still accepts an ordinary chat model, and Laya is rejected by name even when the catalogue is unreadable', async () => {
  const ok = fixture({ projects: [{ id: 'p1', files: [] }], catalogue: [{ name: 'chat-model', labels: [] }] });
  await ok.call('POST', '/api/projects/p1/config', { model: 'chat-model' });
  assert.deepEqual(ok.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(ok.projects[0].model, 'chat-model');

  // servedCatalogue() returns null when the model manager is disabled or unreachable — Laya is
  // still refused by name alone (chat-model-kind.cjs falls back to the name when an alias is not
  // found in the catalogue), matching nonChatAliases' own unreadable-catalogue behaviour.
  const unreadable = fixture({ projects: [{ id: 'p1', files: [] }], catalogue: null });
  await unreadable.call('POST', '/api/projects/p1/config', { model: 'laya_multilingual_f16' });
  assert.equal(unreadable.sent.pop().status, 400);
  assert.equal(unreadable.projects[0].model, undefined);
});

test('a model on a non-default (cloud) provider is never checked against the local catalogue', async () => {
  // Mirrors modelChoiceLabel's own comment (src/model-guidance.ts): a model on another provider
  // is not in the local catalogue this check reads, so it must never be flagged here — the cloud
  // provider's own model list is the only authority for what it serves.
  const f = fixture({ projects: [{ id: 'p1', files: [], provider: 'openrouter' }], catalogue: [{ name: 'laya_multilingual_f16', labels: ['routing'] }] });
  await f.call('POST', '/api/projects/p1/config', { model: 'laya_multilingual_f16' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(f.projects[0].model, 'laya_multilingual_f16');
});



test('#796: saving a project\'s toolbox selection clears the cached permitted-tools view', async () => {
  let cleared = 0;
  const f = fixture({ projects: [{ id: 'p1', files: [], toolboxes: ['core'] }], onToolboxesChange: () => { cleared += 1; } });
  await f.call('POST', '/api/projects/p1/config', { name: 'Renamed' });
  assert.equal(cleared, 0, 'a patch that leaves the toolboxes alone keeps the cache');
  await f.call('POST', '/api/projects/p1/config', { toolboxes: 'core' });
  assert.equal(cleared, 0, 'a refused selection keeps the cache');
  await f.call('POST', '/api/projects/p1/config', { toolboxes: ['core', 'web'] });
  assert.equal(cleared, 1);
  assert.deepEqual(f.projects[0].toolboxes, ['core', 'web']);
});

test('#1007/#1006: a project keeps its own routing mode and tools mode; null goes back to the account', async () => {
  const f = fixture({ projects: [{ id: 'p1', files: [], toolboxes: ['core', 'web'] }] });
  for (const [body, error] of [
    [{ routingMode: 'cloud' }, 'routingMode must be an object or null'],
    [{ routingMode: { mode: 'everywhere' } }, "routingMode.mode must be 'local', 'cloud' or 'hybrid'"],
    [{ routingMode: { mode: 'hybrid', whenSensitive: 'never' } }, "routingMode.whenSensitive must be 'ask' or 'local'"],
    [{ toolsMode: 'sometimes' }, "toolsMode must be 'auto' or 'manual'"],
  ]) {
    await f.call('POST', '/api/projects/p1/config', body);
    assert.deepEqual(f.sent.pop(), { status: 400, body: { error } });
  }
  assert.equal(f.store.saves, 0, 'a refused patch saves nothing');
  await f.call('POST', '/api/projects/p1/config', { routingMode: { mode: 'hybrid', whenSensitive: 'local', extra: 1 }, toolsMode: 'auto' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.deepEqual(f.projects[0].routingMode, { mode: 'hybrid', whenSensitive: 'local' });
  assert.equal(f.projects[0].toolsMode, 'auto');
  assert.deepEqual(f.projects[0].toolboxes, ['core', 'web'], 'the hand-picked list is kept for Manual');
  await f.call('POST', '/api/projects/p1/config', { routingMode: null, toolsMode: 'manual' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(Object.hasOwn(f.projects[0], 'routingMode'), false);
  assert.equal(f.projects[0].toolsMode, 'manual');
});

test('#1079 the context profile: High is stored, Low and null clear it, anything else is refused', async () => {
  const f = fixture({ projects: [{ id: 'p1', routing: 'manual', model: 'Synthetic-12B-it' }] });
  await f.call('POST', '/api/projects/p1/config', { contextProfile: 'high' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(f.projects[0].contextProfile, 'high');
  // The model pick, routing and the profile are independent: the pick still names the model.
  assert.equal(f.projects[0].model, 'Synthetic-12B-it');
  assert.equal(f.projects[0].routing, 'manual');
  for (const bad of ['medium', 'HIGH', 1, true, {}]) {
    await f.call('POST', '/api/projects/p1/config', { contextProfile: bad });
    assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Invalid context profile' } });
    assert.equal(f.projects[0].contextProfile, 'high');
  }
  await f.call('POST', '/api/projects/p1/config', { name: 'Renamed' });
  assert.equal(f.projects[0].contextProfile, 'high', 'a patch without the field keeps it');
  await f.call('POST', '/api/projects/p1/config', { contextProfile: 'low' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal('contextProfile' in f.projects[0], false);
  await f.call('POST', '/api/projects/p1/config', { contextProfile: 'high' });
  await f.call('POST', '/api/projects/p1/config', { contextProfile: null });
  assert.equal('contextProfile' in f.projects[0], false);
});

test('#1458: renaming a project moves nothing: its storage folder and every source path stay as they are', async () => {
  const file = { name: 'noevia projects/proj-1/Text/a.md', content: 'a', source: 'noevia projects/proj-1', attachment: { id: 'x'.repeat(64), bytes: 1, group: 'Text', state: 'ready' } };
  const project = { id: 'p1', name: 'Before', projectFolder: 'noevia projects/proj-1', sourceFolders: ['noevia projects/proj-1'], files: [file], assets: [], chats: [] };
  const f = fixture({ projects: [project] });
  await f.call('POST', '/api/projects/p1/config', { name: 'After' });
  assert.equal(f.sent.at(-1).status, 200);
  assert.equal(project.name, 'After');
  assert.equal(project.projectFolder, 'noevia projects/proj-1');
  assert.deepEqual(project.sourceFolders, ['noevia projects/proj-1']);
  assert.deepEqual(project.files.map((x) => x.name), ['noevia projects/proj-1/Text/a.md']);
});


// #2191 round 8: every way a source reaches a project is the Rust front's (rust-project-source-work.cjs,
// rust-project-documents.cjs, rust-project-files.cjs and the project reads refuse them before this mount),
// so this router has no handler for any of them, with or without the old worker header or a background query.
test('the upload, the sync, the folder plan, the documents, the images and the file delete have no handler here', async () => {
  const f = fixture({ projects: [{ id: 'p1', files: [] }] });
  const work = { 'x-noevia-source-work': '1' };
  for (const [method, url, query, headers] of [
    ['POST', '/api/projects/p1/upload', '', undefined],
    ['POST', '/api/projects/p1/upload', '?background=1', undefined],
    ['POST', '/api/projects/p1/upload', '', work],
    ['POST', '/api/projects/p1/sources/sync', '', work],
    ['POST', '/api/projects/p1/folder-import/plan', '', undefined],
    ['POST', '/api/projects/p1/documents', '', undefined],
    ['POST', '/api/projects/p1/assets', '', undefined],
    ['GET', '/api/projects/p1/assets/img-1', '', undefined],
    ['DELETE', '/api/projects/p1/files', '', undefined],
    ['GET', '/api/projects/p1/source-jobs/11111111-1111-4111-8111-111111111111', '', undefined],
  ]) {
    assert.equal(await f.call(method, url, { name: 'x.txt' }, query, 'member', headers), false, `${method} ${url}${query}`);
  }
  assert.deepEqual(f.dispatched || [], [], 'nothing re-enters the router');
});
