'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { send, run, parseArgs, readJsonl, EXIT_PAUSED, EXIT_FAILING } = require('./run.cjs');

const body = { state: 's', question: 'q?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
const req = (id, variant = 'base') => ({ id, purpose: 'model.route', variant, lang: 'en', label: 'a', body });
const reply = (status, json) => async () => new Response(typeof json === 'string' ? json : JSON.stringify(json), { status });
const clock = () => { let t = 0; return () => (t += 25); };
const laya = { target: 'laya', url: 'http://laya:8040', timeoutMs: 1000, label: 'laya-en (live)' };
const ollaya = { target: 'ollaya', url: 'http://127.0.0.1:11535', model: 'decima:small', apiKey: 'k', timeoutMs: 1000, label: 'decima:small' };

test('send to our contract: the body unchanged, raw scores kept, contract checked', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ selected: 'a', scores: { a: 0.7, b: 0.3 }, model: 'convaiinnovations/laya' })); };
  const out = await send(req('1'), laya, { fetchImpl, now: clock() });
  assert.equal(seen.url, 'http://laya:8040/v1/decisions');
  assert.deepEqual(JSON.parse(seen.init.body), body);
  assert.equal(seen.init.headers.authorization, undefined);
  assert.deepEqual(out, { ok: true, reason: null, status: 200, selected: 'a', scores: { a: 0.7, b: 0.3 }, raw: { a: 0.7, b: 0.3 }, latencyMs: 25 });
  const bad = await send(req('1'), laya, { fetchImpl: reply(200, { selected: 'b', scores: { a: 0.7, b: 0.3 } }), now: clock() });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid-result-not-argmax');
});

test('send through the adapter: TypeSafe body, bearer key, renormalised scores', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ model: 'decima:small', answers: { d: { type: 'choice', choice: 'b', confidence: 0.2, probabilities: { a: 0.4001, b: 0.6001 } } } })); };
  const out = await send(req('1'), ollaya, { fetchImpl, now: clock() });
  assert.equal(seen.url, 'http://127.0.0.1:11535/v1/decisions');
  assert.equal(seen.init.headers.authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(seen.init.body).questions.d.criteria, { a: 'A', b: 'B' });
  assert.equal(out.ok, true);
  assert.equal(out.selected, 'b');
  assert.deepEqual(out.raw, { a: 0.4001, b: 0.6001 });
  assert.ok(Math.abs(out.scores.a + out.scores.b - 1) < 1e-12);
  const tie = await send(req('1'), ollaya, { fetchImpl: reply(200, { answers: { d: { probabilities: { a: 0.5, b: 0.5 } } } }), now: clock() });
  assert.deepEqual([tie.ok, tie.reason], [false, 'exact-tie']);
});

test('send never throws: HTTP errors keep a vetted code, network and timeouts are named', async () => {
  const opts = { ...ollaya };
  assert.equal((await send(req('1'), opts, { fetchImpl: reply(422, { code: 'STATE_TRUNCATED', error: 'x' }) })).reason, 'http-422-STATE_TRUNCATED');
  assert.equal((await send(req('1'), opts, { fetchImpl: reply(503, { code: 'not a code!' }) })).reason, 'http-503');
  assert.equal((await send(req('1'), opts, { fetchImpl: reply(500, 'plain text') })).reason, 'http-500');
  assert.equal((await send(req('1'), opts, { fetchImpl: reply(200, 'not json') })).reason, 'parse');
  assert.equal((await send(req('1'), opts, { fetchImpl: async () => { throw new TypeError('fetch failed'); } })).reason, 'network');
  assert.equal((await send(req('1'), opts, { fetchImpl: async () => { throw new DOMException('t', 'TimeoutError'); } })).reason, 'timeout');
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'decision-eval-'));
const write = (file, rows) => fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

test('run appends one record per request and resumes after the ones already done', async () => {
  const dir = tmp();
  const requests = path.join(dir, 'req.jsonl'), out = path.join(dir, 'out.jsonl');
  write(requests, [req('1'), req('2'), req('2', 'perm1'), req('3')]);
  write(out, [{ id: '1', variant: 'base', ok: true }]);
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ selected: 'a', scores: { a: 0.9, b: 0.1 } })); };
  const code = await run({ ...laya, requests, out, minIntervalMs: 0, warmup: 0, gateEvery: 0, maxFailures: 5, backoffMs: 0 }, { fetchImpl, log: () => {} });
  assert.equal(code, 0);
  assert.equal(sent.length, 3);
  const rows = readJsonl(out);
  assert.deepEqual(rows.map((r) => `${r.id}/${r.variant}`), ['1/base', '2/base', '2/perm1', '3/base']);
  assert.equal(rows[1].model, 'laya-en (live)');
  assert.equal(rows[1].label, 'a');
  assert.equal(rows[1].lang, 'en');
});

test('run: a closed idle gate pauses before sending; failures in a row stop the run', async () => {
  const dir = tmp();
  const requests = path.join(dir, 'req.jsonl');
  write(requests, [req('1'), req('2'), req('3'), req('4')]);
  let calls = 0;
  const count = async () => { calls += 1; return new Response('{}', { status: 503 }); };
  const base = { ...laya, requests, minIntervalMs: 0, warmup: 0, maxFailures: 2, backoffMs: 0, gateEvery: 0 };
  assert.equal(await run({ ...base, out: path.join(dir, 'a.jsonl'), gate: 'exit 1' }, { fetchImpl: count, log: () => {} }), EXIT_PAUSED);
  assert.equal(calls, 0);
  assert.equal(await run({ ...base, out: path.join(dir, 'b.jsonl'), gate: 'exit 0' }, { fetchImpl: count, log: () => {} }), EXIT_FAILING);
  assert.equal(calls, 2);
  // The gate is re-checked every gateEvery requests.
  const ok = async () => new Response(JSON.stringify({ selected: 'a', scores: { a: 0.9, b: 0.1 } }));
  const flag = path.join(dir, 'busy');
  const gate = `[ ! -e ${JSON.stringify(flag)} ]`;
  const out = path.join(dir, 'c.jsonl');
  let n = 0;
  const closing = async (...a) => { if (++n === 2) fs.writeFileSync(flag, ''); return ok(...a); };
  assert.equal(await run({ ...base, out, gate, gateEvery: 2 }, { fetchImpl: closing, log: () => {} }), EXIT_PAUSED);
  assert.equal(readJsonl(out).length, 2);
});

test('parseArgs requires a model for the adapter target and trims the URL', () => {
  assert.throws(() => parseArgs(['--requests', 'r', '--out', 'o', '--target', 'ollaya', '--url', 'http://x']), /usage/);
  const a = parseArgs(['--requests', 'r', '--out', 'o', '--target', 'laya', '--url', 'http://x/', '--min-interval-ms', '1000']);
  assert.equal(a.url, 'http://x');
  assert.equal(a.minIntervalMs, 1000);
  assert.equal(a.label, 'laya-en (live)');
});
