'use strict';
// #741: the chat -> Diary vault mirror. Its work (notes, index, moves, Trash) is the Rust front's
// (noevia-rs crates/chat-mirror-exec, replayed byte for byte against this core's former executor in
// crates/chat-mirror-exec/tests/oracle.rs); what stays here is the trigger. Synthetic paths only.
const test = require('node:test');
const assert = require('node:assert/strict');
const mirrorLib = require('./chat-vault-mirror.cjs');
const { mirrorTrigger } = mirrorLib;

test('mirrorTrigger: only writes to chats, moves, projects and imports', () => {
  // The transcript save is the Rust front's (#1071 slice 5); the Rust front's journal consumer schedules it.
  assert.equal(mirrorTrigger('POST', '/api/chats/c%201/history'), null);
  assert.equal(mirrorTrigger('POST', '/api/chats/c%201/move'), null);
  assert.equal(mirrorTrigger('POST', '/api/chats/c1/move'), null);
  assert.deepEqual(mirrorTrigger('POST', '/api/freechats'), { chatId: null });
  assert.deepEqual(mirrorTrigger('DELETE', '/api/freechats/c1'), { chatId: null });
  assert.deepEqual(mirrorTrigger('POST', '/api/projects/p/chats'), { chatId: null });
  assert.equal(mirrorTrigger('GET', '/api/freechats'), null);
  assert.equal(mirrorTrigger('POST', '/api/chat'), null, 'a streaming reply is mirrored when its transcript is saved');
  assert.equal(mirrorTrigger('POST', '/api/diary/entries'), null);
});

test('the mirror pass, the note rendering, the index and the preferences reader are the Rust front\'s (rust-chat-mirror-exec-v1)', () => {
  assert.deepEqual(Object.keys(mirrorLib), ['mirrorTrigger']);
});
