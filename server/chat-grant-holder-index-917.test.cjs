'use strict';
// #917: the chatListHolder index.cjs wires into the chat route. Its lookup itself is
// chat-lists.cjs listHolding (tested in chat-grant-scope-917.test.cjs); index.cjs's AsyncLocalStorage
// request scope is not exported, so here we check the wiring and that it fails closed outside a
// signed-in request (the chat gate then grants nothing chat-wide). Synthetic data dir only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-grant-holder-917-'));
process.env.DIARY_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_DATA_DIR = testDataDir;
process.env.PUBLIC_ORIGIN = 'http://localhost';
const { chatListHolder } = require('./index.cjs');
test.after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

test('index.cjs exports the chat-list holder and it throws outside a signed-in request (#917)', () => {
  assert.equal(typeof chatListHolder, 'function');
  assert.throws(() => chatListHolder('synthetic-chat'), /authenticated workspace context required/);
});

test('index.cjs hands the chat route that same holder (#917)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.match(src, /const chatListHolder = \(chatId\) => require\('\.\/chat-lists\.cjs'\)\.listHolding\(chatId, Array\.from\(FREE_CHATS\), Array\.from\(PROJECTS\)\);/);
  const deps = src.slice(src.indexOf('createChatHandler('), src.indexOf('createChatHandler(') + 6000);
  assert.match(deps, /\n  chatListHolder,\n/);
});
