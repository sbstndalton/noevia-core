'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeChats } = require('./index.cjs');

// Regression: a bare chat-id string in a project's chats[] reached the browser
// through GET /api/workspace, which served PROJECTS raw. The client spreads
// each meta into an object — spreading a string yields {0:'p',1:'-',...} with
// no title — and the sidebar's title filter then called .toLowerCase() on
// undefined, throwing during render and blanking the entire app. loadChats
// already filtered these; /api/workspace did not.
test('malformed chat metas are dropped before they can reach a client', () => {
  const chats = sanitizeChats([
    { id: 'c-1', title: 'Real chat', updatedAt: 1 },
    'p-1788477601494-95kowx', // the orphaned placeholder that blanked the app
    null,
    undefined,
    42,
    { title: 'no id at all' },
    { id: 99, title: 'non-string id' },
    { id: 'c-2', title: 'Also real', updatedAt: 2 },
  ]);

  assert.deepEqual(chats.map((c) => c.id), ['c-1', 'c-2']);
  // Every survivor must be safe to spread and read .title from.
  for (const c of chats) assert.equal(typeof { ...c }.title, 'string');
});

test('sanitizeChats tolerates a missing or empty chats array', () => {
  assert.deepEqual(sanitizeChats(undefined), []);
  assert.deepEqual(sanitizeChats(null), []);
  assert.deepEqual(sanitizeChats([]), []);
});
