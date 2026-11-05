'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildFacts, createChatFactsPublisher, SNAPSHOT_FILE, SNAPSHOT_KIND, MAX_BYTES } = require('./toolbox-chat-facts.cjs');
const { buildInAppBoxes } = require('./toolbox-inapp-fixture.cjs');

const fn = (name, description = 'd') => ({ type: 'function', function: { name, description, parameters: { type: 'object' } } });
const base = (over = {}) => ({
  builtin: () => [{ id: 'core', label: 'Core', description: 'c', source: 'builtin', tools: [fn('get_current_time')], reads: ['get_current_time'] }, { id: 'gdrive', label: 'Drive', description: 'g', source: 'builtin', inApp: true, tools: [fn('drive_get')] }],
  defaultToolboxes: ['core'], connectorBoxes: new Set(['gdrive']), harnessEnabled: () => 1, hasRepositories: () => 0, prefill: { targetMs: 1250, stats: () => ({ m: { rate: 0.2 } }) }, ...over,
});

test('the facts are the built-in boxes, the harness facts, the connector boxes and the prefill - and no MCP state', () => {
  const f = buildFacts(base());
  assert.deepEqual(Object.keys(f).sort(), ['builtin', 'connectorBoxes', 'defaults', 'harnessEnabled', 'hasRepositories', 'prefill']);
  assert.deepEqual(f.builtin.map((b) => b.id), ['core', 'gdrive']);
  assert.equal('inApp' in f.builtin[0], false, 'absent stays absent');
  assert.equal(f.builtin[1].inApp, true);
  assert.deepEqual(f.builtin[1].reads, []);
  assert.deepEqual([f.harnessEnabled, f.hasRepositories], [true, false]);
  assert.deepEqual(f.connectorBoxes, ['gdrive']);
  assert.deepEqual(f.prefill, { targetMs: 1250, models: { m: { rate: 0.2 } } });
});

test('every string is well formed (a lone surrogate would make the whole file unreadable for the front)', () => {
  const f = buildFacts(base({ prefill: { targetMs: 1, stats: () => ({ ['m\ud83d']: { note: 'x\udc00y' } }) } }));
  assert.deepEqual(f.prefill.models, { 'm�': { note: 'x�y' } });
  assert.doesNotThrow(() => Buffer.from(JSON.stringify(f), 'utf8'));
});

test('a document over the front\'s read limit is not published', () => {
  assert.throws(() => buildFacts(base({ builtin: () => [{ id: 'big', label: 'x', description: 'y'.repeat(MAX_BYTES), source: 'builtin', tools: [] }] })), /over cap/);
});

test('the real boxes of the fixture pass through whole', () => {
  const fixture = buildInAppBoxes();
  const f = buildFacts(base({ builtin: () => fixture.allToolboxes().filter((b) => b.source === 'builtin') }));
  assert.ok(f.builtin.length >= 2);
});

test('the publisher writes the versioned file the front reads, atomically and 0600, while someone asks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-'));
  try {
    fs.writeFileSync(path.join(dir, 'snapshot-demand'), '');
    const p = createChatFactsPublisher({ dataDir: dir, facts: () => buildFacts(base()), everyMs: 600000 });
    await p.publish();
    const file = path.join(dir, SNAPSHOT_FILE);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.version, 1);
    assert.equal(doc.kind, SNAPSHOT_KIND);
    assert.equal(doc.builtin[0].id, 'core');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
