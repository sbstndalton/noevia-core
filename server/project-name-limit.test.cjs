'use strict';
// #398: the create/edit project name fields silently let a user type past what the server keeps
// — createProject (projects.cjs) and the PATCH handler (routes/projects.cjs) both truncate to
// 120 characters with no feedback. The fix adds a client-side maxLength/counter reading the same
// cap; these tests pin the server side of that parity: one JSON file (project-limits.json) is the
// only place the number 120 is allowed to live, and both server call sites read it rather than a
// separate hardcoded literal that could drift from what src/project-limits.ts gives the UI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectStore } = require('./projects.cjs');
const { nameMaxLength } = require('./project-limits.json');

function fixture({ browsable = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-projects-'));
  const workspace = {
    dir, userId: 'u1', projects: [], freeChats: [],
    saved: 0, savedFree: 0,
    saveProjects() { this.saved += 1; }, saveFreeChats() { this.savedFree += 1; },
    historyPath: (id) => path.join(dir, `${id}.json`),
    assetDir: (id) => path.join(dir, 'assets', id),
  };
  const store = createProjectStore({
    fs, path,
    reasoningEffort: { validEffort: (e) => ['default', 'low', 'high'].includes(e) },
    projectAppearance: (body) => (body.icon === 'bad' ? (() => { throw new Error('unknown icon'); })() : { icon: body.icon || 'folder' }),
    rag: { indexProjectFile: async () => ({ ok: true, stored: 1, embedded: 1 }), deleteProjectFile: () => {} },
    storageClient: { isBrowsable: () => browsable },
    documentSources: { prune() {}, directory: () => path.join(dir, 'docs') },
    authService: { getStorage: () => ({ kind: browsable ? 'webdav' : 'local' }) },
    currentWorkspace: () => workspace,
    PROJECTS: workspace.projects, FREE_CHATS: workspace.freeChats,
    sanitizeToolboxes: (boxes) => (Array.isArray(boxes) ? boxes : null),
    defaultToolboxes: () => ['core'],
    PROJECT_ROOT_FOLDER: 'noevia projects',
    createProjectFolder: async (_storage, _connection, root, project) => `${root}/${project.name}`,
    projectSweep: { afterDelete: async () => {} },
  });
  return { store, dir };
}

test('project-limits.json defines the 120-character cap the #398 fix reads on both client and server', () => {
  assert.equal(nameMaxLength, 120);
});

test('createProject truncates a name to exactly nameMaxLength characters, not a separate literal', async () => {
  const f = fixture();
  const longName = `${'x'.repeat(nameMaxLength + 50)}`;
  const project = await f.store.createProject({ name: longName });
  assert.equal(project.name.length, nameMaxLength);
  assert.equal(project.name, 'x'.repeat(nameMaxLength));
});

test('a name within the limit is preserved exactly (only trimmed, not shortened)', async () => {
  const f = fixture();
  const project = await f.store.createProject({ name: '  Short name  ' });
  assert.equal(project.name, 'Short name');
});

test('projects.cjs reads the shared constant rather than a hardcoded 120', () => {
  const src = fs.readFileSync(path.join(__dirname, 'projects.cjs'), 'utf8');
  assert.match(src, /require\(['"]\.\/project-limits\.json['"]\)/);
  assert.match(src, /slice\(0, PROJECT_NAME_MAX_LENGTH\)/);
  assert.doesNotMatch(src, /slice\(0, 120\)/, 'the literal 120 must not reappear once the shared constant exists');
});

test('routes/projects.cjs\'s PATCH handler reads the same shared constant, not its own literal 120', () => {
  const src = fs.readFileSync(path.join(__dirname, 'routes/projects.cjs'), 'utf8');
  assert.match(src, /require\(['"]\.\.\/project-limits\.json['"]\)/);
  assert.match(src, /slice\(0, PROJECT_NAME_MAX_LENGTH\)/);
  assert.doesNotMatch(src, /patch\.name\.trim\(\)\.slice\(0, 120\)/, 'the PATCH path must not keep its own hardcoded 120');
});

test('the client reads the identical JSON file (src/project-limits.ts), so the dialogs cannot drift from the server cap', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/project-limits.ts'), 'utf8');
  assert.match(src, /project-limits\.json/);
  assert.match(src, /PROJECT_NAME_MAX_LENGTH/);
});
