'use strict';
// Chat port S3: the change journal reader learns who is active from the Rust front's activity file
// (chat-activity.cjs), so a user who only uses routes the front answers itself is still read, with
// the same cadence and stop conditions as one whose requests reach this process. A loopback stand-in
// for the store serves POST /v1/changes/read over a real chat-changes.jsonl, and the activity file is
// written as noevia-rs chat_activity.rs writes it. Synthetic, QA-named data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const psc = require('./project-store-client.cjs');
const { createChangeJournalReader, scheduleMirrorAndBrain, INTERVAL_MS, ACTIVE_MS } = require('./chat-change-journal.cjs');
const { ACTIVITY_FILE, CHAT_ACTIVITY_READER_MARKER, createActivitySource, readActivity } = require('./chat-activity.cjs');

const USER = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const TOKEN = 'synthetic-store-token-0123456789abcdef';
const START = '0123456789abcdef0123456789abcdef';

async function fakeStore(root) {
  const state = { calls: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers['x-noevia-store-token'] !== TOKEN || req.url !== '/v1/changes/read') return send(404, { error: 'not found' });
      const b = JSON.parse(raw);
      state.calls.push(b.user);
      const file = path.join(root, 'users', b.user, 'chat-changes.jsonl');
      const all = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const newer = all.filter((e) => e.seq > (b.after || 0));
      send(200, { entries: newer, oldestSeq: all[0]?.seq ?? null, latestSeq: all.at(-1)?.seq ?? null, more: false, start: START });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { state, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

function journalWrite(root, user, chatId, revision) {
  const dir = path.join(root, 'users', user);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'chat-changes.jsonl');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const seq = lines.length ? JSON.parse(lines.at(-1)).seq + 1 : 1;
  fs.appendFileSync(file, `${JSON.stringify({ seq, chatId, revision, op: 'write', origin: 'history', start: START, at: 1 })}\n`);
}

/** The front's write: the whole map, renamed into place (chat_activity.rs). */
function frontWrite(root, seen) {
  const file = path.join(root, ACTIVITY_FILE);
  fs.writeFileSync(`${file}.1.tmp`, JSON.stringify({ version: 1, seen }));
  fs.renameSync(`${file}.1.tmp`, file);
}

test('a user who only talks to the front is read from its activity file alone: mirror and brain follow', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-chat-activity-'));
  const store = await fakeStore(root);
  try {
    const client = psc.createClient({ port: store.port, token: TOKEN, timeoutMs: 2000 });
    const mirror = [], brain = [];
    let t = 5_000_000;
    let timerMs = null;
    const reader = createChangeJournalReader({
      read: (u, a) => client.changesRead(u, a),
      onChange: scheduleMirrorAndBrain({ chatVaultMirror: { schedule: (u, c) => mirror.push(`${u}:${c}`) }, chatBrains: { schedule: (u, c) => brain.push(`${u}:${c}`) } }),
      activity: createActivitySource({ dataDir: root, log: () => {} }),
      now: () => t, setTimer: (fn, ms) => { timerMs = ms; return { unref() {} }; }, clearTimer: () => {}, log: () => {},
    });
    reader.start();
    assert.equal(timerMs, INTERVAL_MS, 'the same 2 s cadence');
    await reader.tick();
    assert.deepEqual(store.state.calls, [], 'no file, nobody active');
    // No touch here at all: this process never saw the user. The front saw a request of theirs.
    frontWrite(root, { [USER]: t - 1000 });
    await reader.tick();
    assert.deepEqual(store.state.calls, [USER], 'the activity alone reads the journal');
    // Their history save (on the front) is journalled; the next tick schedules the mirror and the brain.
    journalWrite(root, USER, 'qa-front-only', 'r1');
    t += INTERVAL_MS;
    await reader.tick();
    assert.deepEqual(mirror, [`${USER}:qa-front-only`]);
    assert.deepEqual(brain, [`${USER}:qa-front-only`]);
    assert.equal(store.state.calls.includes(OTHER), false, 'only the users the front saw');
    reader.stop();
  } finally { await store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the file and request starts give the same users at every tick, and the same 15-minute stop', async () => {
  // One reader is told of each request by touch (today: the request reached Node), the other only by
  // the front's file (the latest time per user, as chat_activity.rs leaves it). With the journal stamp
  // unknown, every tick reads every active user, so the reads per tick are the active set.
  const run = async (mode) => {
    let t = 10_000_000;
    let ticking = false;
    const perTick = [];
    let doc = {};
    const r = createChangeJournalReader({
      read: async (u) => { if (ticking) perTick.at(-1).push(u); return { entries: [], oldestSeq: null, latestSeq: null, more: false, start: START }; },
      onChange: () => {}, log: () => {}, now: () => t, stamp: () => null, setTimer: () => null,
      activity: mode === 'file' ? () => doc : () => null,
    });
    const requests = [[0, USER], [1000, OTHER], [60_000, USER], [ACTIVE_MS - 1, OTHER], [ACTIVE_MS + 30_000, USER]];
    const until = ACTIVE_MS * 2 + 60_000;
    const start = t;
    for (let at = 0; at <= until; at += INTERVAL_MS) {
      for (const [when, user] of requests) {
        if (when > at - INTERVAL_MS && when <= at) {
          if (mode === 'touch') { const saved = t; t = start + when; r.touch(user); t = saved; await r.poll(user); }
          else doc = { ...doc, [user]: start + when };
        }
      }
      t = start + at;
      ticking = true; perTick.push([]);
      await r.tick();
      ticking = false;
      perTick[perTick.length - 1].sort();
    }
    return perTick;
  };
  const viaTouch = await run('touch');
  const viaFile = await run('file');
  assert.deepEqual(viaFile, viaTouch);
  // And it does stop: at the end nobody is active.
  assert.deepEqual(viaFile.at(-1), []);
  assert.ok(viaFile.some((users) => users.length === 2));
});

test('a removed account is not revived by the entry it was removed under; a later request is', async () => {
  let t = 1_000_000;
  let gone = true;
  const reads = [];
  let doc = { [USER]: t };
  const r = createChangeJournalReader({
    read: async (u) => { reads.push(u); if (gone) throw Object.assign(new Error('account no longer exists'), { status: 410 }); return { entries: [], oldestSeq: null, latestSeq: null, more: false, start: START }; },
    onChange: () => {}, log: () => {}, now: () => t, setTimer: () => null, activity: () => doc,
  });
  await r.tick();
  assert.equal(reads.length, 1);
  assert.equal(r.tracked(USER), false);
  t += 2000; await r.tick(); t += 2000; await r.tick();
  assert.equal(reads.length, 1, 'the same activity time does not bring them back');
  gone = false;
  doc = { [USER]: t };
  t += 2000; await r.tick();
  assert.equal(reads.length, 2);
  assert.equal(r.tracked(USER), true);
});

test('the activity file: missing is nobody, malformed is unreadable (logged once), and a bad entry is skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-chat-activity-file-'));
  try {
    const file = path.join(root, ACTIVITY_FILE);
    assert.deepEqual({ ...readActivity(file) }, {});
    fs.writeFileSync(file, JSON.stringify({ version: 1, seen: { [USER]: 5, [OTHER]: 'x', '': 3 } }));
    assert.deepEqual({ ...readActivity(file) }, { [USER]: 5 });
    fs.writeFileSync(file, JSON.stringify({ version: 2, seen: { [USER]: 5 } }));
    assert.deepEqual({ ...readActivity(file) }, {}, 'an unknown version is nobody');
    const logs = [];
    const source = createActivitySource({ dataDir: root, log: (m) => logs.push(m) });
    fs.writeFileSync(file, '{not json');
    assert.equal(source(), null);
    assert.equal(source(), null);
    assert.equal(logs.length, 1);
    frontWrite(root, { [USER]: 7 });
    assert.deepEqual({ ...source() }, { [USER]: 7 });
    // A source that throws never reaches a request or the timer.
    const r = createChangeJournalReader({ read: async () => ({ entries: [], start: START }), onChange: () => {}, log: () => {}, setTimer: () => null, activity: () => { throw new Error('boom'); } });
    return assert.doesNotReject(r.tick());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('index.cjs wires the front\'s activity into the reader and keeps its own touch; the marker is in code', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.match(index, /activity: require\('\.\/chat-activity\.cjs'\)\.createActivitySource\(\{ dataDir: DATA_DIR \}\)/);
  assert.match(index, /changeJournal\.touch\(authn\.user\.id\)/);
  assert.equal(CHAT_ACTIVITY_READER_MARKER, 'noevia-chat-activity-reader/1');
  assert.ok(fs.readFileSync(path.join(__dirname, 'chat-activity.cjs'), 'utf8').includes(`const CHAT_ACTIVITY_READER_MARKER = '${CHAT_ACTIVITY_READER_MARKER}';`));
});
