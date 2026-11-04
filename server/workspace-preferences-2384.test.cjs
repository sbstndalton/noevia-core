'use strict';
// sbstndalton/noevia#2384: preferences.json is written by the Rust front only (PUT /api/routing-default). The Node workspace
// has no writer for it and reads it again whenever it changed, so a project created here after the front's write starts
// from the new default instead of the one held from the load.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWorkspaceStore } = require('./workspace.cjs');
const { createStubStore } = require('../tests/server/project-store-stub.cjs');

const USER = '11111111-2222-4333-8444-555555555555';
const DEFAULT = { id: 'local', label: 'Local', baseUrl: '', apiKey: '' };

test('the workspace has no preferences writer and follows the file the front writes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-prefs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'users', USER, 'preferences.json');
  const ws = createWorkspaceStore(root, DEFAULT, null, { projectStore: createStubStore(root) }).get(USER);
  assert.equal(ws.savePreferences, undefined, 'Node never writes preferences.json');
  assert.deepEqual(ws.preferences, {}, 'a missing file is no preferences');
  // The front writes (an atomic rename, a new inode); the next read sees it without a restart.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ defaultRouting: 'manual' }, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  assert.equal(ws.preferences.defaultRouting, 'manual');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ defaultRouting: 'auto', other: 1 }, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  assert.deepEqual(ws.preferences, { defaultRouting: 'auto', other: 1 });
  // Falsy or unreadable content is {} as it was when the file was read once at load (readJson(...) || {}).
  for (const text of ['null', '0', '""', 'false', '{ not json']) {
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
    assert.deepEqual(ws.preferences, {}, text);
  }
  fs.rmSync(file);
  assert.deepEqual(ws.preferences, {});
});
