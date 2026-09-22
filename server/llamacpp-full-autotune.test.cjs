'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createModelManager } = require('./model-manager.cjs');
const { createPresetStore } = require('./llamacpp-presets.cjs');
const { QUALITY, qualityCheck } = require('./llamacpp-full-autotune.cjs');

function fixture(t, { models = ['synthetic'], onChat, badQ4 = true, noHead = false, rejectAll = false, failFinal = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-tune-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ini = path.join(dir, 'models.ini'), stateFile = path.join(dir, 'tune.json');
  const original = 'version = 1\n' + [...models, 'embed'].map(m => `[${m}]\nmodel = /models/${m}.gguf\nctx-size = 8192\nparallel = 1\n`).join('');
  fs.writeFileSync(ini, original);
  const presets = createPresetStore(ini), status = Object.fromEntries([...models, 'embed'].map(m => [m, 'unloaded']));
  const requests = [], options = m => presets.get(m).options;
  let chats = 0, build = 'fake-v1';
  const fetchJson = async (url, opts = {}) => {
    const u = new URL(url), b = opts.body ? JSON.parse(opts.body) : {};
    if (opts.signal?.aborted) throw Error('aborted');
    if (u.pathname === '/models') return { ok: true, body: { data: Object.entries(status).map(([id, value]) => ({ id, status: { value, args: id === 'embed' ? ['--embedding'] : [] }, meta: { n_ctx_train: 16384 } })) } };
    if (u.pathname === '/models/load') { status[b.model] = 'loaded'; return { ok: true, body: {} }; }
    if (u.pathname === '/models/unload') { status[b.model] = 'unloaded'; return { ok: true, body: {} }; }
    if (u.pathname === '/tokenize') return { ok: true, body: { tokens: Array(600).fill(1) } };
    if (u.pathname === '/props') return { ok: true, body: { build_info: build } };
    if (u.pathname === '/v1/chat/completions') {
      chats++; const o = options(b.model), prompt = b.messages[0].content;
      requests.push({ model: b.model, options: { ...o }, prompt });
      await onChat?.({ manager, chats, o, prompt, ini, status, requests });
      if (opts.signal?.aborted) throw Error('aborted');
      const q = QUALITY.find(q => q.prompt === prompt);
      let text = q ? q.expected : prompt.startsWith('List the whole numbers') ? Array.from({ length: 60 }, (_, i) => i + 1).join(', ') : 'Synthetic answer';
      if (q && (rejectAll || (badQ4 && o['cache-type-k'] === 'q4_0'))) text = 'wrong';
      if (failFinal && q && manager.autotune.status().body.job?.phase === 'Verifying saved winner') text = 'wrong';
      const spec = o['spec-type'], draft = spec === 'ngram-simple' || spec === 'draft-mtp' && !noHead;
      const speed = spec === 'draft-mtp' && !noHead ? o['spec-draft-n-max'] === '8' ? 50 : 36 : spec === 'ngram-simple' ? 26 : 20;
      return { ok: true, body: { choices: [{ message: { content: text } }], timings: { predicted_per_second: speed * (o['cache-type-k'] === 'q4_0' ? 2 : o['cache-type-k'] === 'q8_0' ? 1.2 : 1),
        prompt_per_second: o['ubatch-size'] === '1024' ? 800 : 500, draft_n: draft ? 100 : 0, draft_n_accepted: draft ? 65 : 0 } } };
    }
    return { ok: true, body: {} };
  };
  const fetchStream = async (url, opts) => {
    const b = JSON.parse(opts.body), text = b.messages[0].content, marker = /start marker: (CAL-[\d-]+)/.exec(text)[1];
    const o = options(b.model);
    const content = Number(o['ctx-size']) <= (o['cache-type-k'] === 'f16' ? 8192 : 16384) ? marker : 'forgot';
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }], timings: { prompt_n: Math.floor(text.length / 5), prompt_ms: 100, prompt_per_second: 100000 } })}\n\ndata: [DONE]\n\n`);
  };
  const makeManager = () => createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic', presetPath: ini, fetchJson, fetchStream,
    calibrationStatePath: path.join(dir, 'cal.json'), autotuneStatePath: stateFile, autotuneTablePath: path.join(dir, 'table.json'),
    calibrationOptions: { sleep: async () => {}, readMemory: () => 20 },
    autotuneOptions: { sleep: async () => {}, readMemory: () => 20, identityFor: async m => ({ model: m, hardware: 'fake', build }) } });
  let manager = makeManager();
  return { manager, ini, stateFile, original, requests, options, status, restart: () => { manager = makeManager(); return manager; }, setBuild: b => { build = b; } };
}
async function finished(manager) {
  for (let i = 0; i < 15000; i++) {
    const j = manager.autotune.status().body.job;
    if (j && j.status !== 'running') return j;
    await new Promise(r => setImmediate(r));
  }
  throw Error('Tuning did not finish');
}
test('complete pipeline measures all KV profiles, rejects fastest low-quality candidate and applies every setting', async t => {
  const f = fixture(t);
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, ['synthetic']);
  assert.equal((await f.manager.autotune.start('synthetic', { confirmPause: true })).status, 202);
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  assert.equal(j.result.kv, 'q8_0'); assert.equal(j.result.spec, 'mtp-deep');
  assert.equal(j.result.context, 16384); assert.equal(j.result.acceptance, 65);
  assert.equal(j.result.quality.checks.length, 3); assert.equal(j.result.quality.passed, true);
  assert.equal(j.result.generation, 60);
  const o = f.options('synthetic');
  assert.equal(o['ctx-size'], '16384'); assert.equal(o['cache-type-k'], 'q8_0'); assert.equal(o['cache-type-v'], 'q8_0');
  assert.equal(o['spec-type'], 'draft-mtp'); assert.equal(o['spec-draft-n-max'], '8'); assert.equal(o['ubatch-size'], '1024');
  for (const kv of ['f16', 'q8_0', 'q4_0']) assert.ok(f.requests.some(r => r.options['cache-type-k'] === kv));
  assert.equal((await f.manager.autotune.untuned()).body.models.length, 0);
  assert.equal(f.manager.autotune.status('synthetic').body.history.length, 1);
  assert.equal(j.originalText, undefined);
});
test('bulk queue skips embeddings, keeps one maintenance lease and detects stale engine identities', async t => {
  let gateChecks = 0;
  const f = fixture(t, { models: ['one', 'two'], onChat: ({ manager }) => { assert.throws(() => manager.enterInference(), /paused/); gateChecks++; } });
  assert.equal((await f.manager.autotune.start('', { confirmPause: true, untuned: true })).status, 202);
  assert.equal((await f.manager.autotune.start('one', { confirmPause: true })).status, 409);
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error); assert.ok(gateChecks > 30);
  assert.deepEqual(j.queue.map(i => [i.model, i.status]), [['one', 'passed'], ['two', 'passed']]);
  const leave = f.manager.enterInference(); leave();
  assert.equal((await f.manager.autotune.untuned()).body.models.length, 0);
  f.setBuild('fake-v2');
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, ['one', 'two']);
});
test('changed model settings invalidate a tune without modifying other models', async t => {
  const f = fixture(t);
  await f.manager.autotune.start('synthetic', { confirmPause: true }); await finished(f.manager);
  fs.writeFileSync(f.ini, fs.readFileSync(f.ini, 'utf8').replace('ctx-size = 16384', 'ctx-size = 12288'));
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, ['synthetic']);
});
test('cancel restores the full original profile and skips the remaining queue', async t => {
  const f = fixture(t, { models: ['one', 'two'], onChat: ({ manager, chats }) => { if (chats === 10) manager.autotune.cancel(); } });
  await f.manager.autotune.start('', { confirmPause: true, untuned: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'cancelled'); assert.equal(j.restored, true);
  assert.equal(fs.readFileSync(f.ini, 'utf8'), f.original);
  assert.equal(j.queue[1].status, 'skipped');
  assert.equal(f.manager.autotune.status('one').body.history.length, 0);
});
test('external preset edits are preserved and stop the queue', async t => {
  let edited = false;
  const f = fixture(t, { models: ['one', 'two'], onChat: ({ chats, ini }) => {
    if (chats === 10 && !edited) { edited = true; fs.appendFileSync(ini, '\n; external operator edit\n'); }
  } });
  await f.manager.autotune.start('', { confirmPause: true, untuned: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed'); assert.equal(j.restored, false);
  assert.match(fs.readFileSync(f.ini, 'utf8'), /external operator edit/);
  assert.equal(j.queue[1].status, 'skipped');
});
test('failed quality for every candidate restores settings and does not count as tuned', async t => {
  const f = fixture(t, { rejectAll: true });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed'); assert.equal(j.restored, true);
  assert.equal(fs.readFileSync(f.ini, 'utf8'), f.original);
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, ['synthetic']);
});
test('models without an MTP head can choose measured n-gram drafting', async t => {
  const f = fixture(t, { noHead: true });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error); assert.equal(j.result.spec, 'ngram');
});
test('a final-profile quality failure rolls back instead of recording success', async t => {
  const f = fixture(t, { failFinal: true });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed'); assert.equal(j.restored, true);
  assert.equal(fs.readFileSync(f.ini, 'utf8'), f.original);
  assert.equal(f.manager.autotune.status('synthetic').body.history.length, 0);
});
test('restart restores the whole interrupted profile and never resumes inference automatically', async t => {
  const f = fixture(t), presets = createPresetStore(f.ini);
  fs.writeFileSync(f.ini, f.original.replace('ctx-size = 8192', 'ctx-size = 16384'));
  fs.writeFileSync(f.stateFile, JSON.stringify({ history: {}, job: { model: 'synthetic', status: 'running', originalText: f.original,
    lastRevision: presets.snapshot().revision, queue: [{ model: 'synthetic', status: 'running' }], steps: [] } }));
  const manager = f.restart(); await manager.autotune.recover();
  const j = manager.autotune.status().body.job;
  assert.equal(j.status, 'interrupted'); assert.equal(j.restored, true);
  assert.equal(fs.readFileSync(f.ini, 'utf8'), f.original); assert.equal(f.requests.length, 0);
});
test('quality suite requires each independent probe, not agreement with an incorrect baseline', async () => {
  for (const bad of QUALITY) {
    const result = await qualityCheck('x', async (_m, p) => ({ text: p === bad.prompt ? 'wrong' : QUALITY.find(q => q.prompt === p).expected }));
    assert.equal(result.passed, false); assert.equal(result.checks.filter(c => c.passed).length, 2);
  }
});
