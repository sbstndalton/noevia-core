#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for auto-tune's foreign-load decision (#1062). The same file is
// committed byte-for-byte in sbstndalton/noevia-rs (crates/tune-contention/tests/fixtures/
// tune-contention.v1.json); noevia-core CI compares them.
//   node tools/gen-tune-contention-fixtures.cjs > tests/fixtures/tune-contention.v1.json
//
// `expect` comes from refDecide below: an independent reference written from the crate's
// specification (crates/tune-contention/src/lib.rs docs). It is a test oracle only; noevia-core
// runs the Rust decision (dav-parse.wasm tune_contention) and never this. Model ids are made up.
//
// Sections:
//   cases:  { name, input, expect }   tune_contention(JSON.stringify(input)) must reply `expect`
//   errors: { name, text, pad, expect: { error } }   text + `pad` spaces must be refused

const LIMITS = { maxInputBytes: 64 * 1024, maxRows: 256, maxIdBytes: 256, maxStatusBytes: 64,
  maxWaitMs: 86400000, maxQuietMs: 3600000 };

function stateOf(row) {
  if (row.status === 'unloaded' || row.status === 'failed') return null;
  if (row.status === 'loading') return 'loading';
  if (row.status === 'loaded' || row.status === 'sleeping') return row.busy === null ? 'unknown' : row.busy === 0 ? 'idle' : 'busy';
  return 'other';
}
// Byte order of UTF-8 equals code point order; compare code points, not UTF-16 units.
const byteOrder = (a, b) => { const x = [...a].map(c => c.codePointAt(0)), y = [...b].map(c => c.codePointAt(0));
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length; };

function refDecide(input) {
  const foreign = input.rows.filter(r => r.id !== input.tuning).map(r => [r.id, stateOf(r)]).filter(([, s]) => s !== null)
    .sort((a, b) => byteOrder(a[0], b[0]));
  const waitedMs = Math.max(0, input.now - input.startedAt);
  const ids = foreign.map(([id]) => id);
  const reply = (action, reason, fingerprint, since) => ({ action, fingerprint, foreign: ids, reason, since,
    unload: action === 'unload' ? ids : [], waitedMs });
  if (!foreign.length) return reply('proceed', 'clear', '', input.now);
  const fingerprint = JSON.stringify(foreign);
  const since = input.prev && input.prev.fingerprint === fingerprint ? Math.min(input.prev.since, input.now) : input.now;
  const has = s => foreign.some(([, x]) => x === s);
  if (waitedMs >= input.maxWaitMs) return reply('give_up', 'timed_out', fingerprint, since);
  if (has('loading')) return reply('wait', 'loading', fingerprint, since);
  if (has('other')) return reply('wait', 'other', fingerprint, since);
  if (has('busy')) return reply('wait', 'busy', fingerprint, since);
  const unknown = has('unknown');
  if (input.now - since >= (unknown ? 2 : 1) * input.quietMs) return reply('unload', unknown ? 'idle_unknown' : 'idle', fingerprint, since);
  return reply('wait', 'settling', fingerprint, since);
}

const T = 'gemma-test-12b';
const base = (rows, extra = {}) => ({ tuning: T, rows, prev: null, startedAt: 1000, now: 2000, maxWaitMs: 900000, quietMs: 30000, ...extra });
const r = (id, status, busy = null) => ({ id, status, busy });
const fp = pairs => JSON.stringify(pairs);

function cases() {
  const out = [];
  const add = (name, input) => out.push({ name, input, expect: refDecide(input) });
  add('empty', base([]));
  add('only-tuned-loaded', base([r(T, 'loaded', 1)]));
  add('only-tuned-loading', base([r(T, 'loading')]));
  add('others-unloaded', base([r(T, 'loaded', 0), r('qwen-test-9b', 'unloaded'), r('e2b-test', 'failed')]));
  add('clear-past-limit', base([r('x', 'unloaded')], { now: 99999999 }));
  for (const status of ['loaded', 'sleeping']) {
    for (const busy of [0, 1, 7, 4294967295, null]) add(`${status}-busy-${busy}`, base([r('qwen-test-9b', status, busy)]));
  }
  add('loading', base([r('qwen-test-9b', 'loading')]));
  add('loading-with-busy-number', base([r('qwen-test-9b', 'loading', 3)]));
  for (const status of ['unloading', 'Loaded', '', 'downloading', 'élan']) add(`other-status-${JSON.stringify(status)}`, base([r('qwen-test-9b', status)]));
  // The #1062 incident shape: the tuned model evicted, another model loading, then loaded and busy.
  add('incident-evicted-loading', base([r(T, 'unloaded'), r('qwen-test-9b', 'loading')]));
  add('incident-busy', base([r(T, 'unloaded'), r('qwen-test-9b', 'loaded', 1)]));
  // Order of precedence among several foreign models.
  add('loading-beats-other', base([r('b', 'weird'), r('a', 'loading'), r('c', 'loaded', 2)]));
  add('other-beats-busy', base([r('b', 'weird'), r('c', 'loaded', 2)]));
  add('busy-beats-idle', base([r('b', 'loaded', 0), r('c', 'loaded', 2)]));
  add('idle-and-unknown', base([r('b', 'loaded', 0), r('c', 'sleeping', null)]));
  // Quiet windows, with the matching previous fingerprint.
  const idle = fp([['qwen-test-9b', 'idle']]), unk = fp([['qwen-test-9b', 'unknown']]);
  for (const now of [2000, 31999, 32000, 32001, 61999, 62000, 62001]) {
    add(`quiet-idle-${now}`, base([r('qwen-test-9b', 'loaded', 0)], { prev: { fingerprint: idle, since: 2000 }, now }));
    add(`quiet-unknown-${now}`, base([r('qwen-test-9b', 'loaded', null)], { prev: { fingerprint: unk, since: 2000 }, now }));
  }
  add('prev-other-fingerprint', base([r('qwen-test-9b', 'loaded', 0)], { prev: { fingerprint: fp([['qwen-test-9b', 'busy']]), since: 2000 }, now: 500000 }));
  add('prev-empty-fingerprint', base([r('qwen-test-9b', 'loaded', 0)], { prev: { fingerprint: '', since: 0 }, now: 500000 }));
  add('prev-since-future', base([r('qwen-test-9b', 'loaded', 0)], { prev: { fingerprint: idle, since: 9e15 }, now: 5000 }));
  add('quiet-zero', base([r('qwen-test-9b', 'loaded', 0)], { quietMs: 0 }));
  add('quiet-zero-unknown', base([r('qwen-test-9b', 'loaded', null)], { quietMs: 0 }));
  add('quiet-max', base([r('qwen-test-9b', 'loaded', 0)], { quietMs: 3600000, prev: { fingerprint: idle, since: 0 }, now: 7200000, maxWaitMs: 86400000, startedAt: 0 }));
  // Limits of the wait.
  for (const now of [900999, 901000, 901001]) {
    add(`limit-busy-${now}`, base([r('qwen-test-9b', 'loaded', 2)], { now }));
    add(`limit-idle-${now}`, base([r('qwen-test-9b', 'loaded', 0)], { now, prev: { fingerprint: idle, since: 1000 } }));
  }
  add('max-wait-zero', base([r('qwen-test-9b', 'loaded', 0)], { maxWaitMs: 0 }));
  add('now-before-start', base([r('qwen-test-9b', 'loaded', 0)], { startedAt: 50000, now: 1000 }));
  add('times-max', base([r('q', 'loaded', 0)], { startedAt: 9007199254740991, now: 9007199254740991, maxWaitMs: 86400000 }));
  // Ordering: byte order, including non-ASCII and case.
  add('order', base([r('zeta', 'loaded', 0), r('Alpha', 'loaded', 0), r('alpha', 'loaded', 0), r('ä-model', 'loaded', 0), r('🙂', 'loaded', 0), r('￿', 'loaded', 0)]));
  add('escapes', base([r('a"b\\c', 'loading'), r('tab\tid', 'loaded', 0), r('nl\nid', 'loaded', 1)]));
  add('tuned-id-differs-by-case', base([r(T.toUpperCase(), 'loaded', 0)]));
  // Many rows.
  add('max-rows', base(Array.from({ length: 256 }, (_, i) => r('m' + String(i).padStart(3, '0'), i % 5 ? 'unloaded' : 'loaded', 0))));
  // Seeded combinations (deterministic LCG).
  let seed = 1062;
  // The high bits: an LCG's low bits repeat with a short period.
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 256) % n; };
  const statuses = ['loaded', 'loaded', 'sleeping', 'loading', 'unloaded', 'failed', 'other'];
  const busies = [0, 0, 1, 3, null];
  for (let i = 0; i < 200; i++) {
    const n = rnd(5);
    const rows = [];
    for (let k = 0; k < n; k++) rows.push(r(k === 0 && rnd(3) === 0 ? T : 'model-' + rnd(6) + '-' + k, statuses[rnd(statuses.length)], busies[rnd(busies.length)]));
    const quietMs = [0, 1000, 30000, 120000][rnd(4)], maxWaitMs = [60000, 900000, 900000, 86400000][rnd(4)];
    // Mostly inside the wait, sometimes past it.
    const startedAt = rnd(5000), now = startedAt + rnd(Math.floor(Math.min(maxWaitMs, 1800000) * 1.15));
    const pre = refDecide({ tuning: T, rows, prev: null, startedAt, now, maxWaitMs, quietMs });
    const prev = rnd(3) === 0 ? null : { fingerprint: rnd(4) ? pre.fingerprint : '[]', since: Math.max(0, now - rnd(300000)) };
    add('seeded-' + i, { tuning: T, rows, prev, startedAt, now, maxWaitMs, quietMs });
  }
  return out;
}

const ok = '"tuning":"t","rows":[],"prev":null,"startedAt":0,"now":0,"maxWaitMs":10,"quietMs":0';
const errors = [
  { name: 'not-json', text: '{' },
  { name: 'array', text: '[]' },
  { name: 'missing-quiet', text: '{"tuning":"t","rows":[],"prev":null,"startedAt":0,"now":0,"maxWaitMs":10}' },
  { name: 'extra-key', text: `{${ok},"x":1}` },
  { name: 'tuning-empty', text: `{${ok.replace('"t"', '""')}}` },
  { name: 'tuning-number', text: `{${ok.replace('"t"', '5')}}` },
  { name: 'tuning-too-long', text: `{${ok.replace('"t"', JSON.stringify('t'.repeat(257)))}}` },
  { name: 'rows-object', text: `{${ok.replace('"rows":[]', '"rows":{}')}}` },
  { name: 'row-extra-key', text: `{${ok.replace('"rows":[]', '"rows":[{"id":"a","status":"loaded","busy":0,"x":1}]')}}` },
  { name: 'row-no-busy', text: `{${ok.replace('"rows":[]', '"rows":[{"id":"a","status":"loaded"}]')}}` },
  { name: 'row-id-empty', text: `{${ok.replace('"rows":[]', '"rows":[{"id":"","status":"loaded","busy":0}]')}}` },
  { name: 'row-status-null', text: `{${ok.replace('"rows":[]', '"rows":[{"id":"a","status":null,"busy":0}]')}}` },
  { name: 'row-status-too-long', text: `{${ok.replace('"rows":[]', `"rows":[{"id":"a","status":"${'s'.repeat(65)}","busy":0}]`)}}` },
  { name: 'row-busy-negative', text: `{${ok.replace('"rows":[]', '"rows":[{"id":"a","status":"loaded","busy":-1}]')}}` },
  { name: 'row-busy-fraction', text: `{${ok.replace('"rows":[]', '"rows":[{"id":"a","status":"loaded","busy":1.5}]')}}` },
  { name: 'row-busy-over-u32', text: `{${ok.replace('"rows":[]', '"rows":[{"id":"a","status":"loaded","busy":4294967296}]')}}` },
  { name: 'row-busy-string', text: `{${ok.replace('"rows":[]', '"rows":[{"id":"a","status":"loaded","busy":"0"}]')}}` },
  { name: 'row-duplicate', text: `{${ok.replace('"rows":[]', '"rows":[{"id":"a","status":"loaded","busy":0},{"id":"a","status":"unloaded","busy":null}]')}}` },
  { name: 'too-many-rows', text: `{${ok.replace('"rows":[]', `"rows":[${Array.from({ length: 257 }, (_, i) => `{"id":"m${i}","status":"unloaded","busy":null}`).join(',')}]`)}}` },
  { name: 'prev-string', text: `{${ok.replace('"prev":null', '"prev":"x"')}}` },
  { name: 'prev-missing-since', text: `{${ok.replace('"prev":null', '"prev":{"fingerprint":"x"}')}}` },
  { name: 'prev-extra', text: `{${ok.replace('"prev":null', '"prev":{"fingerprint":"x","since":0,"y":1}')}}` },
  { name: 'started-negative', text: `{${ok.replace('"startedAt":0', '"startedAt":-1')}}` },
  { name: 'now-fraction', text: `{${ok.replace('"now":0', '"now":0.5')}}` },
  { name: 'now-unsafe', text: `{${ok.replace('"now":0', '"now":9007199254740992')}}` },
  { name: 'max-wait-over', text: `{${ok.replace('"maxWaitMs":10', '"maxWaitMs":86400001')}}` },
  { name: 'quiet-over', text: `{${ok.replace('"quietMs":0', '"quietMs":3600001')}}` },
].map(e => ({ ...e, pad: 0, expect: { error: 'input' } }));
errors.push({ name: 'input-too-long', text: `{${ok}}`, pad: LIMITS.maxInputBytes, expect: { error: 'too_large' } });

if (require.main === module) {
  process.stdout.write(JSON.stringify({ version: 1, limits: LIMITS, cases: cases(), errors }, null, 1) + '\n');
}
module.exports = { refDecide, LIMITS };
