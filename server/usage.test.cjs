'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { recordUsage, readUsage, usageDayKey, USAGE_RETENTION_DAYS } = require('./index.cjs');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, usagePath: () => path.join(dir, 'usage.json') };
}

test('usage accumulates into one bucket per day, split per model', (t) => {
  const ws = workspace(t);
  recordUsage(ws, 'model-a', { promptTokens: 100, completionTokens: 20 });
  recordUsage(ws, 'model-a', { promptTokens: 50, completionTokens: 10 });
  recordUsage(ws, 'model-b', { promptTokens: 7, completionTokens: 3 });

  const day = readUsage(ws).days[usageDayKey()];
  assert.equal(day.input, 157);
  assert.equal(day.output, 33);
  assert.equal(day.replies, 3);
  // Per-model split must sum back to the day total, or the "By model" panel
  // and the headline number disagree.
  const summed = Object.values(day.models).reduce((a, m) => a + m.input + m.output, 0);
  assert.equal(summed, day.input + day.output);
  assert.equal(day.models['model-a'].replies, 2);
  assert.equal(day.models['model-b'].input, 7);
});

test('a reply reporting no tokens is not counted as activity', (t) => {
  // A provider that sends no usage chunk must not create an empty bucket —
  // that would inflate active-day and streak counts with days that had none.
  const ws = workspace(t);
  recordUsage(ws, 'model-a', { promptTokens: 0, completionTokens: 0 });
  recordUsage(ws, 'model-a', null);
  assert.deepEqual(readUsage(ws).days, {});
});

test('buckets older than the retention window are dropped on write', (t) => {
  const ws = workspace(t);
  const old = usageDayKey(new Date(Date.now() - (USAGE_RETENTION_DAYS + 30) * 86400000));
  const recent = usageDayKey(new Date(Date.now() - 5 * 86400000));
  fs.writeFileSync(ws.usagePath(), JSON.stringify({ days: {
    [old]: { input: 1, output: 1, replies: 1, models: {} },
    [recent]: { input: 2, output: 2, replies: 1, models: {} },
  } }));

  recordUsage(ws, 'model-a', { promptTokens: 5, completionTokens: 5 });
  const days = readUsage(ws).days;
  assert.equal(days[old], undefined, 'stale bucket should be pruned');
  assert.ok(days[recent], 'in-window bucket should survive');
  assert.ok(days[usageDayKey()], "today's bucket should be written");
});

test('a corrupt or missing usage file reads as empty rather than throwing', (t) => {
  const ws = workspace(t);
  assert.deepEqual(readUsage(ws).days, {}, 'missing file');
  fs.writeFileSync(ws.usagePath(), 'not json');
  assert.deepEqual(readUsage(ws).days, {}, 'corrupt file');
  // And recording still works afterwards, replacing the bad file.
  recordUsage(ws, 'm', { promptTokens: 1, completionTokens: 1 });
  assert.equal(readUsage(ws).days[usageDayKey()].input, 1);
});
