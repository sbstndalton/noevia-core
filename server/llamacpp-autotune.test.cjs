'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createModelManager } = require('./model-manager.cjs');
const { extensions, geomean } = require('./llamacpp-autotune.cjs');

// Synthetic llama.cpp router whose speed depends on the preset under test.
function fixture(t, { head = true, gen = { none: 20, mtp: 40, 'mtp-8': 46, 'mtp-2': 30, ngram: 21 }, prompt = { 512: 500, 1024: 620, 2048: 560 }, changeList = null, calibrateSpy = null, onChat } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotune-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ini = path.join(dir, 'models.ini');
  const original = 'version = 1\n[synthetic]\nmodel = /models/s.gguf\nctx-size = 16384\nparallel = 1\ncache-type-k = q8_0\ncache-type-v = q8_0\n';
  fs.writeFileSync(ini, original);
  const router = { status: { synthetic: 'unloaded' }, chats: 0, loads: [] };
  const section = () => { const text = fs.readFileSync(ini, 'utf8'); const block = /\[synthetic\]([^[]*)/.exec(text)[1]; return Object.fromEntries([...block.matchAll(/^([\w-]+)\s*=\s*(.+)$/gm)].map((m) => [m[1], m[2].trim()])); };
  const specKey = (o) => { const type = o['spec-type'] || 'none'; if (type === 'draft-mtp') return o['spec-draft-n-max'] ? `mtp-${o['spec-draft-n-max']}` : 'mtp'; if (type === 'ngram-simple') return 'ngram'; return 'none'; };
  const fetchJson = async (url, opts = {}) => {
    const u = new URL(url), body = opts.body ? JSON.parse(opts.body) : {};
    if (u.pathname === '/models' && (!opts.method || opts.method === 'GET')) return { ok: true, status: 200, body: { data: Object.entries(router.status).map(([id, value]) => ({ id, status: { value }, meta: { n_ctx_train: 262144 } })) } };
    if (u.pathname === '/models/load') { router.loads.push(section()); router.status.synthetic = 'loaded'; return { ok: true, status: 200, body: {} }; }
    if (u.pathname === '/models/unload') { router.status[body.model] = 'unloaded'; return { ok: true, status: 200, body: {} }; }
    if (u.pathname === '/v1/chat/completions') {
      router.chats++; await onChat?.(router);
      const o = section(), key = specKey(o), content = body.messages[0].content;
      assert.equal(body.chat_template_kwargs.enable_thinking, false); assert.equal(body.temperature, 0);
      const drafting = key !== 'none' && (key === 'ngram' || head);
      let text = content.startsWith('List the whole numbers') ? Array.from({ length: 60 }, (_, i) => i + 1).join(', ') : 'Synthetic answer.';
      if (changeList && key === changeList && content.startsWith('List')) text += ', 61';
      const timings = { predicted_per_second: key.startsWith('mtp') && !head ? gen.none : gen[key], prompt_per_second: prompt[Number(o['ubatch-size'])] || 400,
        ...(drafting ? { draft_n: 100, draft_n_accepted: 80 } : {}) };
      return { ok: true, status: 200, body: { choices: [{ message: { content: text } }], timings } };
    }
    return { ok: true, status: 200, body: {} };
  };
  const manager = createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic', presetPath: ini, fetchJson,
    calibrationStatePath: path.join(dir, 'cal.json'), autotuneStatePath: path.join(dir, 'tune.json'), autotuneTablePath: path.join(dir, 'table.json'),
    autoconfig: {}, calibrationOptions: { sleep: async () => {}, readMemory: () => 20 },
    autotuneOptions: { sleep: async () => {}, readMemory: () => 20, identityFor: async () => ({ arch: 'qwen35', quant: 'Q5_K_M', hardware: 'synthetic-apu' }), ...(calibrateSpy ? { calibrate: calibrateSpy } : {}) } });
  return { manager, ini, original, router, section, dir };
}
async function finished(manager) {
  for (let i = 0; i < 5000; i++) { const job = manager.autotune.status().body.job; if (job && job.status !== 'running') return job; await new Promise((r) => setImmediate(r)); }
  throw Error('auto-tune did not finish');
}

test('picks the fastest speculative profile, then the fastest micro-batch, saves both and records the table', async (t) => {
  const f = fixture(t);
  const started = await f.manager.autotune.start('synthetic', { confirmPause: true });
  assert.equal(started.status, 202);
  const job = await finished(f.manager);
  assert.equal(job.status, 'passed', job.error);
  assert.equal(job.result.spec, 'mtp-deep');
  assert.equal(job.result.ubatch, 1024);
  assert.equal(job.result.gain, Math.round((46 / 20 - 1) * 100));
  const saved = f.section();
  assert.equal(saved['spec-type'], 'draft-mtp'); assert.equal(saved['spec-draft-n-max'], '8'); assert.equal(saved['spec-draft-p-min'], '0.05');
  assert.equal(saved['ubatch-size'], '1024'); assert.equal(saved['ctx-size'], '16384', 'context is not touched by the speed tune');
  assert.equal(saved['cache-type-k'], 'q8_0');
  assert.equal(job.result.loaded, true);
  const table = JSON.parse(fs.readFileSync(path.join(f.dir, 'table.json'), 'utf8'));
  const entry = Object.values(table.entries)[0];
  assert.deepEqual([entry.arch, entry.quant, entry.hardware, entry.spec], ['qwen35', 'Q5_K_M', 'synthetic-apu', 'mtp-deep']);
  assert.equal(f.manager.autotune.status('synthetic').body.history.length, 1);
});

test('without a head, MTP profiles are rejected and a gain under 5% keeps speculation off', async (t) => {
  const f = fixture(t, { head: false, gen: { none: 20, mtp: 40, 'mtp-8': 46, 'mtp-2': 30, ngram: 20.5 } });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const job = await finished(f.manager);
  assert.equal(job.status, 'passed', job.error);
  assert.deepEqual(job.steps.filter((s) => s.kind === 'spec' && s.id.startsWith('mtp')).map((s) => s.status), ['rejected', 'rejected', 'rejected']);
  assert.equal(job.result.spec, 'off', 'n-gram at 20.5 vs 20 tokens/s (2.5 %) is not worth it');
  assert.equal(f.section()['spec-type'], 'none');
});

test('a profile that changes the deterministic list output is rejected even when fastest', async (t) => {
  const f = fixture(t, { changeList: 'mtp-8' });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const job = await finished(f.manager);
  assert.equal(job.steps.find((s) => s.id === 'mtp-deep').status, 'rejected');
  assert.equal(job.result.spec, 'mtp');
});

test('chat pauses for the whole run, needs confirmation, and will not start twice', async (t) => {
  let pausedDuringRun = null;
  const f = fixture(t, { onChat: async () => { if (pausedDuringRun === null) pausedDuringRun = true; } });
  assert.equal((await f.manager.autotune.start('synthetic', {})).status, 400);
  assert.equal((await f.manager.autotune.start('synthetic', { confirmPause: true })).status, 202);
  assert.equal((await f.manager.autotune.start('synthetic', { confirmPause: true })).status, 409);
  assert.equal((await f.manager.calibration.start('synthetic', { confirmPause: true })).status, 409, 'the maintenance gate is held');
  await finished(f.manager);
  assert.equal(pausedDuringRun, true);
  assert.notEqual((await f.manager.calibration.start('synthetic', { confirmPause: true })).status, 409, 'released afterwards');
});

test('cancelling restores the original preset file', async (t) => {
  let f;
  f = fixture(t, { onChat: async (router) => { if (router.chats === 6) f.manager.autotune.cancel(); } });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const job = await finished(f.manager);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.restored, true);
  assert.equal(fs.readFileSync(f.ini, 'utf8'), f.original);
});

test('the lookup table tries the previous winner right after the baseline', async (t) => {
  const f = fixture(t);
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  await finished(f.manager);
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const second = await finished(f.manager);
  assert.deepEqual(second.steps.filter((s) => s.kind === 'spec').map((s) => s.id).slice(0, 2), ['off', 'mtp-deep']);
});

test('measured prompt speed proposes a longer context and starts calibration only when asked', async (t) => {
  const calls = [];
  const f = fixture(t, { calibrateSpy: async (model, budget) => { calls.push([model, budget]); return { ok: true, status: 202 }; } });
  await f.manager.autotune.start('synthetic', { confirmPause: true, promptBudgetSeconds: 120 });
  let job = await finished(f.manager);
  const ctx = job.result.extensions.find((e) => e.id === 'context');
  assert.ok(ctx && ctx.to === 620 * 120, JSON.stringify(job.result.extensions));
  assert.equal(calls.length, 0);
  await f.manager.autotune.start('synthetic', { confirmPause: true, promptBudgetSeconds: 120, extendContext: true });
  job = await finished(f.manager);
  for (let i = 0; i < 100 && !calls.length; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [['synthetic', 120]]);
});

test('extension rules: q8_0 KV only when an f16 cache stopped context short of native', () => {
  // 32K at 100 tokens/s needs 328 s: flagged as too large, and a q8_0 cache is already in use.
  assert.deepEqual(extensions({ options: { 'ctx-size': '32768', 'cache-type-k': 'q8_0' }, native: 262144, promptPerSecond: 100, budgetSeconds: 120, calibratedCtx: 12288 }).map((e) => e.id), ['context-too-large']);
  assert.deepEqual(extensions({ options: { 'ctx-size': '8192', 'cache-type-k': 'q8_0' }, native: 262144, promptPerSecond: 100, budgetSeconds: 120, calibratedCtx: 12288 }).map((e) => e.id), ['context']);
  assert.deepEqual(extensions({ options: { 'ctx-size': '11000', 'cache-type-k': 'q8_0' }, native: 262144, promptPerSecond: 100, budgetSeconds: 120, calibratedCtx: 12288 }), [], 'a context close to what fits needs no change');
  const out = extensions({ options: { 'ctx-size': '8192' }, native: 131072, promptPerSecond: 0, budgetSeconds: 120, calibratedCtx: 16384 });
  assert.deepEqual(out.map((e) => e.id), ['kv-q8']);
  assert.ok(Math.abs(geomean([10, 40]) - 20) < 1e-9);
});

test('progress counts finished steps out of the planned total and ends at 100', async (t) => {
  const seen = [];
  const f = fixture(t, { onChat: async () => { const j = f.manager.autotune.status().body.job; if (j?.progress) seen.push(j.progress.percent); } });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const job = await finished(f.manager);
  assert.equal(job.progress.percent, 100);
  assert.equal(job.progress.done, job.steps.length);
  assert.ok(seen.some((p) => p > 0 && p < 100), `saw ${seen.join(',')}`);
  assert.ok(seen.every((p) => p <= 99));
});

test('a cancelled run resumes from the measurements it already made', async (t) => {
  let f;
  f = fixture(t, { onChat: async (router) => { if (router.chats === 9) f.manager.autotune.cancel(); } });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const first = await finished(f.manager);
  assert.equal(first.status, 'cancelled');
  const measured = first.steps.filter((s) => s.status === 'measured').map((s) => s.id);
  assert.ok(measured.length >= 1, 'something was measured before cancelling');
  const before = f.router.chats;
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const second = await finished(f.manager);
  assert.equal(second.status, 'passed', second.error);
  for (const id of measured) assert.equal(second.steps.find((s) => s.id === id).reused, true, `${id} re-measured`);
  assert.ok(f.router.chats - before < 24, 'fewer requests than a full run');
  assert.equal(second.result.spec, 'mtp-deep');
  // A finished run clears its saved progress, so the next one starts fresh.
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const third = await finished(f.manager);
  assert.ok(third.steps.every((s) => !s.reused));
});

test('resume can be turned off to force a full re-measure', async (t) => {
  let f;
  f = fixture(t, { onChat: async (router) => { if (router.chats === 9) f.manager.autotune.cancel(); } });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  await finished(f.manager);
  await f.manager.autotune.start('synthetic', { confirmPause: true, resume: false });
  const job = await finished(f.manager);
  assert.ok(job.steps.every((s) => !s.reused));
});

test('a context too large to fill in the budget is reported, not only one too small', () => {
  const big = extensions({ options: { 'ctx-size': '131072' }, native: 131072, promptPerSecond: 559, budgetSeconds: 120, calibratedCtx: 0 });
  assert.deepEqual(big.map((e) => e.id), ['context-too-large']);
  assert.equal(big[0].to, 559 * 120);
  assert.match(big[0].why, /needs about 234 s, over the 120 s budget/);
  assert.deepEqual(extensions({ options: { 'ctx-size': '32768' }, native: 131072, promptPerSecond: 559, budgetSeconds: 120, calibratedCtx: 0 }).map((e) => e.id), ['context']);
  assert.deepEqual(extensions({ options: { 'ctx-size': '60000' }, native: 131072, promptPerSecond: 559, budgetSeconds: 120, calibratedCtx: 0 }), []);
});

test('a model that cannot run with its saved settings says so and can start the context measurement', async (t) => {
  const calls = [];
  const f = fixture(t, { calibrateSpy: async (m) => { calls.push(m); return { ok: true, status: 202 }; }, onChat: async () => { throw Error('engine refused'); } });
  await f.manager.autotune.start('synthetic', { confirmPause: true, extendContext: true });
  const job = await finished(f.manager);
  assert.equal(job.status, 'failed');
  assert.equal(job.baselineFailed, true);
  assert.match(job.error, /did not run with its current settings \(context 16384\)/);
  assert.match(job.error, /Measuring the largest context/);
  assert.equal(job.restored, true);
  for (let i = 0; i < 100 && !calls.length; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['synthetic']);
});
