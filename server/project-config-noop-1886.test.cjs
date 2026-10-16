'use strict';
// #1886: a config patch that changes nothing is a no-op: no save, no updatedAt bump. Synthetic project.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1886-'));
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
    storageClient: { isBrowsable: () => false, safeRelativePath: (f) => f }, documents: { isDocument: () => false }, documentSources: {},
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

const base = () => ({ id: 'p1', name: 'Synthetic', goal: '', instructions: 'x', memories: [], files: [], assets: [], chats: [], sourceFolders: ['Docs'], pinned: false, updatedAt: 111, reasoningEffort: 'high' });

test('#1886: re-sending the stored values writes nothing and keeps updatedAt', async (t) => {
  const f = fixture(t, base());
  await f.post({ sourceFolders: ['Docs'], name: 'Synthetic', instructions: 'x', reasoningEffort: 'high', pinned: false });
  assert.equal(f.sent.at(-1).status, 200);
  assert.equal(f.saves.length, 0, 'no save');
  assert.equal(f.projects[0].updatedAt, 111);
});

test('#1886: a real change still saves once, and clearing a stored key still counts as a change', async (t) => {
  const f = fixture(t, base());
  await f.post({ sourceFolders: ['Docs', 'More'] });
  assert.equal(f.saves.length, 1);
  assert.notEqual(f.projects[0].updatedAt, 111);
  await f.post({ reasoningEffort: null });
  assert.equal(f.saves.length, 2);
  assert.equal('reasoningEffort' in f.projects[0], false);
});
