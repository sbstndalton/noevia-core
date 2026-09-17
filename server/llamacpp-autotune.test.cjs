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
  assert.deepEqual(extensions({ options: { 'ctx-size': '32768', 'cache-type-k': 'q8_0' }, native: 262144, promptPerSecond: 100, budgetSeconds: 120, calibratedCtx: 12288 }), []);
  const out = extensions({ options: { 'ctx-size': '8192' }, native: 131072, promptPerSecond: 0, budgetSeconds: 120, calibratedCtx: 16384 });
  assert.deepEqual(out.map((e) => e.id), ['kv-q8']);
  assert.ok(Math.abs(geomean([10, 40]) - 20) < 1e-9);
});
