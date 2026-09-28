const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ev = require('./evidence.cjs');

test('identity hash is stable across key order and sensitive to every value', () => {
  const base = { backend: 'llamacpp', build: 'b1', model: 'm', artifact: 'a', preset: 'p', context: { ctx: 32768, parallel: 1 } };
  assert.equal(ev.identityHash(base), ev.identityHash({ context: { parallel: 1, ctx: 32768 }, preset: 'p', artifact: 'a', model: 'm', build: 'b1', backend: 'llamacpp' }));
  for (const [k, v] of [['build', 'b2'], ['artifact', 'b'], ['preset', 'q'], ['context', { ctx: 131072, parallel: 1 }]]) assert.notEqual(ev.identityHash({ ...base, [k]: v }), ev.identityHash(base), k);
});

test('preset hash ignores order and file paths, not values', () => {
  assert.equal(ev.presetHash({ 'ctx-size': '8192', ngl: '999', model: '/a.gguf' }), ev.presetHash({ ngl: 999, model: '/b.gguf', 'ctx-size': 8192 }));
  assert.notEqual(ev.presetHash({ 'ctx-size': '8192' }), ev.presetHash({ 'ctx-size': '16384' }));
});

test('artifact fingerprint changes when a file is replaced under the same name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-evidence-'));
  try {
    const file = path.join(dir, 'm.gguf');
    fs.writeFileSync(file, Buffer.alloc(3 * 1024 * 1024, 1));
    const first = ev.fileFingerprint(file);
    const buf = Buffer.alloc(3 * 1024 * 1024, 1); buf[buf.length - 5] = 2; fs.writeFileSync(file, buf);
    fs.utimesSync(file, new Date(1000), new Date(1000));
    assert.notEqual(ev.fileFingerprint(file), first);
    assert.equal(ev.fileFingerprint(path.join(dir, 'missing.gguf')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('derived states follow the table and scope is literal', () => {
  const r = (identityHash, result, value, at) => ({ model: 'm', category: 'context_capacity', identityHash, result, value, at });
  assert.equal(ev.derive([], { model: 'm', category: 'context_capacity', liveHash: 'h1' }).state, 'unverified');
  assert.equal(ev.derive([r('h1', 'passed', { ctx: 32768 }, 1)], { model: 'm', category: 'context_capacity', liveHash: 'h1' }).state, 'verified');
  assert.equal(ev.derive([r('h1', 'passed', {}, 1), r('h1', 'failed', {}, 2)], { model: 'm', category: 'context_capacity', liveHash: 'h1' }).state, 'failed');
  assert.equal(ev.derive([r('h0', 'passed', {}, 1)], { model: 'm', category: 'context_capacity', liveHash: 'h1' }).state, 'stale');
  assert.equal(ev.derive([r('h1', 'passed', {}, 1)], { model: 'm', category: 'context_capacity', liveHash: null }).state, 'unavailable');
  assert.equal(ev.derive([{ ...r('h1', 'reported', {}, 1), category: 'mtp_acceptance' }], { model: 'm', category: 'mtp_acceptance', liveHash: 'h1' }).state, 'reported');
  const verified = ev.derive([r('h1', 'passed', { ctx: 32768 }, 1)], { model: 'm', category: 'context_capacity', liveHash: 'h1' });
  assert.equal(verified.record.value.ctx, 32768, 'the verified value is the measured size, nothing larger');
});

test('store is append-only, skips unchanged repeats, private and refuses credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-evidence-store-'));
  try {
    const store = ev.createStore(dir);
    const rec = { model: 'm', category: 'vision', identityHash: 'h', result: 'passed', value: null };
    store.appendIfChanged(rec); store.appendIfChanged(rec); store.appendIfChanged({ ...rec, result: 'failed' });
    assert.equal(store.list().length, 2);
    assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
    assert.throws(() => store.append({ ...rec, limitations: ['Authorization: Bearer abcdefgh12345'] }));
    assert.throws(() => store.append({ ...rec, limitations: ['hf_abcdefghijklmnopqrstuvwxyz'] }));
    // Ordinary measurement words are not credentials.
    store.append({ ...rec, limitations: ['60 tokens per prompt', 'max_tokens 1'], suite: { name: 'token-throughput' } });
    assert.throws(() => store.append({ model: 'm', category: 'vision', result: 'maybe' }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reported rates are throttled to meaningful changes or a daily refresh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-evidence-rate-'));
  try {
    const store = ev.createStore(dir);
    const rec = (rate) => ({ model: 'm', category: 'mtp_acceptance', identityHash: 'h', result: 'reported', value: { rate } });
    store.appendReportedRate(rec(0.70));
    store.appendReportedRate(rec(0.72));
    assert.equal(store.list().length, 1);
    store.appendReportedRate(rec(0.80));
    assert.equal(store.list().length, 2);
    store.appendReportedRate(rec(0.80), { now: Date.now() + 2 * 86400000 });
    assert.equal(store.list().length, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a task-scoped record gets a monotonic revision, independent of category or identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-evidence-revision-'));
  try {
    const store = ev.createStore(dir);
    const taskId = 'task-1';
    const one = store.append({ taskId, model: 'm', category: 'context_capacity', identityHash: 'h1', result: 'passed', value: null });
    const two = store.append({ taskId, model: 'm', category: 'vision', identityHash: 'h2', result: 'failed', value: null });
    const three = store.append({ taskId, model: 'm', category: 'context_capacity', identityHash: 'h1', result: 'passed', value: null });
    assert.deepEqual([one.revision, two.revision, three.revision], [1, 2, 3]);
    // A different task starts its own sequence at 1; the two never interleave.
    const other = store.append({ taskId: 'task-2', model: 'm', category: 'vision', identityHash: 'h1', result: 'passed', value: null });
    assert.equal(other.revision, 1);
    // A caller cannot smuggle its own revision in: the store's own count always wins.
    const spoofed = store.append({ taskId, model: 'm', category: 'vision', identityHash: 'h2', result: 'passed', value: null, revision: 999 });
    assert.equal(spoofed.revision, 4);
    // A record with no taskId at all — every existing producer — gets no revision field, exactly
    // as before this feature existed.
    const untaskd = store.append({ model: 'm', category: 'throughput', identityHash: 'h3', result: 'passed', value: null });
    assert.equal('revision' in untaskd, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('revisions survive a reload of the store from disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-evidence-revision-reload-'));
  try {
    const first = ev.createStore(dir);
    first.append({ taskId: 't', model: 'm', category: 'vision', identityHash: 'h', result: 'passed', value: null });
    first.append({ taskId: 't', model: 'm', category: 'vision', identityHash: 'h', result: 'passed', value: null });
    const reopened = ev.createStore(dir);
    const third = reopened.append({ taskId: 't', model: 'm', category: 'vision', identityHash: 'h', result: 'passed', value: null });
    assert.equal(third.revision, 3, 'a freshly constructed store still continues the task’s sequence');
    assert.deepEqual(reopened.list().map((r) => r.revision), [1, 2, 3]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy records with no revision or taskId field still load, list and derive normally', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-evidence-legacy-'));
  try {
    const file = path.join(dir, 'evidence.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    // Written by hand, the shape evidence.jsonl had before this feature existed: no `taskId`,
    // no `revision`.
    const legacy = { id: 'ev_legacy', at: 1000, limitations: [], model: 'm', category: 'context_capacity', identityHash: 'h1', result: 'passed', value: { ctx: 32768 } };
    fs.writeFileSync(file, JSON.stringify(legacy) + '\n', { mode: 0o600 });
    const store = ev.createStore(dir);
    const loaded = store.list();
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0], legacy, 'nothing was rewritten or backfilled onto the old record');
    const derived = ev.derive(loaded, { model: 'm', category: 'context_capacity', liveHash: 'h1' });
    assert.equal(derived.state, 'verified');
    // A new task-scoped record appended alongside legacy ones starts its own sequence at 1: the
    // legacy record (no taskId) is simply invisible to that count.
    const next = store.append({ taskId: 'new-task', model: 'm', category: 'context_capacity', identityHash: 'h1', result: 'passed', value: null });
    assert.equal(next.revision, 1);
    assert.equal(store.list().length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a task’s revision never repeats, even once compaction drops the record that held the highest one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-evidence-revision-compact-'));
  try {
    // A tiny cap and a single shared key so the very first few appends already trigger
    // compaction and evict everything but the newest keepPerKey=1 record for that key.
    const store = ev.createStore(dir, { maxBytes: 1, keepPerKey: 1 });
    const rec = (taskId) => ({ taskId, model: 'm', category: 'vision', identityHash: 'h', result: 'passed', value: null });
    const one = store.append(rec('t1'));
    assert.equal(one.revision, 1);
    // Other tasks append to the SAME key, so compaction (triggered by the tiny maxBytes) evicts
    // t1's revision-1 record entirely — list() can no longer see it at all.
    store.append(rec('t2'));
    store.append(rec('t3'));
    assert.equal(store.list().some((r) => r.taskId === 't1'), false, 't1’s own record was compacted away');
    // Without a persisted high-water mark this would recompute from an empty scan and hand out
    // revision 1 again — a real repeat, not just a gap.
    const again = store.append(rec('t1'));
    assert.equal(again.revision, 2, 't1’s next revision still continues from where it left off');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupt revisions sidecar is rebuilt from the log, never silently treated as empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-evidence-corrupt-sidecar-'));
  try {
    const store = ev.createStore(dir);
    store.append({ taskId: 't1', model: 'm', category: 'vision', identityHash: 'h', result: 'passed', value: null });
    store.append({ taskId: 't1', model: 'm', category: 'vision', identityHash: 'h', result: 'passed', value: null });
    store.append({ taskId: 't2', model: 'm', category: 'vision', identityHash: 'h', result: 'passed', value: null });
    // Corrupt the sidecar by hand: truncated JSON, the kind a crash mid-write could leave.
    const sidecar = path.join(dir, 'evidence-task-revisions.json');
    fs.writeFileSync(sidecar, '{"t1": 2, "t2":', { mode: 0o600 });
    // The next append for t2 must not silently treat the corrupt file as empty (which would
    // reissue t2's already-used revision 1) or erase t1's mark from the rebuilt file.
    const next = store.append({ taskId: 't2', model: 'm', category: 'vision', identityHash: 'h', result: 'passed', value: null });
    assert.equal(next.revision, 2, 't2 continues from what the log itself still shows');
    const rebuilt = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.deepEqual(rebuilt, { t1: 2, t2: 2 }, 't1’s high-water mark survived the corruption, rebuilt from the log');
    // And t1's own next revision is unaffected — nothing was lost.
    const t1next = store.append({ taskId: 't1', model: 'm', category: 'vision', identityHash: 'h', result: 'passed', value: null });
    assert.equal(t1next.revision, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a sidecar that parses to null, an array or a bare number is rejected the same as corrupt JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-evidence-bad-sidecar-'));
  try {
    const store = ev.createStore(dir);
    store.append({ taskId: 't1', model: 'm', category: 'vision', identityHash: 'h', result: 'passed', value: null });
    const sidecar = path.join(dir, 'evidence-task-revisions.json');
    for (const bad of ['null', '[1,2,3]', '42', '"just a string"']) {
      fs.writeFileSync(sidecar, bad, { mode: 0o600 });
      const next = store.append({ taskId: 't1', model: 'm', category: 'vision', identityHash: 'h', result: 'passed', value: null });
      assert.ok(next.revision > 1, `revision still advances past what the log shows for ${bad}`);
    }
    // Values of the wrong shape inside an otherwise-plain object are dropped, not trusted.
    fs.writeFileSync(sidecar, JSON.stringify({ t1: 'not-a-number', t2: -5, t3: 4.5, t4: 9 }), { mode: 0o600 });
    const next = store.append({ taskId: 't2', model: 'm', category: 'vision', identityHash: 'h', result: 'passed', value: null });
    // t2's bad entry (-5) is dropped; the log itself already shows t2 has never been used here,
    // so its true next revision is computed from scratch, not from the rejected -5.
    assert.equal(next.revision, 1);
    const after = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.equal(after.t3, undefined, 'a non-integer value is dropped, not carried forward');
    assert.equal(after.t4, 9, 'a valid entry alongside bad ones is preserved');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the evidence log stays bounded and keeps the newest records per model, category and identity', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createStore } = require('./evidence.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-evidence-bound-'));
  try {
    const store = createStore(dir, { maxBytes: 20_000, keepPerKey: 3 });
    for (let i = 0; i < 400; i++) store.append({ category: 'mtp_acceptance', model: i % 2 ? 'a' : 'b', identityHash: 'h' + (i % 4 < 2 ? 1 : 2), result: 'reported', value: { rate: i / 400 } });
    assert.ok(fs.statSync(store.file).size <= 20_000 * 1.5, `log grew to ${fs.statSync(store.file).size} bytes`);
    const records = store.list();
    const newest = records.filter((r) => r.model === 'a').map((r) => r.value.rate);
    assert.ok(newest.includes(399 / 400), 'the newest record survives compaction');
    const perKey = {}; for (const r of records) { const k = `${r.model}|${r.category}|${r.identityHash}`; perKey[k] = (perKey[k] || 0) + 1; }
    assert.ok(Object.values(perKey).every((n) => n <= 3 + 50), JSON.stringify(perKey));
    assert.ok(Object.keys(perKey).length >= 4, 'every identity keeps its evidence');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
