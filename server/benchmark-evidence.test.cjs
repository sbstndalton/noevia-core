const test = require('node:test'), assert = require('node:assert/strict');
const { throughputRecords } = require('./benchmark-evidence.cjs');

const now = 2_000_000_000_000;
const res = (alias, gen_tps, extra = {}) => ({ alias, gen_tps, prompt_tps: 200, err: '', cold: 0, contended: 0, truncated: 0, ...extra });
const detail = (over = {}) => ({
  run: { id: 7, status: 'done', finished_at: now / 1000 - 60 },
  variants: [{ alias: 'Qwen', argv_json: '{}' }, { alias: 'Qwen@ctx4k', argv_json: '{"ctx-size":"4096"}' }, { alias: 'Gemma', argv_json: '{}' }],
  results: [res('Qwen', 10), res('Qwen', 14), res('Qwen', 12), res('Qwen', 99, { cold: 1 }), res('Qwen', 1, { err: 'timeout' }), res('Qwen@ctx4k', 20), res('Qwen@ctx4k', 21), res('Gemma', 30)],
  ...over,
});

test('median of warm, uncontended, successful requests for preset variants only', () => {
  const out = throughputRecords(detail(), { now });
  assert.deepEqual(out.map((o) => o.model), ['Qwen'], 'sweep variants and single-sample variants are skipped');
  assert.deepEqual(out[0].record.value, { rate: 12, promptRate: 200, samples: 3, runId: 7 });
  assert.equal(out[0].record.result, 'reported');
  assert.equal(out[0].record.category, 'throughput');
});

test('unfinished, stale or malformed runs produce nothing', () => {
  assert.deepEqual(throughputRecords(detail({ run: { id: 7, status: 'running', finished_at: now / 1000 } }), { now }), []);
  assert.deepEqual(throughputRecords(detail({ run: { id: 7, status: 'done', finished_at: now / 1000 - 3600 } }), { now }), []);
  assert.deepEqual(throughputRecords({}, { now }), []);
  assert.deepEqual(throughputRecords(detail({ variants: [{ alias: 'Qwen', argv_json: '{bad' }] }), { now }), []);
});
