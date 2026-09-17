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
