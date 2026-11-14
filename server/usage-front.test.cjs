'use strict';
// Track R12: with useFront (index.cjs, NOEVIA_RUST_USAGE_WRITES=1) every record goes to the Rust front and this
// process writes no usage file; without it, records are written here as before. Synthetic QA data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const usage = require('./usage.cjs');

function workspace(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-qa-usage-front-'));
  return { userId: 'aaaaaaaa-9999-4aaa-8aaa-aaaaaaaaaaaa', usagePath: () => path.join(dir, 'usage.json'), revoked: false, assertActive() {}, ...extra, dir };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('with the front, records go to it and no file is written here', async (t) => {
  const sent = [];
  usage.useFront(async (user, record) => { sent.push([user, record]); return 'written'; });
  t.after(() => usage.useFront(null));
  const ws = workspace();
  usage.recordUsage(ws, 'qa-model', { promptTokens: 3, completionTokens: 4 });
  usage.recordToolUse(ws, 'qa_tool');
  // Node's own early returns still apply.
  usage.recordUsage(ws, 'qa-model', null);
  usage.recordToolUse(ws, '');
  await settle();
  assert.deepEqual(sent, [
    [ws.userId, { kind: 'reply', model: 'qa-model', usage: { promptTokens: 3, completionTokens: 4 } }],
    [ws.userId, { kind: 'tool', name: 'qa_tool' }],
  ]);
  assert.equal(fs.existsSync(ws.usagePath()), false);
});

test('a removed account sends nothing, and a front that fails only warns', async (t) => {
  const sent = [];
  usage.useFront(async (user, record) => { sent.push(record); throw new Error('qa store down'); });
  t.after(() => usage.useFront(null));
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  t.after(() => { console.warn = warn; });
  usage.recordUsage(workspace({ revoked: true }), 'qa-model', { promptTokens: 1 });
  usage.recordUsage(workspace(), 'qa-model', { promptTokens: 1 });
  await settle(); await settle();
  assert.equal(sent.length, 1);
  assert.match(warned.join('\n'), /could not record: qa store down/);
});

test('without the front, this process writes the file as before', () => {
  usage.useFront(null);
  const ws = workspace();
  usage.recordUsage(ws, 'qa-model', { promptTokens: 2, completionTokens: 1 });
  const stored = JSON.parse(fs.readFileSync(ws.usagePath(), 'utf8'));
  const [day] = Object.values(stored.days);
  assert.equal(day.input, 2);
  assert.equal(day.models['qa-model'].replies, 1);
});
