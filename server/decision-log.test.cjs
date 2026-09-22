'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createDecisionLog, summarize } = require('./decision-log.cjs');

test('appends text-free lines, rotates at the bound, and never throws', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-dlog-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = createDecisionLog({ dir, maxBytes: 300, now: () => new Date('2026-09-22T08:00:00Z'), echo: null });
  for (let i = 0; i < 10; i++) log('route', { selected: 'smart', options: 3, margin: 0.3, ms: 500, fellBack: null });
  const current = fs.readFileSync(path.join(dir, 'system-one-decisions.jsonl'), 'utf8').trim().split('\n');
  assert.ok(fs.existsSync(path.join(dir, 'system-one-decisions.jsonl.1')), 'rotated');
  assert.ok(fs.statSync(path.join(dir, 'system-one-decisions.jsonl')).size <= 300);
  assert.deepEqual(JSON.parse(current[0]), { at: '2026-09-22T08:00:00.000Z', kind: 'route', selected: 'smart', options: 3, margin: 0.3, ms: 500, fellBack: null });
  assert.equal(fs.statSync(path.join(dir, 'system-one-decisions.jsonl')).mode & 0o777, 0o600);
  createDecisionLog({ dir: path.join(dir, 'missing', 'deeper'), echo: null })('route', {}); // unwritable: silently skipped
});

test('summary counts selections, fallbacks and margin buckets', () => {
  const s = summarize([
    JSON.stringify({ kind: 'route', selected: 'fast', margin: 0.02, fellBack: null }),
    JSON.stringify({ kind: 'route', selected: 'legacy', margin: null, fellBack: 'deadline' }),
    JSON.stringify({ kind: 'route', selected: 'code', margin: 0.5, fellBack: null }),
    JSON.stringify({ kind: 'supervise', action: 'verify', fellBack: null }), 'not json']);
  assert.deepEqual(s.route.selected, { fast: 1, legacy: 1, code: 1 });
  assert.deepEqual(s.route.fellBack, { deadline: 1 });
  assert.deepEqual(s.route.margin, { '<0.05': 1, '0.05-0.2': 0, '>=0.2': 1 });
  assert.deepEqual(s.supervise, { n: 1, action: { verify: 1 }, fellBack: {} });
});
