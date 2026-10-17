'use strict';
// #1406 / #1419 / #1420: a failed save answers with the right status. 400 only for a bad request;
// a busy store is 503 (with Retry-After); a disk failure is 500. A free-chat list that holds null reads
// as an empty list. The chat-list and free-chat-list saves themselves are the Rust front's since
// sbstndalton/noevia#1071 (noevia-rs project_writes_removed_account.rs covers their replies); what is
// left here is Node's shared reply (saveFailureReply) and its workspace load. Synthetic data only.
const test = require('node:test');
const { createStubStore } = require('../tests/server/project-store-stub.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveFailureReply } = require('./http.cjs');

const busy = () => Object.assign(new Error('The project store is busy. Try again shortly.'), { status: 503, code: 'PROJECTS_BUSY' });

test('#1420: the workspace loads a free-chats file that holds null as an empty list', () => {
  const { createWorkspaceStore } = require('./workspace.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1420-'));
  try {
    const userId = '11111111-2222-4333-8444-666666666666';
    fs.mkdirSync(path.join(root, 'users', userId), { recursive: true });
    fs.writeFileSync(path.join(root, 'users', userId, 'free-chats.json'), 'null');
    const workspace = createWorkspaceStore(root, { id: 'default', label: 'Default', apiKey: '' }, null, { projectStore: createStubStore(root) }).get(userId);
    assert.deepEqual(Array.from(workspace.freeChats), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('saveFailureReply: a 4xx the store chose is kept, and a 400 is never used for a failed save', () => {
  const seen = [];
  const send = (res, code, body, headers) => seen.push({ code, body, headers });
  saveFailureReply(send, {}, Object.assign(new Error('gone'), { status: 410 }));
  assert.equal(seen[0].code, 410, 'a status the store chose (a retired account) is kept');
  seen.length = 0;
  saveFailureReply(send, {}, Object.assign(new Error('bad'), { status: 400 }));
  assert.equal(seen[0].code, 500, 'a 400 from a failed save becomes 500');
  seen.length = 0;
  saveFailureReply(send, {}, busy());
  assert.equal(seen[0].code, 503);
  assert.deepEqual(seen[0].headers, { 'Retry-After': '1' });
  assert.equal(seen[0].body.code, 'PROJECTS_BUSY');
  seen.length = 0;
  saveFailureReply(send, {}, new Error('EACCES /x'), 'could not save; nothing was changed');
  assert.equal(seen[0].code, 500);
  assert.equal(JSON.stringify(seen[0].body).includes('EACCES'), false);
});
