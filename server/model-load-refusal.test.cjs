'use strict';
// #2303 generation 2: the bridge the Rust front's calibration asks before every load. It answers the manager's own
// overBudget() decision (the one Node's calibrator met through llamacpp-manager's request closure), over the
// current models.ini and budget, to the front only. Synthetic GGUF headers and a fake router; nothing is loaded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createLoadRefusalRoute, PATH } = require('./model-load-refusal.cjs');
const { createModelManager } = require('./model-manager.cjs');
const { fakeGate } = require('./fixtures/fake-inference-gate.cjs');

const SECRET = 'synthetic-front-secret';

// Synthetic GGUF v3 header (no tensors), as in inference-budget.test.cjs.
function gguf(kv) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s) => { const b = Buffer.from(s); return Buffer.concat([u64(b.length), b]); };
  const val = (type, v) => (type === 4 ? u32(v) : str(v));
  return Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(Object.keys(kv).length), ...Object.entries(kv).map(([k, [t, v]]) => Buffer.concat([str(k), u32(t), val(t, v)]))]);
}
const HEADER = { 'general.architecture': [8, 'qwen35'], 'qwen35.context_length': [4, 262144], 'qwen35.embedding_length': [4, 4096], 'qwen35.block_count': [4, 32], 'qwen35.attention.head_count': [4, 16], 'qwen35.attention.head_count_kv': [4, 4], 'qwen35.attention.key_length': [4, 256], 'qwen35.attention.value_length': [4, 256], 'qwen35.full_attention_interval': [4, 4], 'qwen35.ssm.state_size': [4, 128], 'tokenizer.chat_template': [8, '{{ messages }}'] };

/** A llama.cpp manager over a synthetic models.ini, and the engine requests it made. */
function manager(t, budget = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-refusal-2303-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'q.gguf'), gguf(HEADER));
  const ini = path.join(dir, 'models.ini');
  fs.writeFileSync(ini, 'version = 1\n\n[big]\nmodel = /models/q.gguf\nctx-size = 262144\ncache-type-k = q8_0\ncache-type-v = q8_0\ncache-ram = 1024\n\n[small]\nmodel = /models/q.gguf\nctx-size = 4096\ncache-ram = 0\n\n[bad]\nmodel = /models/q.gguf\nctx-size = 4096.5\ncache-ram = 0\n');
  const engine = [];
  let budgetGib = budget;
  const m = createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic', presetPath: ini, autoconfig: { modelsPath: dir }, gate: fakeGate(),
    inferenceBudget: { budgetGib: () => budgetGib },
    fetchJson: async (url, options = {}) => { engine.push(`${options.method || 'GET'} ${new URL(url).pathname}`); return { ok: true, status: 200, body: { data: [] } }; } });
  return { m, ini, engine, setBudget: (v) => { budgetGib = v; } };
}

/** The route on a loopback listener; `ask(body, headers)` answers {status, body}. */
async function serve(t, loadRefusal) {
  const route = createLoadRefusalRoute({ secret: SECRET, loadRefusal,
    json: (res, status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); } });
  const server = http.createServer(async (req, res) => { if (!(await route.handle(req, res))) { res.statusCode = 418; res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const { port } = server.address();
  return async (body, { headers = { 'x-noevia-store-token': SECRET }, method = 'POST', target = PATH } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${target}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'POST' ? body : undefined, signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

test('#2303 the bridge answers the manager\'s own refusals: over budget, quarantined, invalid size', async (t) => {
  const { m, engine, setBudget } = manager(t);
  const ask = await serve(t, m.loadRefusal);
  const big = await ask(JSON.stringify({ model: 'big' }));
  assert.equal(big.status, 200);
  assert.equal(big.body.refusal.code, 'inference_budget');
  assert.match(big.body.refusal.error, /^big needs about [\d.]+ GiB to load .*above the 2 GiB inference memory budget/);
  // Exactly the body Node's request closure refuses the same load with.
  const node = await m.request('/models/load', { method: 'POST', body: JSON.stringify({ model: 'big' }) }, 1000);
  assert.deepEqual({ status: node.status, body: node.body }, { status: 409, body: big.body.refusal });
  const bad = await ask(JSON.stringify({ model: 'bad' }));
  assert.equal(bad.body.refusal.code, 'invalid_size');
  assert.match(bad.body.refusal.error, /^bad was not loaded: ctx-size must be a whole number/);
  setBudget(64);
  assert.deepEqual(await ask(JSON.stringify({ model: 'small' })), { status: 200, body: { refusal: null } });
  m.quarantine('small', 64);
  const held = await ask(JSON.stringify({ model: 'small' }));
  assert.equal(held.body.refusal.code, 'inference_budget_unloaded');
  assert.match(held.body.refusal.error, /unloaded by the memory safety net/);
  // A decision only: the engine is never asked to load anything.
  assert.ok(!engine.some((c) => c === 'POST /models/load'), engine.join('\n'));
});

test('#2303 the bridge decides over the models.ini current when it is asked', async (t) => {
  const { m, ini } = manager(t, 64);
  const ask = await serve(t, m.loadRefusal);
  assert.deepEqual((await ask(JSON.stringify({ model: 'small' }))).body, { refusal: null });
  // The front writes the candidate profile, then asks: the candidate is what is judged.
  fs.writeFileSync(ini, fs.readFileSync(ini, 'utf8').replace('[small]\nmodel = /models/q.gguf\nctx-size = 4096', '[small]\nmodel = /models/q.gguf\nctx-size = 4096.25'));
  assert.equal((await ask(JSON.stringify({ model: 'small' }))).body.refusal.code, 'invalid_size');
});

test('#2303 only the front may ask, and only {model}; a decision that fails is a 503', async (t) => {
  const asked = [];
  const ask = await serve(t, async (model) => { asked.push(model); if (model === 'throws') throw Error('synthetic'); return model === 'odd' ? 'yes' : null; });
  for (const headers of [{}, { 'x-noevia-store-token': 'wrong' }, { 'x-noevia-store-token': SECRET, 'x-forwarded-for': '203.0.113.9' }, { 'x-noevia-store-token': SECRET, 'x-noevia-client-ip': '203.0.113.9' }]) {
    assert.deepEqual(await ask(JSON.stringify({ model: 'small' }), { headers }), { status: 404, body: { error: 'Not found' } });
  }
  assert.equal((await ask(null, { method: 'GET' })).status, 404);
  for (const body of ['', '{bad', '[]', '{}', JSON.stringify({ model: '' }), JSON.stringify({ model: 7 }), JSON.stringify({ model: 'a', extra: 1 }), JSON.stringify({ model: 'x'.repeat(513) }), JSON.stringify({ model: 'x'.repeat(5000) })]) {
    assert.equal((await ask(body)).status, 400, body.slice(0, 40));
  }
  assert.deepEqual(await ask(JSON.stringify({ model: 'throws' })), { status: 503, body: { error: 'The load could not be checked against the inference memory budget.' } });
  assert.equal((await ask(JSON.stringify({ model: 'odd' }))).status, 503);
  assert.deepEqual(asked, ['throws', 'odd']);
  assert.equal((await ask(JSON.stringify({ model: 'small' }), { target: `${PATH}/x` })).status, 418, 'other paths are not this route\'s');
});

test('#2303 without a load decision (not llama.cpp) the bridge is absent, so the front refuses its loads', async (t) => {
  const ask = await serve(t, null);
  assert.deepEqual(await ask(JSON.stringify({ model: 'small' })), { status: 404, body: { error: 'Not found' } });
});
