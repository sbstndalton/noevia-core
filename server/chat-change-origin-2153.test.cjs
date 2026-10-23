'use strict';
// sbstndalton/noevia#2153 (#1071): every Node caller of the Rust store's transcript ops names its
// origin, which the store journals and the change journal reader uses to build a chat's brain only
// for the user's own save (`history`). Stub stores only; synthetic, QA-named data.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const psc = require('./project-store-client.cjs');
const { localTranscripts } = require('../tests/server/project-store-server.cjs');

const USER = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'synthetic-store-token-0123456789abcdef';

/** A store that records each request body and answers every op successfully. */
async function capturingStore() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      bodies.push({ url: req.url, body });
      const answer = req.url === '/v1/history/write' ? { revision: 'r' } : req.url === '/v1/history/append-if-last' ? { outcome: 'saved', revision: 'r' } : { removed: true };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = psc.createClient({ port: server.address().port, token: TOKEN, timeoutMs: 2000 });
  return { bodies, client, close: () => new Promise((r) => server.close(r)) };
}

test('the client sends the origin it is given on all three ops, and `other` when none or an unknown one', async (t) => {
  const s = await capturingStore();
  t.after(s.close);
  const tr = psc.transcriptsFor(s.client, USER);
  await tr.write('qa-c', [1], { origin: 'history', supersedePartial: true });
  await tr.write('qa-c', [1], { ifAbsent: true, origin: 'import' });
  await tr.write('qa-c', [1]);
  await tr.write('qa-c', [1], { origin: 'bogus' });
  await tr.appendIfLast('qa-c', 'm', { role: 'assistant' }, { origin: 'turn' });
  await tr.appendIfLast('qa-c', 'm', { role: 'assistant' });
  await tr.removeIf('qa-c', [1], { origin: 'remove' });
  await tr.removeIf('qa-c', [1]);
  assert.deepEqual(s.bodies.map((b) => [b.url.slice('/v1/history/'.length), b.body.origin, b.body.user]), [
    ['write', 'history', USER], ['write', 'import', USER], ['write', 'other', USER], ['write', 'other', USER],
    ['append-if-last', 'turn', USER], ['append-if-last', 'other', USER],
    ['remove-if', 'remove', USER], ['remove-if', 'other', USER],
  ]);
  assert.deepEqual([...psc.HISTORY_ORIGINS].sort(), ['history', 'import', 'other', 'remove', 'turn']);
});

test('#1071 slice 5: Node no longer serves the history POST; the Rust front\'s save journals origin history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-origin-lists-'));
  try {
    const dir = path.join(root, 'users', USER);
    fs.mkdirSync(dir, { recursive: true });
    const calls = [];
    const transcripts = localTranscripts(dir, calls);
    const sent = [];
    const routes = require('./routes/chat-lists.cjs').createChatListRoutes({
      json: (res, status, body) => { sent.push({ status, body }); },
      readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
      currentWorkspace: () => ({ dir, transcripts }),
      PROJECTS: [], FREE_CHATS: [], diaryExtras: { internalProject: () => false }, STORED_HISTORY_BYTES: 10000,
      chatLists: () => ({ freeChats: [], projects: [] }), removeChat: () => {},
      store: { sanitizeChats: (c) => c || [], saveFreeChats() {}, deleteFreeChat: () => false, readHistory: () => [] },
    });
    const req = Readable.from([Buffer.from(JSON.stringify({ history: [{ role: 'user', content: 'qa' }] }))]);
    req.method = 'POST';
    assert.equal(await routes(req, { setHeader() {} }, { path: '/api/chats/qa-c1/history', authn: { user: { id: USER, role: 'member' } } }), false);
    assert.deepEqual([sent, calls], [[], []], 'Node answers and writes nothing');
    assert.equal(require('./rust-projects.cjs').ownedRoute('POST', '/api/chats/qa-c1/history'), true, 'refused before any mount');
    const saved = require('../tests/server/project-store-server.cjs').rustHistorySave(root, USER, 'qa-c1', { history: [{ role: 'user', content: 'qa' }] });
    assert.equal(saved.status, 200, saved.text);
    const journal = fs.readFileSync(path.join(dir, 'chat-changes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(journal.map((e) => [e.chatId, e.op, e.origin]), [['qa-c1', 'write', 'history']]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an interrupted reply is appended with origin turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-origin-turn-'));
  try {
    const seen = [];
    const workspace = { dir, transcripts: { appendIfLast: async (chat, message, entry, options) => { seen.push([chat, message, options]); return 'saved'; } } };
    const { saveInterruptedTurn } = require('./chat-interrupted-turn.cjs');
    assert.equal(await saveInterruptedTurn({ workspace, chatId: 'qa-c1', message: 'qa q', entry: { role: 'assistant', content: 'qa partial' } }), 'saved');
    assert.deepEqual(seen, [['qa-c1', 'qa q', { origin: 'turn' }]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the store stand-in refuses an unknown origin as the Rust store does, and journals a known one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-origin-standin-'));
  try {
    const tr = localTranscripts(dir);
    await assert.rejects(tr.write('qa-c', [1], { origin: 'brain' }), (e) => e.status === 400 && /origin/.test(e.message));
    assert.equal(fs.existsSync(path.join(dir, 'history-qa-c.json')), false);
    await tr.write('qa-c', [1]);
    const [entry] = fs.readFileSync(path.join(dir, 'chat-changes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual([entry.seq, entry.op, entry.origin], [1, 'write', 'other']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
