'use strict';
// #1507: the partial reply is saved every few seconds, bounded, overwritten in place, cleared when the
// reply ends, and offered to the client only while no reply runs. Synthetic events and temp folders only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createTurnRecord } = require('./chat-interrupted-turn.cjs');
const partial = require('./chat-partial.cjs');

const temps = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-partial-1507-')); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the partial keeps thinking written before any answer, and marks the turn interrupted', () => {
  const record = createTurnRecord();
  record.observe({ type: 'reasoning', text: 'Counting the words.' });
  const thinking = record.partialEntry();
  assert.deepEqual({ role: thinking.role, content: thinking.content, reasoning: thinking.reasoning, interrupted: thinking.interrupted },
    { role: 'assistant', content: '', reasoning: 'Counting the words.', interrupted: true });

  const answered = createTurnRecord();
  answered.observe({ type: 'meta', route: 'fast', routing: { route: 'local', reason: 'x' } });
  answered.observe({ type: 'delta', text: 'Four words.' });
  const text = answered.partialEntry();
  assert.equal(text.content, 'Four words.');
  assert.equal(text.model, 'Assistant · Auto (fast)');
  assert.equal(text.interrupted, true);
});

test('a reply with nothing to keep, or one that failed, has no partial', () => {
  assert.equal(createTurnRecord().partialEntry(), null, 'nothing was written');
  const failed = createTurnRecord();
  failed.observe({ type: 'reasoning', text: 'thinking' });
  failed.observe({ type: 'error', text: 'boom' });
  assert.equal(failed.partialEntry(), null, 'a failed reply is not kept');
});

test('tool steps the reply had taken are part of its partial', () => {
  const record = createTurnRecord();
  record.observe({ type: 'tool', index: 0, name: 'search', args: '{"q":"x"}' });
  record.observe({ type: 'tool_result', index: 0, name: 'search', text: 'ok' });
  const entry = record.partialEntry();
  assert.equal(entry.toolCalls.length, 1);
  assert.equal(entry.toolCalls[0].status, 'done');
});

test('saves repeat in place while the reply runs, and finish() clears the file', async () => {
  const dir = temp();
  const record = createTurnRecord();
  const saves = partial.startPartialSaves({ dir, chatId: 'c-1', record, everyMs: 5 });
  record.observe({ type: 'delta', text: 'first ' });
  await wait(30);
  assert.equal(partial.readPartial(dir, 'c-1').content, 'first ');
  record.observe({ type: 'delta', text: 'second' });
  await wait(30);
  assert.equal(partial.readPartial(dir, 'c-1').content, 'first second', 'the same file is overwritten with the newer text');
  assert.equal(fs.readdirSync(path.join(dir, 'chat-partials')).filter((f) => f.endsWith('.json')).length, 1, 'one file per chat, not one per save');
  assert.equal(partial.partialFor(dir, 'c-1'), null, 'not offered while the reply still runs');
  saves.finish();
  assert.equal(partial.readPartial(dir, 'c-1'), null, 'cleared when the reply ends');
  saves.finish();
});

test('a saved partial is not offered while its reply runs, and is offered once it has ended', async () => {
  const dir = temp();
  const record = createTurnRecord();
  record.observe({ type: 'delta', text: 'kept' });
  const saves = partial.startPartialSaves({ dir, chatId: 'c-2', record, everyMs: 1000 });
  // Written by an earlier process (a restart), not by this running reply.
  fs.mkdirSync(path.join(dir, 'chat-partials'), { recursive: true });
  fs.writeFileSync(partial.fileFor(dir, 'c-2'), JSON.stringify({ role: 'assistant', content: 'from before', interrupted: true }));
  assert.equal(partial.partialFor(dir, 'c-2'), null, 'a running reply hides the stored partial');
  saves.finish();
  assert.equal(partial.partialFor(dir, 'c-2'), null, 'finish clears the stored partial too');
  fs.writeFileSync(partial.fileFor(dir, 'c-2'), JSON.stringify({ role: 'assistant', content: 'after restart', interrupted: true }));
  assert.equal(partial.partialFor(dir, 'c-2').content, 'after restart', 'a restart leaves no active reply, so the partial is offered');
});

test('the saved text is bounded to the newest characters and says so', async () => {
  const dir = temp();
  const record = createTurnRecord();
  record.observe({ type: 'delta', text: 'a'.repeat(partial.PARTIAL_CAP_CHARS) + 'END' });
  const saves = partial.startPartialSaves({ dir, chatId: 'c-3', record, everyMs: 5 });
  await wait(30);
  const stored = partial.readPartial(dir, 'c-3');
  saves.finish();
  assert.equal(stored.content.length, partial.PARTIAL_CAP_CHARS, 'the file keeps at most the cap');
  assert.ok(stored.content.endsWith('END'), 'the newest characters are the ones kept');
  assert.equal(stored.truncated, true);
});

test('a partial belongs to the workspace it was written in', async () => {
  const mine = temp(), theirs = temp();
  const record = createTurnRecord();
  record.observe({ type: 'delta', text: 'private text' });
  const saves = partial.startPartialSaves({ dir: mine, chatId: 'shared-id', record, everyMs: 5 });
  await wait(25);
  saves.finish();
  fs.mkdirSync(path.join(mine, 'chat-partials'), { recursive: true });
  fs.writeFileSync(partial.fileFor(mine, 'shared-id'), JSON.stringify({ role: 'assistant', content: 'private text', interrupted: true }));
  assert.equal(partial.readPartial(theirs, 'shared-id'), null, 'the same chat id in another workspace sees nothing');
  assert.notEqual(partial.fileFor(mine, 'shared-id'), partial.fileFor(theirs, 'shared-id'));
});

test('a transcript save supersedes a stored partial, except while a reply runs', () => {
  const dir = temp();
  fs.mkdirSync(path.join(dir, 'chat-partials'), { recursive: true });
  fs.writeFileSync(partial.fileFor(dir, 'c-6'), JSON.stringify({ role: 'assistant', content: 'old', interrupted: true }));
  const record = createTurnRecord();
  const running = partial.startPartialSaves({ dir, chatId: 'c-7', record, everyMs: 1000 });
  fs.writeFileSync(partial.fileFor(dir, 'c-7'), JSON.stringify({ role: 'assistant', content: 'live', interrupted: true }));
  partial.supersedePartial(dir, 'c-7');
  assert.equal(partial.readPartial(dir, 'c-7').content, 'live', 'a save during a running reply keeps the live partial');
  running.finish();
  partial.supersedePartial(dir, 'c-6');
  assert.equal(partial.readPartial(dir, 'c-6'), null, 'a saved transcript supersedes the old partial');
});
