'use strict';
// #1236: a null entry in project.files (a damaged projects.json) must not throw a TypeError in the
// edit planner or the project text write. It is dropped when the workspace loads the project, and
// the planner and writer also tolerate one that gets in some other way. Synthetic projects only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planEdit } = require('./project-edit-target.cjs');
const { createWorkspaceStore } = require('./workspace.cjs');
const { createStubStore } = require('../tests/server/project-store-stub.cjs');

const ROOT = 'noevia projects';

test('#1236: the edit planner accepts a null entry beside the file it edits', () => {
  const project = { id: 'p1', name: 'Trip', projectFolder: `${ROOT}/Trip`, files: [{ name: 'a.md', content: 'x' }, null] };
  const plan = planEdit(project, 'a.md', { storageAccount: 'acct-1' });
  assert.equal(plan.adopt, true);
  assert.equal(plan.target, `${ROOT}/Trip/Text/a.md`);
});

test('#1236: the planner still refuses a real clash with the target name, beside a null entry', () => {
  const project = { id: 'p1', name: 'Trip', projectFolder: `${ROOT}/Trip`, files: [null, { name: 'a.md', content: 'x' }, { name: `${ROOT}/Trip/Text/a.md`, content: 'y' }] };
  assert.throws(() => planEdit(project, 'a.md', { storageAccount: 'acct-1' }), /already a separate file/);
});

test('#1236: a damaged projects.json with a null file entry loads without the null', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1236-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userId = '11111111-2222-4333-8444-555555555555';
  const userDir = path.join(root, 'users', userId);
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'projects.json'), JSON.stringify({ projects: [{ id: 'p1', name: 'Trip', files: [null, { name: 'a.md', content: 'x' }, 7] }] }));
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', apiKey: '' }, null, { projectStore: createStubStore(root) });
  const workspace = store.get(userId);
  assert.deepEqual(workspace.projects[0].files.map((f) => f.name), ['a.md'], 'only the real entry remains');
});
