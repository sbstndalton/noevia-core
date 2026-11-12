'use strict';
// #741: the chat → Diary vault mirror. A stub Diary files client (same shape as the DAV client:
// read, write, mkdir, ops) keeps notes in memory with versions and a Trash, so every write, move
// and trash is observable. Synthetic chats only.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createChatVaultMirror, renderNote, safeName, folderFor, insideMirror, mirrorTrigger, readPreferences, readIndex, writeIndex } = require('./chat-vault-mirror.cjs');

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
  const mirror = createChatVaultMirror({
    enabled: () => state.enabled,
    lists: (userId) => { assert.equal(userId, 'u1', 'lists are read for the scheduled user only'); return { freeChats: state.freeChats, projects: state.projects }; },
    deleted: (userId) => { assert.equal(userId, 'u1', 'tombstones are read for the scheduled user only'); return state.deleted; },
    readHistory: (_userId, id) => state.histories[id] || [],
    files: vault.client,
    index: { read: () => state.index, write: (_u, value) => { state.index = JSON.parse(JSON.stringify(value)); } },
  });
  return { state, mirror, vault };
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

test('opt-in off: a pass makes zero Diary calls and answers off', async () => {
  const { mirror, vault } = setup({ enabled: false, freeChats: [chat('a', 'A')] });
  assert.equal(await mirror.pass('u1', ['a']), 'off');
  assert.equal(await mirror.pass('u1', []), 'off');
  assert.deepEqual(vault.calls, []);
});

test('a pass answers done, writes the dirty chat, and the schedule is not this process\'s', async () => {
  const { mirror, vault, state } = setup({ freeChats: [chat('a', 'A')] });
  assert.equal(await mirror.pass('u1', ['a']), 'done');
  assert.equal(vault.calls.filter((c) => c.op === 'write').length, 1);
  assert.equal(state.index.notes.a.path, 'Chats/Inbox/A.md');
  assert.equal(mirror.schedule, undefined);
  assert.equal(mirror.pending, undefined);
});

test('a failed pass answers failed, keeps the index, and the same dirty chats succeed on the front\'s retry', async () => {
  const vault = stubVault();
  let broken = true;
  const write = vault.client.write;
  vault.client.write = async (...args) => { if (broken) throw Object.assign(Error('storage down'), { status: 503 }); return write(...args); };
  const { mirror, state } = setup({ vault, freeChats: [chat('a', 'A')] });
  assert.equal(await mirror.pass('u1', ['a']), 'failed');
  assert.equal(state.index.notes?.a, undefined, 'nothing recorded for a note that did not save');
  broken = false;
  assert.equal(await mirror.pass('u1', ['a']), 'done');
  assert.equal(state.index.notes.a.path, 'Chats/Inbox/A.md');
});

test('a thrown dependency is a failed pass, never a throw', async () => {
  const logs = [];
  const m = createChatVaultMirror({ enabled: () => true, lists: () => { throw new Error('lists unreadable'); }, readHistory: () => [], files: stubVault().client,
    index: { read: () => ({}), write: () => {} }, log: (...a) => logs.push(a.join(' ')) });
  assert.equal(await m.pass('u1', []), 'failed');
  assert.ok(logs.some((l) => l.includes('sync failed')));
});

test('passes for one account never overlap, even when the front retries one it gave up on', async () => {
  let running = 0, peak = 0;
  const vault = stubVault();
  const read = vault.client.read;
  vault.client.read = async (...args) => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 15)); try { return await read(...args); } finally { running--; } };
  const { mirror } = setup({ vault, freeChats: [chat('a', 'A'), chat('b', 'B')] });
  const results = await Promise.all([mirror.pass('u1', ['a']), mirror.pass('u1', ['b']), mirror.pass('u1', [])]);
  assert.deepEqual(results, ['done', 'done', 'done']);
  assert.equal(peak, 1);
});

test('#757 rename with the old note gone never overwrites a foreign note at the new name', async () => {
  const { mirror, vault, state } = setup({ freeChats: [chat('a', 'Old')] });
  await mirror.sync('u1', new Set());
  vault.files.delete('Chats/Inbox/Old.md');
  vault.files.set('Chats/Inbox/New.md', 'my own note');
  state.freeChats = [chat('a', 'New', { updatedAt: Date.UTC(2026, 9, 3) })];
  assert.equal(await mirror.sync('u1', new Set()), false, 'the clash is reported');
  assert.equal(vault.files.get('Chats/Inbox/New.md'), 'my own note');
  assert.equal(await mirror.sync('u1', new Set()), true);
  assert.equal(vault.files.get('Chats/Inbox/New.md'), 'my own note', 'the foreign note is untouched');
  assert.match(vault.files.get('Chats/Inbox/New (2).md'), /^# New$/m);
  assert.equal(state.index.notes.a.path, 'Chats/Inbox/New (2).md');
  assert.equal(vault.trash.length, 0);
});

test('#757 rename with the old note present still refuses a foreign note at the new name', async () => {
  const { mirror, vault, state } = setup({ freeChats: [chat('a', 'Old')] });
  await mirror.sync('u1', new Set());
  vault.files.set('Chats/Inbox/New.md', 'my own note');
  state.freeChats = [chat('a', 'New', { updatedAt: Date.UTC(2026, 9, 3) })];
  await mirror.sync('u1', new Set());
  await mirror.sync('u1', new Set());
  assert.equal(vault.files.get('Chats/Inbox/New.md'), 'my own note');
  assert.ok(vault.files.has('Chats/Inbox/New (2).md'));
  assert.ok(!vault.files.has('Chats/Inbox/Old.md'), 'the old note moved');
});

test('#764 rename onto a byte-identical note of ours: the old note goes to Trash, the new one is indexed', async () => {
  const { mirror, vault, state } = setup({ freeChats: [chat('a', 'Old')] });
  await mirror.sync('u1', new Set());
  vault.files.set('Chats/Inbox/New.md', vault.files.get('Chats/Inbox/Old.md'));
  state.freeChats = [chat('a', 'New')];
  assert.equal(await mirror.sync('u1', new Set()), true);
  assert.ok(!vault.files.has('Chats/Inbox/Old.md'), 'no orphan left behind');
  assert.deepEqual(vault.trash.map((t) => [t.path, t.reason]), [['Chats/Inbox/Old.md', 'delete']]);
  const del = vault.calls.find((c) => c.op === 'delete');
  assert.ok(del.version, 'the delete is guarded by the version it read');
  assert.equal(state.index.notes.a.path, 'Chats/Inbox/New.md');
  assert.ok(vault.files.has('Chats/Inbox/New.md'));
});

test('#764 an edited old note is not ours: it is skipped, left in place, and the index moves on', async () => {
  const { mirror, vault, state } = setup({ freeChats: [chat('a', 'Old')] });
  await mirror.sync('u1', new Set());
  vault.files.set('Chats/Inbox/New.md', vault.files.get('Chats/Inbox/Old.md'));
  vault.files.set('Chats/Inbox/Old.md', 'my edits to the old note');
  state.freeChats = [chat('a', 'New')];
  assert.equal(await mirror.sync('u1', new Set()), true);
  assert.equal(vault.files.get('Chats/Inbox/Old.md'), 'my edits to the old note');
  assert.deepEqual(vault.trash, []);
  assert.equal(state.index.notes.a.path, 'Chats/Inbox/New.md');
});

test('#764 a failed trash of the old note is logged and never fails the pass or loses a note', async () => {
  const vault = stubVault();
  const realOps = vault.client.ops;
  vault.client.ops = async (u, body) => { if (body.op === 'delete') throw Object.assign(Error('boom'), { status: 500 }); return realOps(u, body); };
  const { mirror, state } = setup({ freeChats: [chat('a', 'Old')], vault });
  await mirror.sync('u1', new Set());
  vault.files.set('Chats/Inbox/New.md', vault.files.get('Chats/Inbox/Old.md'));
  state.freeChats = [chat('a', 'New')];
  assert.equal(await mirror.sync('u1', new Set()), true);
  assert.ok(vault.files.has('Chats/Inbox/Old.md'), 'the old note stays when Trash fails');
  assert.equal(state.index.notes.a.path, 'Chats/Inbox/New.md');
});

test('#757 an entry with an unknown (null) version is preserved to Trash before it is overwritten', async () => {
  const { mirror, vault, state } = setup({ freeChats: [chat('a', 'A')] });
  await mirror.sync('u1', new Set());
  state.index.notes.a.version = null;
  vault.files.set('Chats/Inbox/A.md', 'maybe edited');
  state.freeChats = [chat('a', 'A', { updatedAt: Date.UTC(2026, 9, 3) })];
  assert.equal(await mirror.sync('u1', new Set()), true);
  assert.deepEqual(vault.trash.map((t) => [t.path, t.content, t.reason]), [['Chats/Inbox/A.md', 'maybe edited', 'preserve']]);
  assert.match(vault.files.get('Chats/Inbox/A.md'), /^# A$/m);
});

test('#758 a taken: entry is pruned once the foreign note is gone', async () => {
  const vault = stubVault();
  vault.files.set('Chats/Inbox/A.md', 'foreign');
  const { mirror, state } = setup({ vault, freeChats: [chat('a', 'A')] });
  await mirror.sync('u1', new Set());
  assert.deepEqual(state.index.notes['taken:Chats/Inbox/A.md'], { path: 'Chats/Inbox/A.md', foreign: true });
  await mirror.sync('u1', new Set());
  assert.ok(state.index.notes['taken:Chats/Inbox/A.md'], 'kept while the foreign note exists');
  vault.files.delete('Chats/Inbox/A.md');
  await mirror.sync('u1', new Set());
  assert.equal(state.index.notes['taken:Chats/Inbox/A.md'], undefined);
  assert.equal(state.index.notes.a.path, 'Chats/Inbox/A (2).md', 'the chat keeps its note name');
});

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

test('preferences: off by default, strict boolean, per workspace directory; index round-trips', () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'mirror-'));
  try {
    assert.deepEqual(readPreferences(dir), { enabled: false });
    // #2190: the Rust front writes the file (vault_mirror.rs); Node only reads it, strictly.
    const fs = require('node:fs'); const file = require('node:path').join(dir, 'chat-vault-mirror.json');
    for (const [text, on] of [['{"enabled":"yes"}', false], ['{"enabled":1}', false], ['not json', false], ['{"enabled":true}', true]]) {
      fs.writeFileSync(file, text); assert.deepEqual(readPreferences(dir), { enabled: on }, text);
    }
    assert.deepEqual(readIndex(dir), {});
    writeIndex(dir, { notes: { a: { path: 'Chats/Inbox/A.md' } } });
    assert.equal(readIndex(dir).notes.a.path, 'Chats/Inbox/A.md');
  } finally { require('node:fs').rmSync(dir, { recursive: true, force: true }); }
});

test('#2167 repeated remove-triggered mirror passes preserve survivors and trash once', async () => {
  const { mirror, vault, state } = setup({ freeChats: [chat('qa-keep', 'Keep'), chat('qa-gone', 'Gone')] });
  await mirror.sync('u1', new Set());
  state.freeChats = [chat('qa-keep', 'Keep')];
  state.deleted = new Set(['qa-gone']);
  await mirror.sync('u1', new Set(['qa-gone']));
  const writes = vault.writes().length;
  const survivor = vault.files.get('Chats/Inbox/Keep.md');
  await mirror.sync('u1', new Set(['qa-gone']));
  assert.equal(vault.trash.length, 1);
  assert.equal(vault.writes().length, writes);
  assert.equal(vault.files.get('Chats/Inbox/Keep.md'), survivor);
  assert.equal(state.index.notes['qa-gone'], undefined);
});
