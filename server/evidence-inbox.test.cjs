'use strict';
// #2210: how this process's evidence producers reach the front, the evidence store's one writer.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createInbox, inboxDirFor, MAX_BYTES } = require('./evidence-inbox.cjs');
const { createReader } = require('./evidence.cjs');
const { createLlamaCppManager } = require('./llamacpp-manager.cjs');

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('the inbox sits beside the evidence directory and entries are whole files in time order', (t) => {
  const root = tmp(t);
  assert.equal(inboxDirFor(path.join(root, 'evidence-0123456789abcdef')), path.join(root, 'evidence-inbox-0123456789abcdef'));
  const dir = path.join(root, 'inbox');
  let clock = 1_700_000_000_000;
  const inbox = createInbox({ dir, now: () => clock++ });
  const a = inbox.put({ kind: 'record', model: 'm', record: { category: 'vision', result: 'passed' } });
  const b = inbox.put({ kind: 'import', model: 'm', checkpoint: null });
  assert.ok(a < b, 'names sort by time');
  assert.deepEqual(fs.readdirSync(dir).sort(), [a, b]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, a), 'utf8')), { kind: 'record', model: 'm', record: { category: 'vision', result: 'passed' } });
  assert.equal(fs.statSync(path.join(dir, a)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.ok(inbox.pending(a));
  fs.rmSync(path.join(dir, a));
  assert.equal(inbox.pending(a), false);
});

test('a bad model name, an oversized entry and a full inbox queue nothing and never throw', (t) => {
  const dir = path.join(tmp(t), 'inbox');
  const logs = [];
  const inbox = createInbox({ dir, maxEntries: 2, log: (m) => logs.push(m) });
  assert.equal(inbox.put({ kind: 'record', model: '', record: {} }), null);
  assert.equal(inbox.put({ kind: 'record', model: 'x'.repeat(201), record: {} }), null);
  assert.equal(inbox.put({ kind: 'record', model: 'm', record: { big: 'x'.repeat(MAX_BYTES) } }), null);
  assert.equal(fs.existsSync(dir), false, 'nothing was created for a refused entry');
  assert.ok(inbox.put({ kind: 'record', model: 'm', record: {} }));
  assert.ok(inbox.put({ kind: 'record', model: 'm', record: {} }));
  assert.equal(inbox.put({ kind: 'record', model: 'm', record: {} }), null, 'full');
  assert.match(logs[0], /inbox is full/);
  // A path that cannot be a directory: logged, not thrown.
  const file = path.join(path.dirname(dir), 'plain'); fs.writeFileSync(file, 'x');
  assert.equal(createInbox({ dir: path.join(file, 'in'), log: (m) => logs.push(m) }).put({ kind: 'record', model: 'm', record: {} }), null);
  assert.match(logs.at(-1), /could not queue/);
});

test('applied() waits for the front to take the entry, and gives up', async (t) => {
  const dir = path.join(tmp(t), 'inbox');
  const inbox = createInbox({ dir });
  const name = inbox.put({ kind: 'record', model: 'm', record: {} });
  setTimeout(() => fs.rmSync(path.join(dir, name)), 120);
  assert.equal(await inbox.applied(name, { timeoutMs: 2000, stepMs: 20 }), true);
  const stuck = inbox.put({ kind: 'record', model: 'm', record: {} });
  assert.equal(await inbox.applied(stuck, { timeoutMs: 100, stepMs: 20 }), false);
});

test('the manager queues evidence for the front and reads the log the front wrote', async (t) => {
  const root = tmp(t), evidenceDir = path.join(root, 'evidence-0123456789abcdef');
  const manager = createLlamaCppManager({ baseUrl: 'http://127.0.0.1:9/v1', fetchJson: async () => ({ ok: false }), evidenceDir, downloadStatePath: path.join(root, 'dl.json') });
  const handle = await manager.recordEvidence('synthetic-model', { category: 'vision', result: 'reported', value: null, suite: { name: 'vision-probe', version: 1 }, source: 'probe', limitations: [] });
  assert.ok(handle, 'queued');
  const inbox = path.join(root, 'evidence-inbox-0123456789abcdef');
  assert.deepEqual(fs.readdirSync(inbox), [handle]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(inbox, handle), 'utf8')).record.category, 'vision');
  assert.equal(fs.existsSync(evidenceDir), false, 'this process wrote nothing to the store');
  const imported = await manager.importEvidence('acme/model-7b', { checkpoint: 'acme/model-7b:Q4' });
  assert.equal(imported.ok, true);
  const entries = fs.readdirSync(inbox).map((n) => JSON.parse(fs.readFileSync(path.join(inbox, n), 'utf8')));
  assert.deepEqual(entries.find((e) => e.kind === 'import'), { kind: 'import', model: 'acme/model-7b', checkpoint: 'acme/model-7b:Q4' });
  // Without a store directory nothing is tracked or queued.
  const bare = createLlamaCppManager({ baseUrl: 'http://127.0.0.1:9/v1', fetchJson: async () => ({ ok: false }), downloadStatePath: path.join(root, 'dl2.json') });
  assert.equal(await bare.recordEvidence('m', { category: 'vision', result: 'passed' }), null);
  assert.equal((await bare.importEvidence('m')).ok, false);
  // The reader sees what the front appended, and is read-only.
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'evidence.jsonl'), '{"model":"m","category":"vision"}\nnot json\n');
  assert.deepEqual(createReader(evidenceDir).list(), [{ model: 'm', category: 'vision' }]);
  assert.equal(createReader(evidenceDir).append, undefined);
});
