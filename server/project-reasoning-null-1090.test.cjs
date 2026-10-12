'use strict';
// #1090: a project config patch with reasoningEffort: null clears the stored effort (the project then
// follows the account default). The merge into the stored project cannot remove a key on its own,
// so the route removes it. Synthetic project; the saves are fakes that record what was written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createProjectRoutes } = require('./routes/projects.cjs');
const reasoning = require('./reasoning-effort.cjs');

function fixture(t, project) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1090-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projects = [project];
  const saves = [];
  const sent = [];
  const routes = createProjectRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: require('./http.cjs').readJson,
    requestScope: new AsyncLocalStorage(), dispatch: async () => {},
    currentWorkspace: () => ({ dir, userId: 'u1', assertActive() {} }),
    authService: { getStorage: () => ({ kind: 'local' }) },
    storageClient: { isBrowsable: () => false }, documents: { isDocument: () => false }, documentSources: {},
    rag: { deleteProjectFile() {} }, fs, path, reasoningEffort: reasoning, projectAppearance: () => ({}),
    diaryExtras: { PROJECT_ID: 'diary-extras', internalProject: () => false, chatProjectId: (id) => id, newProject: () => ({}) },
    PROJECTS: projects, DEFAULT_TOOLBOXES: ['core'], sanitizeToolboxes: (b) => b, getProvider: () => ({}), ensureRolesLoaded() {},
    servedCatalogue: async () => null, DEFAULT_PROVIDER_ID: 'default',
    store: {
      getProject: (id) => projects.find((p) => p.id === id) || null,
      saveProjects: (list) => saves.push(JSON.parse(JSON.stringify(list))), pruneDocuments() {}, withSourceLock: (_p, op) => op(), indexSource() {},
      ownsFile: () => false, loadChats: () => [], saveChats() {}, deleteChat: () => false,
    },
  });
  const post = (body) => {
    const p = `/api/projects/${project.id}/config`;
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', url: p, headers: {}, socket: {} });
    return routes(req, {}, { path: p, authn: { user: { id: 'u1', role: 'member' } }, url: new URL(`http://localhost${p}`) });
  };
  return { post, sent, saves, projects };
}

test('#1090: reasoningEffort null clears the stored effort, and the save persists the cleared project', async (t) => {
  const f = fixture(t, { id: 'p1', name: 'Synthetic', files: [], assets: [], chats: [], reasoningEffort: 'high' });
  await f.post({ reasoningEffort: null });
  assert.equal(f.sent.at(-1).status, 200);
  assert.equal('reasoningEffort' in f.projects[0], false, 'the stored project no longer has an effort');
  assert.equal('reasoningEffort' in f.saves.at(-1)[0], false, 'and the save wrote none');
  assert.equal(reasoning.resolveEffort(f.projects[0], 'low'), 'low', 'so the account default applies');
});

test('#1090: an effort set to a valid value is still stored, and an invalid one is still refused', async (t) => {
  const f = fixture(t, { id: 'p1', name: 'Synthetic', files: [], assets: [], chats: [], reasoningEffort: 'high' });
  await f.post({ reasoningEffort: 'low' });
  assert.equal(f.projects[0].reasoningEffort, 'low');
  await f.post({ reasoningEffort: 'bogus' });
  assert.equal(f.sent.at(-1).status, 400);
  assert.equal(f.projects[0].reasoningEffort, 'low', 'a refused value changes nothing');
});
