'use strict';
// #741: the chat → Diary vault mirror. A stub Diary files client (same shape as the DAV client:
// read, write, mkdir, ops) keeps notes in memory with versions and a Trash, so every write, move
// and trash is observable. Synthetic chats only.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createChatVaultMirror, renderNote, safeName, folderFor, insideMirror, mirrorTrigger, readPreferences, writePreferences, readIndex, writeIndex } = require('./chat-vault-mirror.cjs');
const { createChatVaultMirrorRoutes } = require('./routes/chat-vault-mirror.cjs');

const version = (text) => crypto.createHash('sha256').update(text ?? '').digest('hex');
function stubVault() {
  const files = new Map(), dirs = new Set(), trash = [], calls = [];
  const fail = (status, message) => Object.assign(Error(message), { status });
  return {
    files, dirs, trash, calls,
    writes: () => calls.filter((c) => c.op === 'write' || c.op === 'move' || c.op === 'delete' || c.op === 'mkdir' || c.op === 'preserve'),
    client: {
      async read(userId, path) { calls.push({ op: 'read', userId, path }); const content = files.has(path) ? files.get(path) : null; return { path, content, version: version(content) }; },
      async write(userId, { path, content, version: base }) {
        calls.push({ op: 'write', userId, path });
        if (base !== version(files.get(path) ?? null)) throw fail(409, 'File changed elsewhere');
        files.set(path, content); return { path, content, version: version(content) };
      },
      async mkdir(userId, path) { calls.push({ op: 'mkdir', userId, path }); if (dirs.has(path)) throw fail(405, 'exists'); dirs.add(path); return { path, isDir: true }; },
      async ops(userId, body) {
        calls.push({ op: body.op, userId, ...body });
        const { op, path } = body;
        if (op === 'stat') { if (!files.has(path)) throw fail(404, 'missing'); return { version: version(files.get(path)), isDir: false }; }
        if (op === 'preserve') { trash.push({ path, content: files.get(path), reason: 'preserve' }); return { trash: [path] }; }
        if (op === 'delete') {
          if (!files.has(path)) throw fail(404, 'missing');
          if (body.version !== version(files.get(path))) throw fail(412, 'changed');
          trash.push({ path, content: files.get(path), reason: 'delete' }); files.delete(path); return { trash: [path] };
        }
        if (op === 'move') {
          if (!files.has(path)) throw fail(404, 'missing');
          if (files.has(body.destination) && !body.overwrite) throw fail(412, 'exists');
          files.set(body.destination, files.get(path)); files.delete(path); return { replaced: false };
        }
        throw fail(400, 'unknown op');
      },
    },
  };
}

function setup({ enabled = true, freeChats = [], projects = [], histories = {}, vault = stubVault() } = {}) {
  const state = { freeChats, projects, histories, enabled, index: {}, deleted: new Set() };
  const timers = [];
  const mirror = createChatVaultMirror({
    enabled: () => state.enabled,
    lists: (userId) => { assert.equal(userId, 'u1', 'lists are read for the scheduled user only'); return { freeChats: state.freeChats, projects: state.projects }; },
    deleted: (userId) => { assert.equal(userId, 'u1', 'tombstones are read for the scheduled user only'); return state.deleted; },
    readHistory: (_userId, id) => state.histories[id] || [],
    files: vault.client,
    index: { read: () => state.index, write: (_u, value) => { state.index = JSON.parse(JSON.stringify(value)); } },
    setTimer: (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.done = true; },
    now: () => 1000,
  });
  const flush = async () => { while (timers.some((t) => !t.done)) { const t = timers.find((x) => !x.done); t.done = true; await t.fn(); } };
  return { state, mirror, vault, timers, flush };
}
const chat = (id, title, extra = {}) => ({ id, title, createdAt: Date.UTC(2026, 9, 1, 9), updatedAt: Date.UTC(2026, 9, 2, 10), ...extra });

test('safe names: separators, traversal, reserved and hidden names never leave the folder', () => {
  assert.equal(safeName('../../etc/passwd', 'x'), 'etc passwd');
  assert.equal(safeName('..', 'Untitled chat'), 'Untitled chat');
  assert.equal(safeName('.hidden', 'x'), 'hidden');
  assert.equal(safeName('a\\b/c:d*e?f"g<h>i|j#k^l[m]n%o', 'x'), 'a b c d e f g h i j k l m n o');
  assert.equal(safeName('tab\there\nnew\u0000line', 'x'), 'tab here new line');
  assert.equal(safeName('CON', 'x'), 'CON chat');
  assert.equal(safeName('   ', 'Untitled chat'), 'Untitled chat');
  assert.equal(safeName('x'.repeat(300), 'y').length, 100);
  assert.equal(folderFor(null), 'Chats/Inbox');
  assert.equal(folderFor('../Secrets'), 'Chats/Secrets');
  assert.equal(folderFor('inbox'), 'Chats/inbox (project)', 'a project named Inbox does not share the free chats folder');
  for (const bad of ['Chats/../x.md', '../Chats/a/b.md', 'Chats/a/b/c.md', 'Chats/.a/b.md', 'Other/a/b.md', 'Chats/a/b.txt', 'Chats/a/..', null])
    assert.equal(insideMirror(bad), false, String(bad));
  assert.equal(insideMirror('Chats/Inbox/Trip.md'), true);
});

test('a hostile title and project name still land inside Chats/', async () => {
  const { mirror, vault } = setup({ freeChats: [chat('c1', '../../../AI Memory/evil')], projects: [{ id: 'p', name: '../..', chats: [chat('c2', '/etc/x')] }] });
  await mirror.sync('u1', new Set());
  assert.deepEqual([...vault.files.keys()].sort(), ['Chats/Inbox/AI Memory evil.md', 'Chats/Project/etc x.md']);
  assert.ok(vault.calls.filter((c) => c.path).every((c) => c.path === 'Chats' || c.path.startsWith('Chats/')));
});

test('frontmatter: id, dates, project, kind, tags and brain_schema 0; links as [[Title]]; no reasoning', () => {
  const note = renderNote({
    chat: chat('c1', 'Trip "plan"', { frame: { projectId: 'p', kind: 'search', tags: ['travel/eu', 'b"q'], links: ['c2'], confirmed: true, source: 'user' } }),
    projectName: 'Synthetic trip',
    history: [{ role: 'user', content: 'Where?' }, { role: 'assistant', content: 'Lisbon.', reasoning: 'SECRET SCRATCH' }],
    linkNames: ['Visa notes'],
  });
  const [, fm, body] = note.split(/^---$/m);
  assert.equal(fm.trim(), [
    'noevia_id: "c1"', 'created: 2026-10-01T09:00:00.000Z', 'updated: 2026-10-02T10:00:00.000Z',
    'project: "Synthetic trip"', 'kind: "search"', 'tags: ["travel/eu", "b\\"q"]', 'brain_schema: 0'].join('\n'));
  assert.match(body, /^# Trip "plan"$/m);
  assert.match(body, /## Assistant\n\nLisbon\./);
  assert.match(body, /## Links\n\n- \[\[Visa notes\]\]\n$/);
  assert.doesNotMatch(note, /SECRET SCRATCH/, 'reasoning is never written, as in export');
  const plain = renderNote({ chat: { id: 'c9', title: 'x' }, projectName: null, history: [] });
  assert.match(plain, /project: null\nkind: null\ntags: \[\]\nbrain_schema: 0/);
  assert.match(plain, /created: null\nupdated: null/);
});

test('a very long chat is cut to the note limit, keeping the frontmatter', () => {
  const note = renderNote({ chat: chat('c1', 'Long'), projectName: null, history: [{ role: 'user', content: 'é'.repeat(400000) }] });
  assert.ok(Buffer.byteLength(note) <= 500 * 1024);
  assert.match(note, /^---\nnoevia_id: "c1"/);
  assert.match(note, /the rest is in noevia/);
});

test('first sync writes every chat; links resolve to the other note names; a second sync writes nothing', async () => {
  const { mirror, vault, state } = setup({
    freeChats: [chat('a', 'Packing list'), chat('b', 'Trip', { frame: { kind: 'idea', tags: ['t'], links: ['a', 'gone', 'b'], confirmed: true, source: 'user' } })],
    projects: [{ id: 'p', name: 'Synthetic trip', chats: [chat('c', 'Trip')] }],
    histories: { a: [{ role: 'user', content: 'socks' }] },
  });
  assert.equal(await mirror.sync('u1', new Set()), true);
  assert.deepEqual([...vault.files.keys()].sort(), ['Chats/Inbox/Packing list.md', 'Chats/Inbox/Trip.md', 'Chats/Synthetic trip/Trip.md']);
  assert.match(vault.files.get('Chats/Inbox/Trip.md'), /## Links\n\n- \[\[Packing list\]\]\n$/, 'a missing target and a self link are left out');
  assert.deepEqual(Object.keys(state.index.notes).sort(), ['a', 'b', 'c']);
  const changes = () => vault.writes().filter((c) => c.op !== 'mkdir').length;
  const before = vault.writes().length, unchanged = changes();
  assert.equal(await mirror.sync('u1', new Set()), true);
  assert.equal(changes(), unchanged, 'unchanged chats are not rewritten');
  // A new reply (the history route marks the chat dirty) rewrites only that note.
  state.histories.a = [{ role: 'user', content: 'socks' }, { role: 'assistant', content: 'and a hat' }];
  await mirror.sync('u1', new Set(['a']));
  assert.deepEqual(vault.writes().slice(before).filter((c) => c.op !== 'mkdir').map((c) => [c.op, c.path]), [['write', 'Chats/Inbox/Packing list.md']]);
  assert.match(vault.files.get('Chats/Inbox/Packing list.md'), /and a hat/);
});

test('same title in one folder: stable " (2)" names keyed by noevia_id', async () => {
  const { mirror, vault, state } = setup({ freeChats: [chat('x', 'Notes', { createdAt: 1 }), chat('y', 'Notes', { createdAt: 2 })] });
  await mirror.sync('u1', new Set());
  assert.equal(state.index.notes.x.path, 'Chats/Inbox/Notes.md');
  assert.equal(state.index.notes.y.path, 'Chats/Inbox/Notes (2).md');
  assert.match(vault.files.get('Chats/Inbox/Notes (2).md'), /noevia_id: "y"/);
  await mirror.sync('u1', new Set());
  assert.equal(state.index.notes.y.path, 'Chats/Inbox/Notes (2).md');
});

test('rename and project move: the note moves, no duplicate is left', async () => {
  const { mirror, vault, state } = setup({ freeChats: [chat('a', 'Old title')], projects: [{ id: 'p', name: 'Work', chats: [] }] });
  await mirror.sync('u1', new Set());
  state.freeChats = [chat('a', 'New title', { updatedAt: Date.UTC(2026, 9, 3) })];
  await mirror.sync('u1', new Set());
  assert.deepEqual([...vault.files.keys()], ['Chats/Inbox/New title.md']);
  assert.ok(vault.calls.some((c) => c.op === 'move' && c.path === 'Chats/Inbox/Old title.md' && c.destination === 'Chats/Inbox/New title.md' && c.overwrite === false));
  assert.match(vault.files.get('Chats/Inbox/New title.md'), /^# New title$/m);
  // Into a project: the note follows to that project's folder.
  state.projects[0].chats = [state.freeChats[0]]; state.freeChats = [];
  await mirror.sync('u1', new Set());
  assert.deepEqual([...vault.files.keys()], ['Chats/Work/New title.md']);
  assert.match(vault.files.get('Chats/Work/New title.md'), /project: "Work"/);
  assert.equal(state.index.notes.a.path, 'Chats/Work/New title.md');
  assert.equal(vault.trash.length, 0, 'a move never trashes anything');
});

test('delete: the note goes to the Diary Trash, never a hard delete', async () => {
  const { mirror, vault, state } = setup({ freeChats: [chat('a', 'Keep'), chat('b', 'Bin me')] });
  await mirror.sync('u1', new Set());
  state.freeChats = [chat('a', 'Keep')];
  state.deleted = new Set(['b', 'z']);
  await mirror.sync('u1', new Set());
  assert.deepEqual([...vault.files.keys()], ['Chats/Inbox/Keep.md']);
  assert.deepEqual(vault.trash.map((t) => [t.path, t.reason]), [['Chats/Inbox/Bin me.md', 'delete']]);
  const del = vault.calls.find((c) => c.op === 'delete');
  assert.ok(del.version, 'the delete names the version it read, so a concurrent edit is not lost');
  assert.equal(state.index.notes.b, undefined);
  // Already gone from the vault: just forgotten.
  state.index.notes.z = { path: 'Chats/Inbox/Gone.md', version: 'v' };
  assert.equal(await mirror.sync('u1', new Set()), true);
  assert.equal(state.index.notes.z, undefined);
});

test('an empty chat list never trashes: the trash pass is skipped (sanity brake)', async () => {
  const { mirror, vault, state } = setup({ freeChats: [chat('a', 'A'), chat('b', 'B')] });
  await mirror.sync('u1', new Set());
  vault.calls.length = 0;
  state.freeChats = []; state.projects = [];
  state.deleted = new Set(['a', 'b']); // even tombstones do not override the brake
  assert.equal(await mirror.sync('u1', new Set()), true);
  assert.equal(vault.calls.length, 0, 'no ops at all on an empty list');
  assert.deepEqual(Object.keys(state.index.notes).sort(), ['a', 'b']);
});

test('absent from the lists but not tombstoned: the note and its index entry stay', async () => {
  const { mirror, vault, state } = setup({ freeChats: [chat('a', 'Keep'), chat('b', 'Missing')] });
  await mirror.sync('u1', new Set());
  vault.calls.length = 0;
  state.freeChats = [chat('a', 'Keep')];
  assert.equal(await mirror.sync('u1', new Set()), true);
  assert.equal(vault.trash.length, 0);
  assert.equal(vault.calls.filter((c) => c.op === 'delete' || c.op === 'stat').length, 0);
  assert.ok(vault.files.has('Chats/Inbox/Missing.md'));
  assert.equal(state.index.notes.b.path, 'Chats/Inbox/Missing.md');
  // Once it is tombstoned, it goes to Trash.
  state.deleted = new Set(['b']);
  await mirror.sync('u1', new Set());
  assert.deepEqual(vault.trash.map((t) => [t.path, t.reason]), [['Chats/Inbox/Missing.md', 'delete']]);
  assert.equal(state.index.notes.b, undefined);
});

test('never overwrites a note noevia did not write; a vault edit is kept in Trash before an update', async () => {
  const vault = stubVault();
  vault.files.set('Chats/Inbox/Mine.md', 'my own note');
  const { mirror, state } = setup({ vault, freeChats: [chat('a', 'Mine')] });
  assert.equal(await mirror.sync('u1', new Set()), false, 'the clash is reported for a retry');
  assert.equal(vault.files.get('Chats/Inbox/Mine.md'), 'my own note');
  assert.equal(await mirror.sync('u1', new Set()), true);
  assert.equal(state.index.notes.a.path, 'Chats/Inbox/Mine (2).md');
  assert.equal(vault.files.get('Chats/Inbox/Mine.md'), 'my own note', 'still untouched');
  // Someone edits the mirrored note in Obsidian; the next update keeps that edit in Trash first.
  vault.files.set('Chats/Inbox/Mine (2).md', 'edited in the vault');
  state.freeChats = [chat('a', 'Mine', { updatedAt: Date.UTC(2026, 9, 5) })];
  await mirror.sync('u1', new Set());
  assert.deepEqual(vault.trash.map((t) => [t.path, t.content, t.reason]), [['Chats/Inbox/Mine (2).md', 'edited in the vault', 'preserve']]);
  assert.match(vault.files.get('Chats/Inbox/Mine (2).md'), /noevia_id: "a"/);
});

test('opt-in off: scheduling and running make zero Diary calls', async () => {
  const { mirror, vault, flush } = setup({ enabled: false, freeChats: [chat('a', 'A')] });
  mirror.schedule('u1', 'a');
  mirror.schedule('u1', null, { immediate: true });
  await flush();
  assert.deepEqual(vault.calls, []);
  assert.equal(mirror.pending('u1'), false);
});

test('debounce: a burst of saves is one sync, after the quiet period', async () => {
  const { mirror, vault, timers, flush } = setup({ freeChats: [chat('a', 'A')] });
  for (let i = 0; i < 5; i++) mirror.schedule('u1', 'a');
  assert.equal(timers.filter((t) => !t.done).length, 1, 'one pending timer per user');
  assert.equal(timers.at(-1).ms, 5000);
  assert.equal(vault.calls.length, 0, 'nothing is written while saves keep coming');
  await flush();
  assert.equal(vault.calls.filter((c) => c.op === 'write').length, 1);
});

test('debounce wait never exceeds maxWait from the first save of a burst', () => {
  let clock = 0; const seen = [];
  const m = createChatVaultMirror({ enabled: () => true, lists: () => ({}), readHistory: () => [], files: stubVault().client,
    index: { read: () => ({}), write: () => {} }, setTimer: (fn, ms) => { seen.push([clock, ms]); return {}; }, clearTimer: () => {}, now: () => clock, delayMs: 5000, maxWaitMs: 30000 });
  for (const t of [0, 4000, 8000, 27000, 29000]) { clock = t; m.schedule('u1'); }
  assert.deepEqual(seen, [[0, 5000], [4000, 5000], [8000, 5000], [27000, 3000], [29000, 1000]]);
});

test('a failed sync keeps the index and retries later with the same dirty chats', async () => {
  const vault = stubVault();
  let broken = true;
  const write = vault.client.write;
  vault.client.write = async (...args) => { if (broken) throw Object.assign(Error('storage down'), { status: 503 }); return write(...args); };
  const { mirror, state, timers, flush } = setup({ vault, freeChats: [chat('a', 'A')] });
  mirror.schedule('u1', 'a');
  await timers[0].fn(); timers[0].done = true;
  assert.equal(state.index.notes?.a, undefined, 'nothing recorded for a note that did not save');
  const retry = timers.find((t) => !t.done);
  assert.equal(retry.ms, 60000);
  broken = false;
  await flush();
  assert.equal(state.index.notes.a.path, 'Chats/Inbox/A.md');
});

test('mirrorTrigger: only writes to chats, transcripts, moves, projects and imports', () => {
  assert.deepEqual(mirrorTrigger('POST', '/api/chats/c%201/history'), { chatId: 'c 1' });
  assert.deepEqual(mirrorTrigger('POST', '/api/chats/c1/move'), { chatId: 'c1' });
  assert.deepEqual(mirrorTrigger('POST', '/api/freechats'), { chatId: null });
  assert.deepEqual(mirrorTrigger('DELETE', '/api/freechats/c1'), { chatId: null });
  assert.deepEqual(mirrorTrigger('POST', '/api/projects/p/chats'), { chatId: null });
  assert.equal(mirrorTrigger('GET', '/api/freechats'), null);
  assert.equal(mirrorTrigger('POST', '/api/chat'), null, 'a streaming reply is mirrored when its transcript is saved');
  assert.equal(mirrorTrigger('POST', '/api/diary/entries'), null);
});

test('preferences: off by default, strict boolean, per workspace directory; index round-trips', () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'mirror-'));
  try {
    assert.deepEqual(readPreferences(dir), { enabled: false });
    assert.throws(() => writePreferences(dir, { enabled: 'yes' }), /true or false/);
    assert.deepEqual(writePreferences(dir, { enabled: true, extra: 1 }), { enabled: true });
    assert.deepEqual(readPreferences(dir), { enabled: true });
    assert.deepEqual(readIndex(dir), {});
    writeIndex(dir, { notes: { a: { path: 'Chats/Inbox/A.md' } } });
    assert.equal(readIndex(dir).notes.a.path, 'Chats/Inbox/A.md');
  } finally { require('node:fs').rmSync(dir, { recursive: true, force: true }); }
});

test('route: signed-in only, own setting, turning on starts a sync at once', async () => {
  let prefs = { enabled: false }; const scheduled = [];
  const routes = createChatVaultMirrorRoutes({
    json: (res, status, body) => { res.status = status; res.body = body; },
    readJson: async (req) => req.body,
    preferences: { get: () => prefs, save: (v) => { if (typeof v?.enabled !== 'boolean') throw Object.assign(Error('enabled must be true or false'), { status: 400 }); prefs = { enabled: v.enabled }; return prefs; } },
    available: (userId) => userId === 'u1', schedule: (...args) => scheduled.push(args),
  });
  const call = async (method, body, authn = { user: { id: 'u1' } }, path = '/api/chat-vault-mirror/preferences') => { const res = {}; const handled = await routes({ method, body }, res, { path, authn }); return { handled, ...res }; };
  assert.equal((await call('GET', null, null)).status, 401);
  assert.equal((await call('GET', null, undefined, '/api/other')).handled, false);
  assert.deepEqual((await call('GET')).body, { enabled: false, available: true });
  assert.equal((await call('PUT', { enabled: 1 })).status, 400);
  assert.deepEqual((await call('PUT', { enabled: true })).body, { enabled: true, available: true });
  assert.deepEqual(scheduled, [['u1', null, { immediate: true }]]);
  assert.equal((await call('POST', {})).status, 405);
  await call('PUT', { enabled: true }, { user: { id: 'u2' } });
  assert.equal(scheduled.length, 1, 'no sync where the mirror is not available');
});
