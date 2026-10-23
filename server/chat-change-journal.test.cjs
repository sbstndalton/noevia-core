'use strict';
// sbstndalton/noevia#2153: Node tails the Rust store's chat change journal (chat-change-journal.cjs)
// and schedules the chat mirror and brain for each changed chat. A loopback stand-in for the store
// serves POST /v1/changes/read over a real chat-changes.jsonl in the format noevia-rs journal.rs
// writes (that side has its own HTTP tests). Synthetic, QA-named data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const psc = require('./project-store-client.cjs');
const { createChangeJournalReader, scheduleMirrorAndBrain, journalCovers, JOURNAL_READER_MARKER } = require('./chat-change-journal.cjs');
const { createChatVaultMirror } = require('./chat-vault-mirror.cjs');
const { createBrainScheduler } = require('./chat-brain.cjs');

const USER = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const TOKEN = 'synthetic-store-token-0123456789abcdef';
const START_A = '0123456789abcdef0123456789abcdef';
const START_B = 'fedcba9876543210fedcba9876543210';

/** The store's changes op over real journal files, as journal.rs answers it. */
async function fakeStore(root, { start = START_A, missingOp = false } = {}) {
  const state = { start, fail: 0, calls: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      state.calls += 1;
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers['x-noevia-store-token'] !== TOKEN) return send(401, { error: 'unauthorised' });
      if (missingOp || req.url !== '/v1/changes/read') return send(404, { error: 'not found' });
      if (state.fail > 0) { state.fail -= 1; return send(500, { error: 'Internal error' }); }
      const b = JSON.parse(raw);
      const file = path.join(root, 'users', b.user, 'chat-changes.jsonl');
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const all = text.split('\n').slice(0, -1).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const newer = all.filter((e) => e.seq > (b.after || 0));
      send(200, { entries: newer.slice(0, 1000), oldestSeq: all[0]?.seq ?? null, latestSeq: all.at(-1)?.seq ?? null, more: newer.length > 1000, start: state.start });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { state, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/** Appends entries as the Rust store does (seq from the last line). */
function journalWrite(root, user, chatId, revision, { start = START_A, op = 'write', origin = 'history' } = {}) {
  const dir = path.join(root, 'users', user);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'chat-changes.jsonl');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const seq = lines.length ? JSON.parse(lines.at(-1)).seq + 1 : 1;
  fs.appendFileSync(file, `${JSON.stringify({ seq, chatId, revision, op, ...(origin ? { origin } : {}), start, at: Date.now() })}\n`);
  return seq;
}

/** Keeps the newest `keep` entries, as a rotation does. */
function journalRotate(root, user, keep) {
  const file = path.join(root, 'users', user, 'chat-changes.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(file, `${lines.slice(-keep).join('\n')}\n`);
}

function spies() {
  const mirror = [], brain = [];
  return {
    mirror, brain,
    deps: { chatVaultMirror: { schedule: (u, c) => mirror.push(`${u}:${c}`) }, chatBrains: { schedule: (u, c) => brain.push(`${u}:${c}`) } },
  };
}

async function harness(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-change-journal-'));
  const store = await fakeStore(root, opts);
  const client = psc.createClient({ port: store.port, token: TOKEN, timeoutMs: 2000 });
  const s = spies();
  const logs = [];
  const reader = createChangeJournalReader({ read: (u, a) => client.changesRead(u, a), onChange: scheduleMirrorAndBrain(s.deps), log: (...a) => logs.push(a.join(' ')), setTimer: () => null, clearTimer: () => {} });
  return { root, store, client, reader, logs, ...s, done: async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('an entry the Rust store wrote schedules both the mirror and the brain', async () => {
  const h = await harness();
  try {
    await h.reader.poll(USER); // first read: an empty journal, nothing to do
    assert.deepEqual([h.mirror, h.brain], [[], []]);
    assert.equal(h.reader.active(), true);
    journalWrite(h.root, USER, 'qa-chat-1', 'r1');
    await h.reader.poll(USER);
    assert.deepEqual(h.mirror, [`${USER}:qa-chat-1`]);
    assert.deepEqual(h.brain, [`${USER}:qa-chat-1`]);
    assert.deepEqual(h.reader.cursor(USER), { seq: 1, start: START_A });
    // Another user's journal is read for that user only.
    journalWrite(h.root, OTHER, 'qa-theirs', 'r9');
    await h.reader.poll(USER);
    assert.deepEqual(h.mirror, [`${USER}:qa-chat-1`]);
    await h.reader.poll(OTHER);
    assert.deepEqual(h.mirror.at(-1), `${OTHER}:qa-theirs`);
  } finally { await h.done(); }
});

test('the same chat and revision is scheduled once; a new revision again', async () => {
  const h = await harness();
  try {
    await h.reader.poll(USER);
    journalWrite(h.root, USER, 'qa-c', 'r1');
    journalWrite(h.root, USER, 'qa-c', 'r1'); // e.g. the same save journalled through two paths
    await h.reader.poll(USER);
    assert.equal(h.mirror.length, 1);
    journalWrite(h.root, USER, 'qa-c', 'r2');
    journalWrite(h.root, USER, 'qa-c', null); // a removal always counts
    await h.reader.poll(USER);
    assert.deepEqual(h.brain, [`${USER}:qa-c`, `${USER}:qa-c`, `${USER}:qa-c`]);
  } finally { await h.done(); }
});

test('the journal replaces the Node nudge only while the store journals', async () => {
  const h = await harness();
  const old = await harness({ missingOp: true });
  try {
    assert.equal(journalCovers(h.reader, 'POST', '/api/chats/qa-c/history'), false, 'unknown until the first read');
    await h.reader.poll(USER);
    assert.equal(journalCovers(h.reader, 'POST', '/api/chats/qa-c/history'), true);
    // A move, a project change or another method is still mirrorTrigger's.
    assert.equal(journalCovers(h.reader, 'POST', '/api/chats/qa-c/move'), false);
    assert.equal(journalCovers(h.reader, 'POST', '/api/projects'), false);
    assert.equal(journalCovers(h.reader, 'DELETE', '/api/chats/qa-c/history'), false);
    // An older Rust front without the op: inactive, nothing scheduled, nothing logged as a failure.
    journalWrite(old.root, USER, 'qa-c', 'r1');
    await old.reader.poll(USER);
    assert.equal(old.reader.active(), false);
    assert.equal(journalCovers(old.reader, 'POST', '/api/chats/qa-c/history'), false);
    assert.deepEqual([old.mirror, old.logs], [[], []]);
  } finally { await h.done(); await old.done(); }
});

test('a restart of either side rescans every chat still in the journal, once each', async () => {
  const h = await harness();
  try {
    for (const [chat, rev] of [['qa-a', 'r1'], ['qa-b', 'r1'], ['qa-a', 'r2']]) journalWrite(h.root, USER, chat, rev);
    // Node restarted (a fresh reader): its first read rescans, each chat once.
    await h.reader.poll(USER);
    assert.deepEqual(h.mirror.sort(), [`${USER}:qa-a`, `${USER}:qa-b`]);
    assert.deepEqual(h.reader.cursor(USER), { seq: 3, start: START_A });
    // The store restarted (another start id): rescan again, even revisions already scheduled.
    h.store.state.start = START_B;
    await h.reader.poll(USER);
    assert.equal(h.mirror.length, 4);
    assert.deepEqual(h.reader.cursor(USER), { seq: 3, start: START_B });
    // Nothing new, same start: nothing.
    await h.reader.poll(USER);
    assert.equal(h.mirror.length, 4);
  } finally { await h.done(); }
});

test('a reader that fell behind a rotation, or past a reset journal, rescans', async () => {
  const h = await harness();
  try {
    journalWrite(h.root, USER, 'qa-0', 'r');
    await h.reader.poll(USER);
    const before = h.mirror.length;
    for (let i = 1; i <= 10; i++) journalWrite(h.root, USER, `qa-${i}`, 'r');
    journalRotate(h.root, USER, 3); // keeps 9..11; the cursor at 1 missed 2..8
    await h.reader.poll(USER);
    assert.deepEqual(h.mirror.slice(before).sort(), [`${USER}:qa-10`, `${USER}:qa-8`, `${USER}:qa-9`]);
    assert.equal(h.reader.cursor(USER).seq, 11);
    // The journal was reset under the reader (its cursor is past the end).
    fs.writeFileSync(path.join(h.root, 'users', USER, 'chat-changes.jsonl'), '');
    journalWrite(h.root, USER, 'qa-fresh', 'r');
    await h.reader.poll(USER);
    assert.equal(h.mirror.at(-1), `${USER}:qa-fresh`);
    assert.equal(h.reader.cursor(USER).seq, 1);
  } finally { await h.done(); }
});

test('a failed read is logged once, retried, and never throws', async () => {
  const h = await harness();
  try {
    await h.reader.poll(USER);
    journalWrite(h.root, USER, 'qa-c', 'r1');
    h.store.state.fail = 3;
    for (let i = 0; i < 3; i++) await assert.doesNotReject(h.reader.poll(USER));
    assert.equal(h.mirror.length, 0);
    assert.equal(h.logs.filter((l) => l.includes('read failed')).length, 1);
    await h.reader.poll(USER);
    assert.deepEqual(h.mirror, [`${USER}:qa-c`]);
    assert.ok(h.logs.some((l) => l.includes('reading again')));
    // An unreachable store and an onChange that throws are contained too.
    const r = createChangeJournalReader({ read: async () => { throw new Error('ECONNREFUSED'); }, onChange: () => {}, log: () => {}, setTimer: () => null });
    await assert.doesNotReject(r.poll(USER));
    const logs = [];
    const throwing = createChangeJournalReader({ read: async () => ({ entries: [{ seq: 1, chatId: 'qa-x', revision: 'r' }], oldestSeq: 1, latestSeq: 1, start: START_A }),
      onChange: () => { throw new Error('boom'); }, log: (...a) => logs.push(a.join(' ')), setTimer: () => null });
    await assert.doesNotReject(throwing.poll(USER));
    assert.ok(logs.some((l) => l.includes('scheduling failed')));
  } finally { await h.done(); }
});

test('the timer reads active users only; a request start reads that user at once', async () => {
  let t = 1_000_000;
  const reads = [];
  let timerFn = null;
  const r = createChangeJournalReader({ read: async (u, after) => { reads.push(`${u}@${after}`); return { entries: [], oldestSeq: null, latestSeq: null, more: false, start: START_A }; },
    onChange: () => {}, log: () => {}, now: () => t, activeMs: 1000, intervalMs: 2000, setTimer: (fn, ms) => { timerFn = fn; assert.equal(ms, 2000); return { unref() {} }; }, clearTimer: () => {} });
  r.start();
  assert.equal(typeof timerFn, 'function');
  await r.tick();
  assert.deepEqual(reads, [], 'nobody active yet');
  r.touch(USER);
  await r.poll(USER); // joins the touch's read (and reads once more, having been asked again)
  assert.ok(reads.length >= 1 && reads.every((x) => x === `${USER}@0`), String(reads));
  const k = reads.length;
  await r.tick();
  assert.equal(reads.length, k + 1);
  t += 5000; // quiet past ACTIVE_MS: dropped from the timer, cursor kept
  await r.tick();
  assert.equal(reads.length, k + 1);
  assert.deepEqual(r.cursor(USER), { seq: 0, start: START_A });
  r.stop();
});

test('asked again while a read runs, it reads once more after (a save landing mid-read is not missed)', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const entries = [];
  const scheduled = [];
  let n = 0;
  const r = createChangeJournalReader({
    read: async () => { n += 1; if (n === 2) await gate; return { entries: entries.slice(), oldestSeq: entries.length ? 1 : null, latestSeq: entries.length || null, more: false, start: START_A }; },
    onChange: (u, c) => scheduled.push(c), log: () => {}, setTimer: () => null });
  await r.poll(USER); // cursor 0
  const first = r.poll(USER); // blocked at read 2, before the save
  entries.push({ seq: 1, chatId: 'qa-late', revision: 'r1' });
  const second = r.poll(USER); // the save's finish asks again
  release();
  await first; await second;
  assert.deepEqual(scheduled, ['qa-late']);
});

test('the mirror and the brain are idempotent under repeated scheduling (what a rescan relies on)', async () => {
  // Mirror: one dirty set and one debounce timer per user, however many times a chat is scheduled.
  const timers = [];
  const mirror = createChatVaultMirror({ enabled: () => true, lists: () => ({ freeChats: [], projects: [] }), readHistory: () => [],
    files: { read: async () => ({ content: null }), write: async () => ({}), mkdir: async () => ({}), ops: async () => ({}) },
    index: { read: () => ({}), write: () => {} },
    setTimer: (fn, ms) => { const tm = { fn, ms, done: false }; timers.push(tm); return tm; }, clearTimer: (tm) => { tm.done = true; }, now: () => 1000 });
  mirror.schedule(USER, 'qa-c'); mirror.schedule(USER, 'qa-c'); mirror.schedule(USER, 'qa-c');
  assert.equal(timers.filter((tm) => !tm.done).length, 1);
  // Brain: one timer per chat, and a stored brain for the chat's updatedAt is 'current' (no model call).
  const btimers = [];
  let builds = 0;
  const stored = new Map();
  const brains = createBrainScheduler({ enabled: () => true, chat: () => ({ id: 'qa-c', updatedAt: 42 }), readHistory: () => [{ role: 'user', content: 'qa' }],
    store: { read: (u, c) => stored.get(c) || null, write: (u, c, rec) => stored.set(c, rec) },
    builder: { build: async () => { builds += 1; return { ok: true, brain: { summary: 'qa' } }; } },
    setTimer: (fn) => { const tm = { fn, done: false }; btimers.push(tm); return tm; }, clearTimer: (tm) => { tm.done = true; } });
  brains.schedule(USER, 'qa-c'); brains.schedule(USER, 'qa-c');
  assert.equal(btimers.filter((tm) => !tm.done).length, 1);
  assert.equal(await brains.run(USER, 'qa-c'), 'built');
  assert.equal(await brains.run(USER, 'qa-c'), 'current');
  assert.equal(builds, 1);
});

test('the reader carries the marker assemble-release looks for', () => {
  assert.equal(JOURNAL_READER_MARKER, 'noevia-chat-change-journal-reader/1');
  assert.ok(fs.readFileSync(path.join(__dirname, 'chat-change-journal.cjs'), 'utf8').includes(`'${JOURNAL_READER_MARKER}'`));
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.match(index, /createChangeJournalReader\(/);
  assert.match(index, /changeJournal\.touch\(authn\.user\.id\)/);
});

test('the timer calls the store only when the journal file changed, and not at all against a store without the op', async () => {
  const reads = [];
  let st = 'a';
  const body = { entries: [], oldestSeq: null, latestSeq: null, more: false, start: START_A };
  const r = createChangeJournalReader({ read: async (u, after) => { reads.push(after); return body; }, onChange: () => {}, log: () => {},
    stamp: () => st, setTimer: () => null });
  r.touch(USER); await r.poll(USER);
  const k = reads.length;
  await r.tick(); await r.tick(); await r.tick(); // the request start read this stamp: no store call
  assert.equal(reads.length, k);
  st = 'b';
  await r.tick();
  assert.equal(reads.length, k + 1);
  // Older front (404): the timer stops calling; a request start still probes.
  const probes = [];
  const old = createChangeJournalReader({ read: async () => { probes.push(1); return { unsupported: true }; }, onChange: () => {}, log: () => {}, stamp: () => null, setTimer: () => null });
  old.touch(USER); await old.poll(USER);
  const p = probes.length;
  await old.tick(); await old.tick();
  assert.equal(probes.length, p);
});

test('fileStamp changes with the journal and refuses a path that is not a user id', () => {
  const { fileStamp } = require('./chat-change-journal.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-change-journal-stamp-'));
  try {
    assert.equal(fileStamp(root, '../../etc'), null);
    assert.equal(fileStamp(root, USER), 'absent');
    journalWrite(root, USER, 'qa-c', 'r1');
    const one = fileStamp(root, USER);
    journalWrite(root, USER, 'qa-c', 'r2');
    assert.notEqual(fileStamp(root, USER), one);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a request start reads the store only when the journal stamp changed (or the last read failed)', async () => {
  const reads = [];
  let st = 's1', fail = false;
  const body = { entries: [], oldestSeq: null, latestSeq: null, more: false, start: START_A };
  const r = createChangeJournalReader({ read: async (u, after) => { reads.push(after); if (fail) throw new Error('down'); return body; }, onChange: () => {}, log: () => {},
    stamp: () => st, setTimer: () => null });
  r.touch(USER); await r.poll(USER); // no cursor yet: reads
  const k = reads.length;
  for (let i = 0; i < 5; i++) { r.touch(USER); await r.poll; }
  await new Promise((res) => setImmediate(res));
  assert.equal(reads.length, k, 'unchanged stamp: five request starts make no store read');
  st = 's2';
  r.touch(USER); await new Promise((res) => setImmediate(res));
  r.touch(USER); r.touch(USER); await new Promise((res) => setImmediate(res));
  assert.equal(reads.length, k + 1, 'a changed stamp: exactly one read');
  // A failing user is read again at the next request start whatever the stamp says.
  fail = true; st = 's3';
  r.touch(USER); await new Promise((res) => setTimeout(res, 5));
  const f = reads.length;
  fail = false;
  r.touch(USER); await new Promise((res) => setTimeout(res, 5));
  assert.equal(reads.length, f + 1);
});

test('owner decision: only a history save queues a brain build; imports, appends, older entries and rescans mirror only', async () => {
  const h = await harness();
  try {
    await h.reader.poll(USER); // empty journal: cursor set
    // An import of three chats.
    for (const c of ['qa-imp-1', 'qa-imp-2', 'qa-imp-3']) journalWrite(h.root, USER, c, 'r1', { origin: 'import' });
    await h.reader.poll(USER);
    assert.deepEqual(h.brain, []);
    assert.deepEqual(h.mirror.sort(), ['qa-imp-1', 'qa-imp-2', 'qa-imp-3'].map((c) => `${USER}:${c}`));
    // An interrupted-turn append, and a write from a store that sends no origin.
    journalWrite(h.root, USER, 'qa-turn', 'r1', { op: 'append', origin: 'history' });
    journalWrite(h.root, USER, 'qa-old', 'r1', { origin: null });
    await h.reader.poll(USER);
    assert.deepEqual(h.brain, []);
    assert.equal(h.mirror.length, 5);
    // A history POST save: exactly one brain build.
    journalWrite(h.root, USER, 'qa-saved', 'r1');
    await h.reader.poll(USER);
    assert.deepEqual(h.brain, [`${USER}:qa-saved`]);
    // Restart (a fresh reader, then a store restart): the rescans mirror every chat, no brain.
    const brain = [], mirror = [];
    const fresh = createChangeJournalReader({ read: (u, a) => h.client.changesRead(u, a),
      onChange: scheduleMirrorAndBrain({ chatVaultMirror: { schedule: (u, c) => mirror.push(c) }, chatBrains: { schedule: (u, c) => brain.push(c) } }),
      log: () => {}, setTimer: () => null });
    await fresh.poll(USER);
    h.store.state.start = START_B;
    await fresh.poll(USER);
    assert.deepEqual(brain, []);
    assert.equal(mirror.length, 12);
  } finally { await h.done(); }
});
