'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaceStore } = require('./workspace.cjs');
const { readUsage, recordUsage, recordToolUse, usageDayKey } = require('./usage.cjs');

const DELETED_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

test('stale reply and tool accounting cannot recreate a deleted tenant, while active tenants keep their counts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-usage-account-deletion-'));
  try {
    const store = createWorkspaceStore(root, { id: 'default', label: 'Default', apiKey: '' });
    const workspace = store.get(DELETED_ID);
    const other = store.get(OTHER_ID);
    const day = usageDayKey();

    recordUsage(workspace, 'synthetic-model', { promptTokens: 3, completionTokens: 4 });
    recordToolUse(workspace, 'synthetic_read');
    assert.equal(readUsage(workspace).days[day].input, 3);
    assert.equal(readUsage(workspace).days[day].output, 4);
    assert.equal(readUsage(workspace).days[day].tools.synthetic_read, 1);

    store.remove(DELETED_ID);
    assert.equal(fs.existsSync(workspace.dir), false);
    recordUsage(workspace, 'synthetic-model', { promptTokens: 5, completionTokens: 6 });
    recordToolUse(workspace, 'synthetic_read');
    assert.equal(fs.existsSync(workspace.dir), false, 'neither stale writer recreates usage.json');

    recordUsage(other, 'other-model', { promptTokens: 7, completionTokens: 8 });
    recordToolUse(other, 'other_read');
    const otherDay = readUsage(other).days[day];
    assert.equal(otherDay.input, 7);
    assert.equal(otherDay.output, 8);
    assert.equal(otherDay.tools.other_read, 1);
    assert.ok(fs.existsSync(path.join(other.dir, 'usage.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
