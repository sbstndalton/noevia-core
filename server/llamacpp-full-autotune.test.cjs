'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createModelManager } = require('./model-manager.cjs');
const { createPresetStore } = require('./llamacpp-presets.cjs');
const { QUALITY, qualityCheck, qualityFailure, newModel } = require('./llamacpp-full-autotune.cjs');

// #1057: the fake engine's f16 quirks (failLoadF16, badF16, the shorter recall) hold for both
// unquantized cache types, bf16 being the first candidate now.
const unq = o => ['bf16', 'f16'].includes(o['cache-type-k']);
function fixture(t, { badSampling = false, models = ['synthetic'], onChat, onUnload, badQ4 = true, badF16 = false, noHead = false, rejectAll = false, rejectModel = '', badBatch = false, failFinal = false, formattedQuality = false, reasoningOnly = false, truncatedWorkloads = false, idleTimeoutMs = 300000, loseIdentityAfterStart = false, reloadFail = false, unloadPolls = 0, unloadStuck = false, answerFor = null, failLoadF16 = false, failLoadBf16 = false, httpFor = null, chatTemplate = null, servingFor = null, servingChecks = null, autotuneExtra = {}, onLoad = null, loadHang = null, calibrationExtra = {}, loadReply = null, streamReply = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-tune-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ini = path.join(dir, 'models.ini'), stateFile = path.join(dir, 'tune.json');
  const original = 'version = 1\n' + [...models, 'embed'].map(m => `[${m}]\nmodel = /models/${m}.gguf\nctx-size = 8192\nparallel = 1\n`).join('');
  fs.writeFileSync(ini, original);
  const presets = createPresetStore(ini), status = Object.fromEntries([...models, 'embed'].map(m => [m, 'unloaded']));
  const unloading = {};
  const requests = [], servingRequests = [], options = m => presets.get(m).options;
  let chats = 0, build = 'fake-v1', identityReads = 0;
  const fetchJson = async (url, opts = {}) => {
    const u = new URL(url), b = opts.body ? JSON.parse(opts.body) : {};
    if (opts.signal?.aborted) throw Error('aborted');
    if (u.pathname === '/models' && u.searchParams.has('reload')) return { ok: !reloadFail, body: {} };
    if (u.pathname === '/models') return { ok: true, body: { data: Object.entries(status).map(([id, value]) => {
      if (value === 'unloading' && !unloadStuck && --unloading[id] <= 0) status[id] = value = 'unloaded';
      return { id, status: { value, args: id === 'embed' ? ['--embedding'] : [] }, meta: { n_ctx_train: 16384 } };
    }) } };
    if (u.pathname === '/models/load') { onLoad?.({ ...options(b.model) }); const refused = loadReply?.(options(b.model)); if (refused) return refused; if (loadHang?.(options(b.model))) { status[b.model] = 'loading'; return { ok: true, body: {} }; } status[b.model] = (failLoadF16 && unq(options(b.model))) || (options(b.model)['cache-type-k'] === 'bf16' && (failLoadBf16 === true || (typeof failLoadBf16 === 'function' && failLoadBf16(options(b.model))))) ? 'unloaded' : 'loaded'; return { ok: true, body: {} }; }
    if (u.pathname === '/models/unload') { status[b.model] = unloadPolls || unloadStuck ? 'unloading' : 'unloaded'; unloading[b.model] = unloadPolls; onUnload?.({ manager, model: b.model }); return { ok: true, body: {} }; }
    if (u.pathname === '/tokenize') return { ok: true, body: { tokens: Array(600).fill(1) } };
    if (u.pathname === '/props') return { ok: true, body: { build_info: build, ...(chatTemplate ? { chat_template: chatTemplate } : {}) } };
    if (u.pathname === '/v1/chat/completions') {
      // #1003: the serving check is the only request with a system turn.
      if (b.messages[0].role === 'system') { servingRequests.push(b); return servingFor ? servingFor(b) : { ok: true, status: 200, body: { choices: [{ message: { content: 'Synthetic answer' } }] } }; }
      chats++; const o = options(b.model), prompt = b.messages[0].content;
      requests.push({ model: b.model, options: { ...o }, prompt, maxTokens: b.max_tokens, reasoningEffort: b.reasoning_effort });
      await onChat?.({ manager, chats, o, prompt, ini, status, requests });
      if (opts.signal?.aborted) throw Error('aborted');
      const q = QUALITY.find(q => q.prompt === prompt);
      const httpStatus = httpFor?.({ q, o });
      if (httpStatus) return { ok: false, status: httpStatus, body: {} };
      let text = q ? q.expected : prompt.startsWith('List the whole numbers') ? Array.from({ length: 60 }, (_, i) => i + 1).join(', ') : 'Synthetic answer';
      if (q && (rejectAll || (badSampling && o.temp) || b.model === rejectModel || (badF16 && unq(o)) || (badQ4 && ['q5_0', 'q5_1', 'q4_0'].includes(o['cache-type-k'])))) text = 'wrong';
      if (badBatch && q && o['ubatch-size']) text = 'wrong';
      if (failFinal && q && manager.autotune.status().body.job?.phase === 'Verifying saved profile') text = 'wrong';
      if (formattedQuality && q) text = q.id === 'extraction' ? '`' + text + '`' : '**' + text + '**';
      if (q && answerFor) text = answerFor({ q, o, text }) ?? text;
      const spec = o['spec-type'], draft = spec === 'ngram-simple' || spec === 'draft-mtp' && !noHead;
      const speed = spec === 'draft-mtp' && !noHead ? o['spec-draft-n-max'] === '8' ? 50 : 36 : spec === 'ngram-simple' ? 26 : 20;
      return { ok: true, body: { choices: [{ message: { content: reasoningOnly ? '' : text, ...(reasoningOnly ? { reasoning_content: text } : {}) }, ...(reasoningOnly || (truncatedWorkloads && !q) ? { finish_reason: 'length' } : {}) }], timings: { predicted_per_second: speed * (['q5_0', 'q5_1', 'q4_0'].includes(o['cache-type-k']) ? 2 : o['cache-type-k'] === 'q8_0' ? 1.2 : 1),
        prompt_per_second: o['ubatch-size'] === '1024' ? 800 : 500, draft_n: draft ? 100 : 0, draft_n_accepted: draft ? 65 : 0 } } };
    }
    return { ok: true, body: {} };
  };
  const fetchStream = async (url, opts) => {
    const b = JSON.parse(opts.body), text = b.messages[0].content, marker = /start marker: (CAL-[\d-]+)/.exec(text)[1];
    const o = options(b.model);
    const replaced = streamReply?.(o); if (replaced) return replaced;
    const content = Number(o['ctx-size']) <= (unq(o) ? 8192 : 16384) ? marker : 'forgot';
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }], timings: { prompt_n: Math.floor(text.length / 5), prompt_ms: 100, prompt_per_second: 100000 } })}\n\ndata: [DONE]\n\n`);
  };
  const makeManager = () => createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic', presetPath: ini, fetchJson, fetchStream,
    calibrationStatePath: path.join(dir, 'cal.json'), autotuneStatePath: stateFile,
    calibrationOptions: { sleep: async () => {}, readMemory: () => 20, ...calibrationExtra },
    autotuneOptions: { ...autotuneExtra, ...(servingChecks ? { servingChecks } : {}), ...(unloadPolls || unloadStuck ? { sleep: async () => {} } : {}), betweenModelsMs: 25, idleTimeoutMs, readMemory: () => 20, identityFor: async m => (++identityReads > 1 && loseIdentityAfterStart ? null : { model: m, hardware: 'fake', build }) } });
  let manager = makeManager();
  return { manager, ini, stateFile, original, requests, servingRequests, options, status, restart: () => { manager = makeManager(); return manager; }, setBuild: b => { build = b; } };
}
async function finished(manager) {
  for (let i = 0; i < 15000; i++) {
    const j = manager.autotune.status().body.job;
    if (j && j.status !== 'running') return j;
    await new Promise(r => setImmediate(r));
  }
  throw Error('Tuning did not finish');
}

const phase = (item, id) => item.phases.find(p => p.id === id);
test('ordered script commits KV, context, drafting and batch with measured evidence', async t => {
  const f = fixture(t);
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, ['synthetic']);
  assert.equal((await f.manager.autotune.start('synthetic', { confirmPause: true })).status, 202);
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(item.phases.map(p => [p.id, p.status]), [['sampling','passed'],['kv','passed'],['context','passed'],['drafting','passed'],['batch','passed']]);
  // #1057: precision first: bf16 although q8_0 measured faster (the model cannot be sized here).
  assert.equal(item.result.kv, 'bf16'); assert.equal(item.result.spec, 'mtp-deep');
  assert.equal(item.result.context, 8192); assert.equal(item.result.acceptance, 65);
  assert.equal(item.result.generation, 50);
  assert.equal(item.result.ubatch, 1024);
  assert.equal(phase(item, 'kv').steps.find(s => s.id === 'q8_0').status, 'passed');
  assert.deepEqual(phase(item, 'kv').steps.map(s => s.id), ['bf16', 'q8_0']);
  assert.equal(phase(item, 'context').value.context, 8192);
  assert.equal(phase(item, 'drafting').value.spec, 'mtp-deep');
  assert.equal(phase(item, 'batch').value.promptPerSecond, 800);
  const o = f.options('synthetic');
  assert.equal(o['ctx-size'], '8192'); assert.equal(o['cache-type-k'], 'bf16');
  assert.equal(o['spec-type'], 'draft-mtp'); assert.equal(o['ubatch-size'], '1024');
  assert.equal((await f.manager.autotune.untuned()).body.models.length, 0);
  assert.equal(f.manager.autotune.status('synthetic').body.history.length, 1);
  assert.doesNotMatch(JSON.stringify(j), /beforeText|originalText|lastRevision|_revision/);
});

function seedLegacyJob(f, models) {
  const { createPresetStore } = require('./llamacpp-presets.cjs');
  const revision = createPresetStore(f.ini).get('synthetic').revision;
  const job = { id: 'legacy', status: 'interrupted', phase: 'Interrupted', startedAt: Date.now(), finishedAt: Date.now(),
    log: [], _revision: revision, model: models[0], promptBudgetSeconds: 120, bulk: true,
    queueProgress: { done: 0, total: models.length },
    models: models.map(model => newModel(model)) };
  fs.writeFileSync(f.stateFile, JSON.stringify({ history: {}, job }));
  return f.restart();
}

test('a job persisted before this fix that still lists Laya in its queue drops it on resume instead of tuning it', async t => {
  const f = fixture(t, { models: ['synthetic'] });
  const manager = seedLegacyJob(f, ['laya_multilingual_f16', 'synthetic']);
  const r = await manager.autotune.resume({ confirmPause: true });
  assert.equal(r.status, 202);
  assert.deepEqual(r.body.skipped, [{ model: 'laya_multilingual_f16', reason: 'System routing model — not tuned' }]);
  assert.deepEqual(r.body.models.map(m => m.model), ['synthetic']);
  const j = await finished(manager);
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(j.models.map(m => m.model), ['synthetic']);
  assert.ok(!f.requests.some(req => req.model === 'laya_multilingual_f16'), 'Laya must never be loaded or chatted with');
});

test('a job persisted before this fix that lists only Laya finishes cleanly on resume without running anything', async t => {
  const f = fixture(t, { models: ['synthetic'] });
  const manager = seedLegacyJob(f, ['laya_multilingual_f16']);
  const r = await manager.autotune.resume({ confirmPause: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'passed');
  assert.deepEqual(r.body.skipped, [{ model: 'laya_multilingual_f16', reason: 'System routing model — not tuned' }]);
  assert.deepEqual(r.body.models, []);
  assert.equal(f.requests.length, 0);
});

test('Laya is reported as a system model, not a chat model needing tuning, and cannot be started directly', async t => {
  const f = fixture(t, { models: ['synthetic', 'laya_multilingual_f16'] });
  const scan = (await f.manager.autotune.untuned()).body;
  assert.deepEqual(scan.models, ['synthetic']);
  assert.deepEqual(scan.skipped.find(s => s.model === 'laya_multilingual_f16'), { model: 'laya_multilingual_f16', reason: 'System routing model — not tuned' });
  assert.notEqual(scan.skipped.find(s => s.model === 'embed').reason, scan.skipped.find(s => s.model === 'laya_multilingual_f16').reason);
  const r = await f.manager.autotune.start('laya_multilingual_f16', { confirmPause: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'System routing model — not tuned');
});

test('quality rejection followed by asynchronous unload still reaches the next KV candidate', async t => {
  // bf16 is the reference, so the rejected candidate is q8_0 (it breaks arithmetic, which bf16
  // passed); with q5 allowed for this model the run still reaches q5_1 after it.
  const f = fixture(t, { badQ4: false, unloadPolls: 4, answerFor: ({ q, o }) => q.id === 'arithmetic' && o['cache-type-k'] === 'q8_0' ? '61' : null });
  assert.equal(f.manager.autotune.setSettings('synthetic', { allowQ5Kv: true }).status, 200);
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), kv = phase(j.models[0], 'kv');
  assert.equal(j.status, 'passed', j.error);
  assert.equal(kv.steps.find(s => s.id === 'q8_0').status, 'failed');
  assert.match(kv.steps.find(s => s.id === 'q8_0').reason, /arithmetic \(mismatch\)/);
  assert.equal(kv.steps.find(s => s.id === 'q5_1').status, 'passed');
  assert.equal(j.models[0].result.kv, 'bf16');
});

test('an unload that never reaches unloaded stops without writing another profile', async t => {
  const f = fixture(t, { unloadStuck: true });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed');
  assert.match(j.error, /Timed out waiting for router unload: synthetic \(unloading\)/);
  assert.equal(f.options('synthetic')['cache-type-k'], 'bf16');
  assert.ok(f.requests.length > 0 && f.requests.every(r => r.options['cache-type-k'] === 'bf16'), 'only the first candidate was measured');
});

test('cancelling during router unload waits for safe rollback and releases chat', async t => {
  let cancelled = false;
  const f = fixture(t, { unloadPolls: 4, onUnload: ({ manager }) => {
    if (!cancelled) { cancelled = true; manager.autotune.cancel(); }
  } });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(cancelled, true);
  assert.equal(j.status, 'cancelled');
  assert.equal(phase(j.models[0], 'kv').restored, true);
  assert.equal(fs.readFileSync(f.ini, 'utf8'), f.original);
  assert.equal(f.status.synthetic, 'unloaded');
  const leave = f.manager.enterInference(); leave();
});

test('bulk tuning releases the lease between models so a chat can run', async t => {
  const f = fixture(t, { models: ['one', 'two', 'three'] });
  await f.manager.autotune.start('', { confirmPause: true, untuned: true });
  let opened = false;
  for (let i = 0; i < 3000; i++) {
    const j = f.manager.autotune.status().body.job;
    if (j.models[0].status === 'passed' && j.models[1].status === 'pending') {
      const leave = f.manager.enterInference(); leave(); opened = true; break;
    }
    await new Promise(r => setImmediate(r));
  }
  assert.equal(opened, true, 'chat opens between model leases');
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(j.models.map(m => m.status), ['passed','passed','passed']);
  const leave = f.manager.enterInference(); leave();
});

test('model two failure preserves model one and leaves model three for Resume', async t => {
  const f = fixture(t, { models: ['one', 'two', 'three'], rejectModel: 'two' });
  await f.manager.autotune.start('', { confirmPause: true, untuned: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed');
  assert.deepEqual(j.models.map(m => m.status), ['passed', 'failed', 'pending']);
  assert.equal(f.options('one')['ctx-size'], '8192');
  assert.equal(f.options('one')['cache-type-k'], 'bf16');
  assert.equal(f.options('one')['spec-type'], 'draft-mtp');
  assert.equal(f.options('two')['ctx-size'], '8192');
  assert.equal(f.options('three')['ctx-size'], '8192');
});

test('busy chat makes start wait, with cancellable bounded idle acquisition', async t => {
  const f = fixture(t, { idleTimeoutMs: 20 }), leave = f.manager.enterInference();
  assert.equal((await f.manager.autotune.start('synthetic', { confirmPause: true })).status, 202);
  assert.equal(f.manager.autotune.status().body.job.waiting, true);
  const timedOut = await finished(f.manager);
  assert.equal(timedOut.status, 'interrupted');
  assert.match(timedOut.error, /Timed out waiting/);
  leave();
  assert.equal((await f.manager.autotune.resume({ confirmPause: true })).status, 202);
  assert.equal((await finished(f.manager)).status, 'passed');
  const second = fixture(t), busy = second.manager.enterInference();
  await second.manager.autotune.start('synthetic', { confirmPause: true });
  second.manager.autotune.cancel();
  assert.equal((await finished(second.manager)).status, 'cancelled');
  busy();
  const chat = second.manager.enterInference(); chat();
});

test('unreadable identity after acceptance stops before writing a trial profile', async t => {
  const f = fixture(t, { loseIdentityAfterStart: true });
  assert.equal((await f.manager.autotune.start('synthetic', { confirmPause: true })).status, 202);
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed'); assert.match(j.error, /identity could not be read/);
  assert.equal(fs.readFileSync(f.ini, 'utf8'), f.original);
  assert.equal(f.requests.length, 0);
});

test('cancel during drafting keeps committed KV/context and Resume starts at drafting', async t => {
  let stopped = false;
  const f = fixture(t, { onChat: ({ manager }) => {
    const j = manager.autotune.status().body.job;
    if (!stopped && j?.phase === 'Drafting') { stopped = true; manager.autotune.cancel(); }
  } });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'cancelled');
  assert.deepEqual(j.models[0].phases.slice(0,2).map(p => p.status), ['passed','passed']);
  assert.equal(phase(j.models[0], 'drafting').status, 'interrupted');
  assert.equal(f.options('synthetic')['cache-type-k'], 'bf16');
  assert.equal(f.options('synthetic')['ctx-size'], '8192');
  assert.equal(f.manager.autotune.status().body.history.length, 0);
  const before = f.requests.length;
  assert.equal((await f.manager.autotune.resume({ confirmPause: true })).status, 202);
  const resumed = await finished(f.manager);
  assert.equal(resumed.status, 'passed', resumed.error);
  assert.ok(f.requests.length > before);
  assert.equal(resumed.models[0].phases[0].status, 'passed');
  assert.equal(resumed.models[0].phases[1].status, 'passed');
  assert.equal(resumed.models[0].result.spec, 'mtp-deep');
  assert.equal((await f.manager.autotune.resume()).status, 400, 'resuming requires renewed pause confirmation');
});

test('batch quality failure restores only batch settings and leaves prior phase commits', async t => {
  const f = fixture(t, { badBatch: true });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'failed');
  assert.equal(phase(item, 'batch').status, 'failed');
  assert.equal(phase(item, 'batch').restored, true);
  assert.deepEqual(item.phases.slice(0,3).map(p => p.status), ['passed','passed','passed']);
  assert.equal(f.options('synthetic')['cache-type-k'], 'bf16');
  assert.equal(f.options('synthetic')['ctx-size'], '8192');
  assert.equal(f.options('synthetic')['spec-type'], 'draft-mtp');
  assert.equal(f.options('synthetic')['ubatch-size'], undefined);
  assert.equal(f.manager.autotune.status('synthetic').body.history.length, 0);
});

test('external preset edit stops rollback and Resume, preserving the operator text', async t => {
  let edited = false;
  const f = fixture(t, { onChat: ({ manager, ini }) => {
    if (!edited && manager.autotune.status().body.job?.phase === 'Batch and micro-batch') {
      edited = true; fs.appendFileSync(ini, '\n; external operator edit\n');
    }
  } });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed'); assert.match(j.error, /inspect models.ini/);
  assert.match(fs.readFileSync(f.ini, 'utf8'), /external operator edit/);
  assert.equal(j.models[0].phases[0].status, 'passed');
  assert.equal((await f.manager.autotune.resume({ confirmPause: true })).status, 409);
});

test('restart rolls back active phase only, then explicit Resume skips committed phases', async t => {
  let stopped = false;
  const f = fixture(t, { onChat: ({ manager }) => {
    if (!stopped && manager.autotune.status().body.job?.phase === 'Drafting') { stopped = true; manager.autotune.cancel(); }
  } });
  await f.manager.autotune.start('synthetic', { confirmPause: true }); await finished(f.manager);
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  const item = state.job.models[0], draft = phase(item, 'drafting');
  const beforeText = fs.readFileSync(f.ini, 'utf8');
  const store = createPresetStore(f.ini);
  const probe = store.prepare({ model: 'synthetic', baseRevision: store.snapshot().revision, options: { 'spec-type': 'ngram-simple' } });
  await store.commit(probe);
  state.job._revision = store.snapshot().revision;
  state.job.status = 'running'; item.status = 'running'; draft.status = 'running'; draft._beforeText = beforeText;
  fs.writeFileSync(f.stateFile, JSON.stringify(state));
  const manager = f.restart(); await manager.autotune.recover();
  const j = manager.autotune.status().body.job;
  assert.equal(j.status, 'interrupted'); assert.equal(phase(j.models[0], 'drafting').restored, true);
  assert.equal(fs.readFileSync(f.ini, 'utf8'), beforeText);
  const before = f.requests.length;
  assert.equal((await manager.autotune.resume({ confirmPause: true })).status, 202);
  const end = await finished(manager);
  assert.equal(end.status, 'passed', end.error);
  assert.deepEqual(end.models[0].phases.slice(0,2).map(p => p.status), ['passed','passed']);
  assert.ok(f.requests.length > before);
});

test('restart after every phase commit reloads and qualifies the saved profile before reporting success', async t => {
  const f = fixture(t);
  await f.manager.autotune.start('synthetic', { confirmPause: true }); await finished(f.manager);
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  state.job.status = 'running'; state.job.models[0].status = 'running';
  delete state.job.models[0].result;
  state.history = {};
  fs.writeFileSync(f.stateFile, JSON.stringify(state));
  f.status.synthetic = 'unloaded';
  const before = f.requests.length;
  const manager = f.restart(); await manager.autotune.recover();
  assert.equal(manager.autotune.status().body.job.status, 'interrupted');
  assert.equal((await manager.autotune.resume({ confirmPause: true })).status, 202);
  const resumed = await finished(manager);
  assert.equal(resumed.status, 'passed', resumed.error);
  assert.ok(f.requests.length >= before + 6, 'final quality and throughput run after restart');
  assert.equal(f.status.synthetic, 'loaded');
  assert.equal(resumed.models[0].result.loaded, true);
});

test('legacy running journal restores only after unloading and confirmed reload', async t => {
  for (const reloadFail of [false, true]) {
    const f = fixture(t, { reloadFail });
    const before = f.original;
    fs.writeFileSync(f.ini, before.replace('ctx-size = 8192', 'ctx-size = 16384'));
    f.status.synthetic = 'loaded';
    const revision = createPresetStore(f.ini).snapshot().revision;
    fs.writeFileSync(f.stateFile, JSON.stringify({ history: {}, job: {
      id: 'legacy', model: 'synthetic', status: 'running', originalText: before, lastRevision: revision,
      queue: [{ model: 'synthetic', status: 'running' }], steps: [],
    } }));
    const manager = f.restart();
    assert.doesNotMatch(JSON.stringify(manager.autotune.status().body.job), /originalText|lastRevision|version = 1/);
    await manager.autotune.recover();
    const j = manager.autotune.status().body.job;
    assert.equal(j.status, 'interrupted');
    assert.equal(j.restored, !reloadFail);
    assert.equal(f.status.synthetic, 'unloaded');
    assert.equal(fs.readFileSync(f.ini, 'utf8'), before);
    assert.equal((await manager.autotune.resume({ confirmPause: true })).status, 409);
  }
});

test('engine identity and setting edits invalidate previously complete tunes', async t => {
  const f = fixture(t);
  await f.manager.autotune.start('synthetic', { confirmPause: true }); await finished(f.manager);
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, []);
  f.setBuild('fake-v2');
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, ['synthetic']);
  f.setBuild('fake-v1');
  fs.writeFileSync(f.ini, fs.readFileSync(f.ini, 'utf8').replace(/\[synthetic\]([^[]*?)ctx-size = 8192/, '[synthetic]$1ctx-size = 12288'));
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, ['synthetic']);
});

test('#1060 the tune signature follows the list the run used: q5 on makes a default tune stale, off makes a q5 tune stale', async t => {
  const f = fixture(t);
  await f.manager.autotune.start('synthetic', { confirmPause: true }); await finished(f.manager);
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, []);
  assert.equal(f.manager.autotune.setSettings('synthetic', { allowQ5Kv: true }).status, 200);
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, ['synthetic']);
  await f.manager.autotune.start('synthetic', { confirmPause: true }); await finished(f.manager);
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, [], 'tuned with q5 allowed, the switch still on');
  f.manager.autotune.setSettings('synthetic', { allowQ5Kv: false });
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, ['synthetic'], 'a q5 tune is stale once q5 is off');
});

test('#1060 the switch cannot change under a queued model; after the job, the change makes it untuned', async t => {
  const tried = [];
  const f = fixture(t, { models: ['one', 'two'], onChat: ({ manager }) => {
    if (!tried.length && manager.autotune.status().body.job?.model === 'one') tried.push(manager.autotune.setSettings('two', { allowQ5Kv: true }).status);
  } });
  await f.manager.autotune.start('', { confirmPause: true, untuned: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(tried, [409]);
  assert.deepEqual(j.models.map(m => m.kv), [['bf16', 'q8_0'], ['bf16', 'q8_0']]);
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, []);
  assert.equal(f.manager.autotune.setSettings('two', { allowQ5Kv: true }).status, 200);
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, ['two']);
});

test('a model without an MTP head chooses measured n-gram drafting', async t => {
  const f = fixture(t, { noHead: true });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  assert.equal(j.models[0].result.spec, 'ngram');
});

test('final saved-profile quality failure does not publish a successful tune', async t => {
  const f = fixture(t, { failFinal: true });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed');
  assert.deepEqual(j.models[0].phases.map(p => p.status), ['passed','passed','passed','passed','passed']);
  assert.equal(j.models[0].result, undefined);
  assert.equal(f.manager.autotune.status('synthetic').body.history.length, 0);
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, ['synthetic']);
});

test('identity change during final validation does not publish measurements', async t => {
  let f, changed = false;
  f = fixture(t, { onChat: ({ manager }) => {
    if (!changed && manager.autotune.status().body.job?.phase === 'Verifying saved profile') {
      f.setBuild('fake-v2'); changed = true;
    }
  } });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(changed, true);
  assert.equal(j.status, 'failed');
  assert.match(j.error, /identity changed/i);
  assert.equal(j.models[0].result, undefined);
  assert.equal(f.manager.autotune.status('synthetic').body.history.length, 0);
});

test('quality suite requires each independent probe', async () => {
  for (const bad of QUALITY) {
    const result = await qualityCheck('x', async (_m, p) => ({ text: p === bad.prompt ? 'wrong' : QUALITY.find(q => q.prompt === p).expected }));
    assert.equal(result.passed, false); assert.equal(result.checks.filter(c => c.passed).length, 2);
  }
});

test('quality diagnostics identify an upstream error and truncated response without storing generated text', async () => {
  const result = await qualityCheck('x', async (_m, prompt) => prompt === QUALITY[0].prompt
    ? { failure: 'HTTP 503' } : prompt === QUALITY[1].prompt
      ? { text: 'AX', finishReason: 'length' } : { text: QUALITY[2].expected });
  assert.deepEqual(result.checks, [
    { id: 'arithmetic', passed: false, reason: 'HTTP 503' },
    { id: 'extraction', passed: false, reason: 'truncated' },
    { id: 'reasoning', passed: true },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /AX|503 response body/);
});

test('quality accepts only a complete, unambiguous answer with benign markdown wrapping', async () => {
  const wrapped = ['**59**', '`AX-417`', '**no.**'];
  const ok = await qualityCheck('Gemma-4-E2B-it-GGUF', async (_m, prompt) => ({ text: wrapped[QUALITY.findIndex(q => q.prompt === prompt)] }));
  assert.equal(ok.passed, true);
  for (const answer of ['59, but the answer is 58', '59 58', 'The answer is 59', '**59** and 58']) {
    const result = await qualityCheck('Gemma-4-E2B-it-GGUF', async (_m, prompt) => ({ text: prompt === QUALITY[0].prompt ? answer : QUALITY.find(q => q.prompt === prompt).expected }));
    assert.deepEqual(result.checks[0], { id: 'arithmetic', passed: false, reason: 'mismatch', answer });
  }
  const reasoningOnly = await qualityCheck('gpt-oss-20b', async (_m, prompt) => ({ text: '', reasoningContent: QUALITY.find(q => q.prompt === prompt).expected, finishReason: 'length' }));
  assert.equal(reasoningOnly.passed, false, 'analysis text is never proof of a correct final answer');
  const cappedProbe = await qualityCheck('gpt-oss-20b', async (_m, prompt) => ({ text: QUALITY.find(q => q.prompt === prompt).expected, finishReason: 'length' }));
  assert.equal(cappedProbe.passed, false, 'even a correct-looking final answer cannot pass a truncated quality probe');
  assert.ok(cappedProbe.checks.every(check => check.reason === 'truncated'));
});

test('gpt-oss quality probes ask for bounded low reasoning effort while other model probes stay short', async t => {
  const f = fixture(t, { models: ['gpt-oss-20b'] });
  await f.manager.autotune.start('gpt-oss-20b', { confirmPause: true });
  const job = await finished(f.manager);
  assert.equal(job.status, 'passed', job.error);
  const probes = f.requests.filter(r => QUALITY.some(q => q.prompt === r.prompt));
  assert.ok(probes.length >= 3);
  assert.ok(probes.every(r => r.maxTokens === 512 && r.reasoningEffort === 'low'));
  const workload = f.requests.find(r => !QUALITY.some(q => q.prompt === r.prompt));
  assert.ok(workload && workload.reasoningEffort === 'low' && workload.maxTokens === 512);
  assert.ok(f.requests.filter(r => r.prompt.startsWith('The garden committee')).every(r => r.maxTokens === 16), 'batch prompt timing remains short');
  const budgets = [];
  await qualityCheck('GPT-OSS20B-Q4', async (_m, _p, max) => { budgets.push(max); return { text: 'wrong' }; });
  assert.deepEqual(budgets, [512, 512, 512]);
});

test('Gemma formatted final answers can finish tuning without weakening the quality gate', async t => {
  const f = fixture(t, { models: ['Gemma-4-E2B-it-GGUF'], formattedQuality: true });
  await f.manager.autotune.start('Gemma-4-E2B-it-GGUF', { confirmPause: true });
  const job = await finished(f.manager);
  assert.equal(job.status, 'passed', job.error);
  assert.ok(f.requests.filter(r => QUALITY.some(q => q.prompt === r.prompt)).every(r => r.maxTokens === 64 && r.reasoningEffort === undefined));
});

test('reasoning-only gpt-oss output fails all quality candidates and restores the profile', async t => {
  const f = fixture(t, { models: ['gpt-oss-20b'], reasoningOnly: true });
  await f.manager.autotune.start('gpt-oss-20b', { confirmPause: true });
  const job = await finished(f.manager);
  assert.equal(job.status, 'failed');
  // #328: the baseline taken before sampling already fails every probe, so the optional sampling
  // phase cannot swallow it and nothing further is measured.
  assert.match(job.error, /^The model failed every quality probe at its reference settings/);
  assert.equal(job.models[0].phases[0].status, 'failed');
  assert.equal(job.models[0].phases[1].status, 'pending');
  assert.equal(job.models[0].phases[0].restored, true);
  assert.equal(fs.readFileSync(f.ini, 'utf8'), f.original);
  assert.equal(job.models[0].result, undefined);
  assert.equal(f.manager.autotune.status('gpt-oss-20b').body.history.length, 0);
});

test('capped nonempty throughput samples remain measurable after independent quality probes pass', async t => {
  const f = fixture(t, { truncatedWorkloads: true });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const job = await finished(f.manager);
  assert.equal(job.status, 'passed', job.error);
  assert.equal(job.models[0].result.generation, 50);
});

test('#1057 KV phase offers bf16 and q8_0 by default: q8_0 is the floor, no q5 or q4 without opt-ins', async t => {
  const f = fixture(t, { badQ4: false }); // q5/q4 would pass quality here and be fastest
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(phase(item, 'kv').steps.map(s => s.id), ['bf16', 'q8_0']);
  assert.ok(!f.requests.some(r => ['q5_1', 'q5_0', 'q4_0', 'f16'].includes(r.options['cache-type-k'])), 'no type below the floor, and no f16, is ever loaded');
  assert.equal(item.result.kv, 'bf16');
});

test('#1057 the override env var alone adds nothing; with the model\'s q5 opt-in it adds q4_0 last', async t => {
  const prior = process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV;
  process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV = '1';
  t.after(() => { if (prior === undefined) delete process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV; else process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV = prior; });
  const f = fixture(t);
  assert.deepEqual(f.manager.autotune.status('synthetic').body.kvCandidates, ['bf16', 'q8_0']);
  f.manager.autotune.setSettings('synthetic', { allowQ5Kv: true });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.deepEqual(phase(item, 'kv').steps.map(s => s.id), ['bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_0']);
});

test('KV floor override env var is off by default (no override, no q4_0 candidate)', async t => {
  delete process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV;
  const f = fixture(t);
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.ok(!phase(item, 'kv').steps.some(s => s.id === 'q4_0'));
});

test('sampling step skips with a reason when no family or card recommends values', async t => {
  const f = fixture(t);
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const item = (await finished(f.manager)).models[0], p = phase(item, 'sampling');
  assert.equal(p.status, 'passed'); assert.equal(p.value.skipped, true);
  assert.equal(p.steps[0].status, 'skipped'); assert.equal(item.result.sampling.skipped, true);
  for (const k of ['temp', 'top-p', 'top-k', 'min-p', 'repeat-penalty']) assert.equal(f.options('synthetic')[k], undefined);
});

test('sampling step applies the family recommendation through the preset write path and records its source', async t => {
  const f = fixture(t, { models: ['Qwen3-8B-Instruct'] });
  await f.manager.autotune.start('Qwen3-8B-Instruct', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0], p = phase(item, 'sampling');
  assert.equal(j.status, 'passed', j.error);
  const o = f.options('Qwen3-8B-Instruct');
  assert.equal(o.temp, '0.6');
  assert.deepEqual([o['top-p'], o['top-k'], o['min-p']], ['0.95', '20', '0']);
  assert.equal(p.value.applied, true); assert.equal(p.value.tier, 'family'); assert.equal(p.value.family, 'qwen3');
  assert.match(p.value.source, /Qwen3 family table/);
  assert.equal(item.result.sampling.tier, 'family');
  // The later phases keep the sampling keys they did not touch.
  assert.equal(o['cache-type-k'], 'bf16');
});

test('a failing sampling probe restores models.ini exactly, records why, and the tune carries on to complete', async t => {
  const f = fixture(t, { models: ['Qwen3-8B-Instruct'], badSampling: true });
  let atKv = null;
  await f.manager.autotune.start('Qwen3-8B-Instruct', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0], p = phase(item, 'sampling');
  assert.equal(j.status, 'passed', j.error);
  assert.equal(p.status, 'passed'); assert.equal(p.value.skipped, true); assert.equal(p.value.failed, true);
  assert.match(p.value.reason, /Quality checks failed/); assert.equal(p.steps[0].status, 'failed');
  assert.equal(phase(item, 'kv').status, 'passed'); assert.equal(item.result.kv, 'bf16');
  assert.equal(item.result.sampling.failed, true);
  const o = f.options('Qwen3-8B-Instruct');
  for (const k of ['temp', 'top-p', 'top-k', 'min-p', 'repeat-penalty']) assert.equal(o[k], undefined, k);
  // Restored byte-identically before KV ran: the first KV probe saw no sampling keys.
  atKv = f.requests.find(r => r.options['cache-type-k'] === 'bf16');
  assert.equal(atKv.options.temp, undefined);
  assert.ok(j.log.some(l => /models\.ini was restored/.test(l.text)));
});

test('a sampling failure that cannot be restored still stops the job as unsafe', async t => {
  let edited = false;
  const f = fixture(t, { models: ['Qwen3-8B-Instruct'], badSampling: true, onChat: ({ ini, o }) => { if (o.temp && !edited) { edited = true; fs.appendFileSync(ini, '\n; external operator edit\n'); } } });
  await f.manager.autotune.start('Qwen3-8B-Instruct', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed');
  assert.match(j.error, /inspect models.ini/);
  assert.equal(phase(j.models[0], 'sampling').status, 'failed');
  assert.equal(phase(j.models[0], 'kv').status, 'pending');
  assert.match(fs.readFileSync(f.ini, 'utf8'), /external operator edit/);
});

test('sampling step never overwrites sampling an operator already set, per model or in the defaults', async t => {
  for (const [label, edit] of [
    ['model', text => text.replace('parallel = 1', 'parallel = 1\ntemp = 0.3')],
    ['defaults', text => text.replace('version = 1\n', 'version = 1\n[*]\ntop-k = 40\n')],
  ]) {
    const f = fixture(t, { models: ['Qwen3-8B-Instruct'] });
    const edited = edit(f.original); assert.notEqual(edited, f.original, label);
    fs.writeFileSync(f.ini, edited);
    const start = await f.manager.autotune.start('Qwen3-8B-Instruct', { confirmPause: true });
    assert.equal(start.status, 202, label);
    const j = await finished(f.manager), p = phase(j.models[0], 'sampling');
    assert.equal(j.status, 'passed', j.error);
    assert.equal(p.value.skipped, true, label); assert.match(p.value.reason, /already set/);
    assert.equal(f.options('Qwen3-8B-Instruct')['top-p'], undefined, label);
  }
});

test('shared family table drives the gpt-oss reasoning budget, and its sampling is applied too', async t => {
  const f = fixture(t, { models: ['gpt-oss-20b'] });
  await f.manager.autotune.start('gpt-oss-20b', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  assert.equal(phase(j.models[0], 'sampling').value.family, 'gpt-oss');
  assert.equal(f.options('gpt-oss-20b').temp, '1');
  const probes = f.requests.filter(r => QUALITY.some(q => q.prompt === r.prompt));
  assert.ok(probes.length > 0 && probes.every(r => r.reasoningEffort === 'low' && r.maxTokens === 512));
});

test('#545: the bulk untuned list skips presets whose model file is missing, and keeps the rest', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-tune-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { createFullAutotuner } = require('./llamacpp-full-autotune.cjs');
  const rows = [{ id: 'present', source: 'preset', status: { args: [] } }, { id: 'ghost', source: 'preset', status: { args: [] } }];
  const presets = { get: () => ({ exists: true, options: {}, defaults: {} }), files: () => ({}) };
  const build = fileMissing => createFullAutotuner({ request: async () => ({ ok: true, body: {} }), rawModels: async () => ({ ok: true, body: { data: rows } }), presets,
    maintenance: {}, applyUnlocked: async () => ({ ok: true }), identityFor: async m => ({ model: m }), stateFile: path.join(dir, 'tune.json'), ...(fileMissing ? { fileMissing } : {}) });
  assert.deepEqual((await build().untuned()).body.models, ['present', 'ghost'], 'default: nothing is treated as missing');
  const scan = (await build(row => row.id === 'ghost').untuned()).body;
  assert.deepEqual(scan.models, ['present']);
  assert.deepEqual(scan.skipped, [{ model: 'ghost', reason: 'Model file missing from the models folder' }]);
});

test('arithmetic accepts a worked line ending in the expected value but never an ambiguous reply', async () => {
  const run = (text, id = 'arithmetic') => qualityCheck('Gemma-4-E2B-it-GGUF', async (_m, prompt) => {
    const q = QUALITY.find(c => c.prompt === prompt);
    return { text: q.id === id ? text : q.expected };
  });
  for (const good of ['68 - 9 = 59', '(17 * 4) - 9 = 68 - 9 = 59', '59.', '**68 - 9 = 59**', '17 × 4 - 9 = 59'])
    assert.equal((await run(good)).passed, true, good);
  for (const bad of ['59 or 61', 'not 59, it\'s 61', '68 - 9 = 61', '59 = 59 or 61', 'The answer is 59', '68 - 9 = 59 or 61'])
    assert.equal((await run(bad)).checks[0].reason, 'mismatch', bad);
  assert.equal((await run('x = AX-417', 'extraction')).checks[1].reason, 'mismatch', 'other probes stay strict');
  assert.equal((await run('yes = no', 'reasoning')).checks[2].reason, 'mismatch');
});

test('a mismatch records a short sanitized answer snippet in the failure text', async () => {
  const q = await qualityCheck('x', async (_m, prompt) => prompt === QUALITY[0].prompt
    ? { text: 'It is\n\u0007sixty\u0000-one, roughly, give or take a few more' } : { text: QUALITY.find(c => c.prompt === prompt).expected });
  const a = q.checks[0].answer;
  assert.ok(a.length <= 24); assert.doesNotMatch(a, /[\u0000-\u001f]/); assert.match(a, /^It is sixty/);
  assert.match(qualityFailure(q), /^Quality checks failed: arithmetic \(mismatch\)\. Answered arithmetic: "It is sixty[^"]*"\.$/);
  assert.equal(qualityFailure({ checks: [{ id: 'arithmetic', passed: false, reason: 'truncated' }] }), 'Quality checks failed: arithmetic (truncated).');
});

// #328: the quality gate is relative to the model's own baseline at its reference settings.
const probeRequests = (f, id) => f.requests.filter(r => r.prompt === QUALITY.find(q => q.id === id).prompt);
// The 2026-09-30 E2B run: a plain wrong "69" for arithmetic at every setting, the other probes fine.
const e2b = ({ q }) => q.id === 'arithmetic' ? '69' : null;

test('#328 baseline passing every probe reuses the bf16 candidate instead of loading a reference as well', async t => {
  const f = fixture(t);
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(item.baseline, { reference: 'bf16', probes: ['arithmetic', 'extraction', 'reasoning'], skipped: [] });
  // One probe set at bf16 (the KV candidate, which is the baseline), none at f16 or measured separately.
  const beforeQ8 = f.requests.slice(0, f.requests.findIndex(r => r.options['cache-type-k'] === 'q8_0'));
  assert.equal(beforeQ8.filter(r => r.options['cache-type-k'] === 'bf16' && QUALITY.some(q => q.prompt === r.prompt)).length, 3);
  assert.ok(!f.requests.some(r => r.options['cache-type-k'] === 'f16'));
  assert.equal(phase(item, 'kv').steps.find(s => s.id === 'bf16').status, 'passed');
  assert.ok(j.log.some(l => /^Quality baseline at bf16 KV cache, drafting off: arithmetic passed, extraction passed, reasoning passed\.$/.test(l.text)));
  assert.deepEqual(item.result.baseline, item.baseline);
});

test('#328 a probe the model fails at its reference settings is skipped, and the tune completes on the others', async t => {
  const f = fixture(t, { answerFor: e2b });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(item.baseline, { reference: 'bf16', probes: ['extraction', 'reasoning'], skipped: [{ id: 'arithmetic', reason: 'mismatch', answer: '69' }] });
  assert.equal(probeRequests(f, 'arithmetic').length, 1, 'arithmetic is asked once, for the baseline, then never again');
  assert.ok(probeRequests(f, 'extraction').length > 5, 'the discriminative probes still gate every later step');
  assert.deepEqual(item.phases.map(p => p.status), ['passed', 'passed', 'passed', 'passed', 'passed']);
  assert.equal(item.result.kv, 'bf16');
  assert.deepEqual(item.result.quality.skipped, ['arithmetic']);
  assert.ok(item.result.quality.checks.every(c => c.id !== 'arithmetic' && c.passed));
  assert.ok(j.log.some(l => l.text.includes('arithmetic skipped (the model gets this wrong at its reference settings; answered "69")')));
});

test('#328 a candidate that breaks a probe the baseline passed still fails', async t => {
  const f = fixture(t, { badQ4: false, answerFor: ({ q, o }) => e2b({ q }) ?? (q.id === 'extraction' && o['cache-type-k'] === 'q5_0' ? 'AX-471' : null) });
  f.manager.autotune.setSettings('synthetic', { allowQ5Kv: true });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), kv = phase(j.models[0], 'kv');
  assert.equal(j.status, 'passed', j.error);
  const q50 = kv.steps.find(s => s.id === 'q5_0');
  assert.equal(q50.status, 'failed');
  assert.equal(q50.reason, 'Quality checks failed: extraction (mismatch). Answered extraction: "AX-471".');
  assert.equal(kv.steps.find(s => s.id === 'q5_1').status, 'passed');
  assert.equal(j.models[0].result.kv, 'bf16');
});

test('#328 a model that fails every probe at its reference settings stops with a clear reason', async t => {
  const f = fixture(t, { rejectAll: true });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), kv = phase(j.models[0], 'kv');
  assert.equal(j.status, 'failed');
  assert.match(j.error, /^The model failed every quality probe at its reference settings/);
  assert.match(j.error, /arithmetic \(mismatch\), extraction \(mismatch\), reasoning \(mismatch\)/);
  assert.equal(kv.status, 'failed'); assert.equal(kv.restored, true);
  assert.deepEqual(kv.steps.map(s => s.status), ['failed', 'pending'], 'no further candidate is measured');
  assert.deepEqual(j.models[0].baseline.probes, []);
  assert.equal(fs.readFileSync(f.ini, 'utf8'), f.original);
  // Resume measures the baseline again rather than trusting the empty one.
  const before = f.requests.length;
  assert.equal((await f.manager.autotune.resume({ confirmPause: true })).status, 202);
  const again = await finished(f.manager);
  assert.equal(again.status, 'failed');
  assert.equal(f.requests.length - before, 3);
});

test('#328 with sampling to apply, the baseline is measured first at f16 and the KV and drafting keys are put back', async t => {
  const f = fixture(t, { models: ['Qwen3-8B-Instruct'], answerFor: e2b });
  await f.manager.autotune.start('Qwen3-8B-Instruct', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  // The sampling step is judged on extraction and reasoning, so the E2B-style "69" no longer blocks it.
  assert.equal(phase(item, 'sampling').value.applied, true);
  assert.equal(item.baseline.reference, 'f16');
  assert.deepEqual(item.baseline.skipped.map(s => s.id), ['arithmetic']);
  const first = f.requests[0];
  assert.equal(first.options['cache-type-k'], 'f16'); assert.equal(first.options['spec-type'], 'none'); assert.equal(first.options.temp, undefined);
  // The sampling probe ran on the profile as it was (no KV keys), not on the baseline's f16.
  const samplingProbe = f.requests.find(r => r.options.temp);
  assert.equal(samplingProbe.options['cache-type-k'], undefined); assert.equal(samplingProbe.options['spec-type'], undefined);
  assert.equal(probeRequests(f, 'arithmetic').length, 1);
});

test('#328 when f16 does not load, the baseline comes from the current settings', async t => {
  const f = fixture(t, { failLoadF16: true, answerFor: e2b });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.equal(item.baseline.reference, 'current');
  assert.deepEqual(item.baseline.probes, ['extraction', 'reasoning']);
  assert.equal(phase(item, 'kv').steps.find(s => s.id === 'bf16').status, 'failed');
  // bf16 failed, so the floor: q8_0.
  assert.equal(item.result.kv, 'q8_0');
  assert.ok(j.log.some(l => /^Quality baseline at the current settings, drafting off:/.test(l.text)));
});

test('#328 an engine error during the baseline never marks a probe as one the model gets wrong', async t => {
  // bf16 (and f16) load but the engine errors on one probe: those runs cannot be the baseline, so
  // the current settings supply it, with every probe still counted.
  const f = fixture(t, { httpFor: ({ q, o }) => q?.id === 'extraction' && unq(o) ? 500 : 0 });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(item.baseline, { reference: 'current', probes: ['arithmetic', 'extraction', 'reasoning'], skipped: [] });
  assert.match(phase(item, 'kv').steps.find(s => s.id === 'bf16').reason, /extraction \(HTTP 500\)/);
});

test('#328 qualityCheck sends only the probes the baseline passed and reports the rest as skipped', async () => {
  const baseline = { reference: 'f16', probes: ['extraction', 'reasoning'], skipped: [{ id: 'arithmetic', reason: 'mismatch', answer: '69' }] };
  const asked = [];
  const q = await qualityCheck('x', async (_m, prompt) => { const c = QUALITY.find(c => c.prompt === prompt); asked.push(c.id); return { text: c.expected }; }, baseline);
  assert.deepEqual(asked, ['extraction', 'reasoning']);
  assert.deepEqual(q, { passed: true, checks: [{ id: 'extraction', passed: true }, { id: 'reasoning', passed: true }], skipped: ['arithmetic'] });
  // No baseline (an older resumed job): every probe is required, as before.
  const all = await qualityCheck('x', async (_m, prompt) => ({ text: prompt === QUALITY[0].prompt ? '69' : QUALITY.find(c => c.prompt === prompt).expected }));
  assert.equal(all.passed, false); assert.equal(all.skipped, undefined);
});

test('#328 status reports the KV candidates this server really tries', async t => {
  delete process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV;
  const f = fixture(t);
  assert.deepEqual(f.manager.autotune.status('synthetic').body.kvCandidates, ['bf16', 'q8_0']);
  assert.deepEqual(f.manager.autotune.status('synthetic').body.settings, { allowQ5Kv: false });
  f.manager.autotune.setSettings('synthetic', { allowQ5Kv: true });
  assert.deepEqual(f.manager.autotune.status('synthetic').body.kvCandidates, ['bf16', 'q8_0', 'q5_1', 'q5_0']);
  assert.deepEqual(f.manager.autotune.status('synthetic').body.settings, { allowQ5Kv: true });
  // Per model: another model keeps the default list.
  assert.deepEqual(f.manager.autotune.status('embed').body.kvCandidates, ['bf16', 'q8_0']);
  process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV = '1';
  t.after(() => { delete process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV; });
  assert.deepEqual(f.manager.autotune.status('synthetic').body.kvCandidates, ['bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_0']);
});

test('#872 between model leases the gate is open but the folder sync still sees auto-tune running', async t => {
  const f = fixture(t, { models: ['one', 'two'] });
  assert.equal(f.manager.tuningActive(), false);
  await f.manager.autotune.start('', { confirmPause: true, untuned: true });
  let between = false;
  for (let i = 0; i < 3000; i++) {
    const j = f.manager.autotune.status().body.job;
    if (j.models[0].status === 'passed' && j.models[1].status === 'pending') {
      assert.equal(f.manager.maintenanceHeld(), false, 'chat may run between models');
      assert.equal(f.manager.tuningActive(), true, 'models.ini must still not be written');
      between = true; break;
    }
    await new Promise(r => setImmediate(r));
  }
  assert.equal(between, true);
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  assert.equal(f.manager.tuningActive(), false);
});

// ── #1003: the realistic chat check before sign-off (CHAT_TEMPLATE_CAPS_IMPL) ──────────────
const davParseWasm = require('./dav-parse-wasm.cjs');
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const GEMMA3 = fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'chat-templates', 'google-gemma-3-12b-it.jinja'), 'utf8');
const TEMPLATE_400 = { ok: false, status: 400, body: { error: { code: 400, message: 'Unable to generate parser for this template. Automatic parser generation failed: {{ raise_exception("Conversation roles must alternate user/assistant/user/assistant/...") }}' } } };
const okReply = { ok: true, status: 200, body: { choices: [{ message: { content: 'Synthetic answer' } }] } };
const realChecks = () => { const caps = require('./chat-template-caps.cjs'); return { mode: () => 'wasm', templateCaps: t => davParseWasm.templateCaps(t), verdict: (st, b) => davParseWasm.servingVerdict(st, b), caps }; };

test('#1003: a Gemma 3 template is checked without tools and signed off', { skip: skipWasm }, async t => {
  const f = fixture(t, { chatTemplate: GEMMA3, servingFor: b => (b.tools ? TEMPLATE_400 : okReply), servingChecks: realChecks() });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  assert.equal(f.servingRequests.length, 1);
  assert.equal(f.servingRequests[0].tools, undefined);
  assert.equal(f.servingRequests[0].messages[0].role, 'system');
  assert.deepEqual(j.models[0].result.serving, { passed: true, toolsSent: false, templateKnown: true, retriedWithoutTools: false });
});

test('#1003: a template-unaware engine refusal is retried without tools, as chat does', { skip: skipWasm }, async t => {
  const f = fixture(t, { servingFor: b => (b.tools ? TEMPLATE_400 : okReply), servingChecks: realChecks() });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(f.servingRequests.map(b => !!b.tools), [true, false]);
  assert.equal(f.servingRequests[0].tools[0].function.parameters.type, 'object');
  assert.deepEqual(j.models[0].result.serving, { passed: true, toolsSent: false, templateKnown: false, retriedWithoutTools: true });
});

test('#1003: a profile that cannot serve the realistic request is not signed off', { skip: skipWasm }, async t => {
  const f = fixture(t, { servingFor: () => ({ ok: false, status: 500, body: { error: { message: 'synthetic slot failure at http://10.0.0.9:8080' } } }), servingChecks: realChecks() });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed');
  assert.match(j.models[0].error, /cannot serve a realistic chat request with the app's tools: synthetic slot failure at \[url\]\./);
  assert.equal(j.models[0].result, undefined);
  assert.equal(f.manager.autotune.status('synthetic').body.history.length, 0);
});

test('#1003: an engine reply without a message fails the check too', { skip: skipWasm }, async t => {
  const f = fixture(t, { servingFor: () => ({ ok: true, status: 200, body: { choices: [] } }), servingChecks: realChecks() });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed');
  assert.match(j.models[0].error, /answered without a chat message/);
});

test('#1003: with CHAT_TEMPLATE_CAPS_IMPL off there is no extra request', async t => {
  const f = fixture(t, { servingChecks: { mode: () => 'off', templateCaps: () => assert.fail(), verdict: () => assert.fail() } });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  assert.equal(f.servingRequests.length, 0);
  assert.equal(j.models[0].result.serving, undefined);
});

test('#1003: an unusable checker skips the check instead of failing the tune', async t => {
  const f = fixture(t, { servingChecks: { mode: () => 'wasm', templateCaps: () => { throw Error('x'); }, verdict: () => { throw Error('module missing'); } } });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  assert.ok(j.log.some(l => /realistic chat check was skipped/.test(l.text)));
});

// ── #1003 AUTOTUNE_PLAN_IMPL=wasm: Rust's planner orders the run ────────────────────────────────
// Synthetic facts: a small dense model whose bf16 KV cache fits 16k context in the 16 GiB budget.
// The fake engine recalls the marker up to 8k unquantized (bf16, f16) and up to 16k quantized.
const SYNTHETIC_FACTS = { meta: { contextLength: 16384, blockCount: 16, headCount: 16, headCountKv: 4, embeddingLength: 2048 }, modelBytes: 1e9, mmprojBytes: 0 };
const wasmPlanner = () => { const w = require('./dav-parse-wasm.cjs'); return { mode: () => 'wasm', plan: r => w.autotunePlan(r) }; };
const servingOff = { mode: () => 'off', templateCaps: () => assert.fail(), verdict: () => assert.fail() };
const backups = ini => fs.readdirSync(path.dirname(ini)).filter(n => n.startsWith('models.ini.noevia-backup-'));
const planned = (extra = {}) => ({ planner: wasmPlanner(), planFacts: async () => SYNTHETIC_FACTS, budgetGib: () => 16, ...extra });

test('#1003 planned: context first, then the KV type, a fill-and-recall search, phases once, one final check', { skip: skipWasm }, async t => {
  const f = fixture(t, { servingChecks: servingOff, autotuneExtra: planned() });
  assert.equal((await f.manager.autotune.start('synthetic', { confirmPause: true })).status, 202);
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(item.phases.map(p => p.id), ['context', 'sampling', 'drafting', 'batch', 'verify']);
  const results = JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).job.models[0].plan.results;
  // 16k bf16 forgets the marker, 8k passes, 12k forgets: 8k with bf16.
  assert.deepEqual(results.filter(r => r.step === 'probe').map(r => [r.ctx, r.kv, r.outcome]),
    [[16384, 'bf16', 'recall_failed'], [8192, 'bf16', 'passed'], [12288, 'bf16', 'recall_failed']]);
  assert.deepEqual(results.filter(r => r.step !== 'probe').map(r => r.step + (r.id ? ':' + r.id : '') + ':' + r.outcome),
    ['phase:sampling:skipped', 'phase:drafting:passed', 'phase:batch:passed', 'verify:passed', 'serving:skipped']);
  assert.equal(item.result.context, 8192);
  assert.equal(item.result.kv, 'bf16');
  assert.equal(item.result.plan, 'wasm');
  assert.equal(f.options('synthetic')['ctx-size'], '8192');
  assert.equal(f.options('synthetic')['cache-type-k'], 'bf16');
  // No repeated full context re-measurements in drafting or batch.
  for (const id of ['drafting', 'batch']) assert.ok(!phase(item, id).steps.some(s => /Context check/.test(s.label)), id);
  assert.deepEqual(phase(item, 'context').steps.map(s => s.label), ['Fill 16,384 · bf16 KV cache', 'Fill 8,192 · bf16 KV cache', 'Fill 12,288 · bf16 KV cache']);
  assert.equal(phase(item, 'verify').steps.length, 1);
  // One recovery copy for the whole run: the profile as it was before tuning.
  const kept = backups(f.ini);
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(f.ini), kept[0]), 'utf8'), f.original);
});

test('#1003 planned: probe outcomes reach the planner as memory, recall and quality failures', async t => {
  const script = [{ step: 'probe', ctx: 8192, kv: 'q5_0', fill: 7000, estimateMib: 4000 }, { step: 'probe', ctx: 16384, kv: 'f16', fill: 14000, estimateMib: 5000 },
    { step: 'probe', ctx: 8192, kv: 'f16', fill: 7000, estimateMib: 4000 }];
  const seen = [];
  const planner = { mode: () => 'wasm', plan: r => { seen.push(r); return script[r.results.length] || { step: 'fail', code: 'no_context', message: 'No context size passed the fill-and-recall test.' }; } };
  const f = fixture(t, { servingChecks: servingOff, autotuneExtra: planned({ planner }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed');
  assert.equal(j.models[0].error, 'No context size passed the fill-and-recall test.');
  assert.deepEqual(seen.at(-1).results.map(r => r.outcome), ['quality_failed', 'recall_failed', 'passed']);
  // The request the planner saw: the facts, the budget and the KV candidates this server tries.
  assert.equal(seen[0].facts.nCtxTrain, 16384);
  assert.equal(seen[0].memory.budgetMib, 16384);
  assert.equal(seen[0].memory.memAvailableMib, 20480);
  assert.equal(seen[0].memory.reserveMib, 2560);
  assert.deepEqual(seen[0].kv, ['bf16', 'q8_0']);
  assert.deepEqual(seen[0].ladder, [4096, 8192, 12288, 16384]);
  // The failed context stage put models.ini back.
  assert.equal(fs.readFileSync(f.ini, 'utf8'), f.original);
});

test('#1003 planned: a model the planner cannot size falls back to the standard order', { skip: skipWasm }, async t => {
  const f = fixture(t, { servingChecks: servingOff, autotuneExtra: planned({ planFacts: async () => ({ ...SYNTHETIC_FACTS, meta: { contextLength: 16384, blockCount: 16 } }) }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.match(item.planFallback, /cannot be sized/);
  assert.deepEqual(item.phases.map(p => p.id), ['sampling', 'kv', 'context', 'drafting', 'batch']);
  assert.ok(j.log.some(l => /Using the standard tuning order/.test(l.text)));
});

test('#1003 planned: unreadable model facts fall back too', async t => {
  const f = fixture(t, { servingChecks: servingOff, autotuneExtra: planned({ planFacts: async () => null }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  assert.match(j.models[0].planFallback, /could not be read/);
});

test('#1003 planned: a planner that breaks mid-run stops with a fixed message and restores models.ini', async t => {
  const planner = { mode: () => 'wasm', plan: r => { if (r.results.length) throw Error('module gone: /secret/path'); return { step: 'probe', ctx: 8192, kv: 'f16', fill: 7000, estimateMib: 4000 }; } };
  const f = fixture(t, { servingChecks: servingOff, autotuneExtra: planned({ planner }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed');
  assert.equal(j.error, 'The auto-tune planner is unavailable.');
  assert.equal(fs.readFileSync(f.ini, 'utf8'), f.original);
});

test('#1003 planned: with AUTOTUNE_PLAN_IMPL unset the standard order runs', async t => {
  const f = fixture(t, { servingChecks: servingOff, autotuneExtra: { planFacts: async () => assert.fail('not planned') } });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  assert.equal(j.models[0].plan, undefined);
  assert.equal(f.manager.autotune.status().body.planImpl, 'js');
});

test('#1003 one recovery copy of models.ini per tune run in the standard order too', async t => {
  const f = fixture(t, { servingChecks: servingOff });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  const kept = backups(f.ini);
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(f.ini), kept[0]), 'utf8'), f.original);
});

test('#1003 planned: a cancelled run resumes from its results without repeating a probe', { skip: skipWasm }, async t => {
  let cancelOnce = true;
  const f = fixture(t, { servingChecks: servingOff, autotuneExtra: planned(), onChat: ({ manager, o }) => {
    // The 8k probe's quality check: cancel there, after the 16k probe has its result.
    if (cancelOnce && o['ctx-size'] === '8192' && o['cache-type-k'] === 'bf16' && manager.autotune.status().body.job?.models[0].plan?.results.length === 1) { cancelOnce = false; manager.autotune.cancel(); }
  } });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  let j = await finished(f.manager);
  assert.equal(j.status, 'cancelled');
  assert.equal(fs.readFileSync(f.ini, 'utf8'), f.original);
  assert.equal((await f.manager.autotune.resume({ confirmPause: true })).status, 202);
  j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  const results = JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).job.models[0].plan.results;
  assert.deepEqual(results.filter(r => r.step === 'probe').map(r => [r.ctx, r.kv, r.outcome]),
    [[16384, 'bf16', 'recall_failed'], [8192, 'bf16', 'passed'], [12288, 'bf16', 'recall_failed']]);
  assert.equal(j.models[0].result.context, 8192);
  assert.equal(backups(f.ini).length, 1);
});

// ── core#15 review: sized baseline (#1026), micro-batch headroom (#1027), fallbacks and load timeouts (#1029)
// An 8 GB model with a projector whose saved profile (128k, f16) is far over the 16 GiB budget.
const BIG_FACTS = { meta: { contextLength: 131072, blockCount: 32, headCount: 32, headCountKv: 8, embeddingLength: 4096 }, modelBytes: 8e9, mmprojBytes: 8e8 };
const bigProfile = f => fs.writeFileSync(f.ini, fs.readFileSync(f.ini, 'utf8').replace('[synthetic]\nmodel = /models/synthetic.gguf\nctx-size = 8192', '[synthetic]\nmodel = /models/synthetic.gguf\nctx-size = 131072\ncache-type-k = f16\ncache-type-v = f16'));
// Whether one load fits, by the planner's own estimate at the load's context, KV type and micro-batch.
const fitsPlan = (request, o) => wasmPlanner().plan({ ...request, facts: { ...request.facts, ubatch: Math.max(Number(o['ubatch-size']) || 0, 0) }, ladder: [Number(o['ctx-size'])], kv: [o['cache-type-k'] || 'bf16'], results: [] }).step === 'probe';

test('#1026 #1027 planned: every load of the run fits the budget, the baseline and the micro-batch candidates included', { skip: skipWasm }, async t => {
  const loads = [];
  const f = fixture(t, { servingChecks: servingOff, autotuneExtra: planned({ planFacts: async () => BIG_FACTS }), onLoad: o => loads.push(o) });
  bigProfile(f);
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  const request = JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).job.models[0].plan.request;
  assert.equal(request.facts.ubatch, 2048, 'sized for the largest micro-batch the batch phase tries');
  // The saved profile itself (131072, f16) would not fit.
  assert.equal(fitsPlan(request, { 'ctx-size': '131072', 'cache-type-k': 'f16' }), false);
  assert.ok(loads.length > 5);
  assert.equal(loads[0]['ctx-size'], '4096', 'the baseline runs at the smallest rung');
  for (const o of loads) assert.ok(fitsPlan(request, o), `load at ${o['ctx-size']} ${o['cache-type-k']} ubatch ${o['ubatch-size']} is over the budget`);
  assert.ok(loads.some(o => o['ubatch-size'] === '2048'));
});

test('#1029 planned: an unbounded prompt cache falls back to the standard order', async t => {
  const f = fixture(t, { servingChecks: servingOff, autotuneExtra: planned() });
  fs.writeFileSync(f.ini, fs.readFileSync(f.ini, 'utf8').replace('ctx-size = 8192\nparallel = 1\n', 'ctx-size = 8192\nparallel = 1\ncache-ram = -1\n'));
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.match(j.models[0].planFallback, /prompt cache is unbounded/);
  assert.deepEqual(j.models[0].phases.map(p => p.id), ['sampling', 'kv', 'context', 'drafting', 'batch']);
});

test('#1029 planned: one load timeout is retried and is never a memory failure', { skip: skipWasm }, async t => {
  let hangs = 1;
  const f = fixture(t, { servingChecks: servingOff, autotuneExtra: planned(), calibrationExtra: { timeouts: { load: 30 } },
    loadHang: o => o['ctx-size'] === '16384' && hangs-- > 0 });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  const results = JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).job.models[0].plan.results;
  assert.deepEqual(results.filter(r => r.step === 'probe').map(r => [r.ctx, r.kv, r.outcome]),
    [[16384, 'bf16', 'recall_failed'], [8192, 'bf16', 'passed'], [12288, 'bf16', 'recall_failed']]);
  assert.ok(j.log.some(l => /Loading timed out; trying the same setting once more/.test(l.text)));
});

test('#1029 planned: a second load timeout stops the run with a fixed message and restores models.ini', { skip: skipWasm }, async t => {
  const f = fixture(t, { servingChecks: servingOff, autotuneExtra: planned(), calibrationExtra: { timeouts: { load: 30 } },
    loadHang: o => o['ctx-size'] === '16384' });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed');
  assert.match(j.error, /did not finish loading in time twice/);
  const results = JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).job.models[0].plan.results;
  assert.equal(results.length, 0, 'a timeout is not a measured result');
  assert.equal(fs.readFileSync(f.ini, 'utf8'), f.original);
});

// ── #1004 LAYA_LOAD_ADVISOR=on: rules name a guessed failure, the decision service only on a tie ──
const { createLoadAdvisor } = require('./load-advisor.cjs');
const ADVISOR_ON = { LAYA_LOAD_ADVISOR: 'on' };
function decisionService({ label, confidence = 0.9, delayMs = 0 } = {}) {
  const asked = [];
  return { asked, async choice(input, { signal } = {}) {
    asked.push(input);
    if (delayMs) await new Promise((resolve, reject) => { const t = setTimeout(resolve, delayMs); signal?.addEventListener('abort', () => { clearTimeout(t); reject(Error('aborted')); }); });
    const ids = input.options.map(o => o.id), rest = (1 - confidence) / (ids.length - 1);
    return { selected: label, scores: Object.fromEntries(ids.map(id => [id, id === label ? confidence : rest])) };
  } };
}
// The 16k bf16 load (the planner's first probe) is refused with `body`; everything else loads.
const refuse16k = body => o => (o['ctx-size'] === '16384' && o['cache-type-k'] === 'bf16' ? { ok: false, status: 500, body } : null);
const probeRows = f => JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).job.models[0].plan.results.filter(r => r.step === 'probe');

test('#1004 advisor on: a rule names an out-of-memory refusal; the decision service is not asked', { skip: skipWasm }, async t => {
  const svc = decisionService({ label: 'template' });
  const f = fixture(t, { servingChecks: servingOff, loadReply: refuse16k({ error: { message: 'ggml_vulkan: vk::Device::allocateMemory: ErrorOutOfDeviceMemory' } }),
    autotuneExtra: planned({ loadAdvisor: createLoadAdvisor({ env: ADVISOR_ON, endpoint: svc }) }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(probeRows(f)[0], { step: 'probe', ctx: 16384, kv: 'bf16', outcome: 'oom' });
  const row = phase(j.models[0], 'context').steps[0];
  assert.deepEqual([row.classification.source, row.classification.rule, row.classification.ruleId, row.classification.advisor], ['rule', 'oom', 'text_oom', 'not_asked']);
  assert.match(row.reason, /^The engine refused to load the model at this size\. The engine ran out of memory at this setting \(from the engine's error\)\.$/);
  assert.equal(svc.asked.length, 0);
  assert.equal(f.manager.autotune.status().body.loadAdvisor, 'on');
  // The engine's own words reach neither the client nor the state file.
  assert.ok(!JSON.stringify(f.manager.autotune.status().body).includes('ErrorOutOfDeviceMemory'));
  assert.ok(!fs.readFileSync(f.stateFile, 'utf8').includes('ErrorOutOfDeviceMemory'));
});

test('#1004 advisor on: no rule matches, the decision service reads a template failure and the run stops instead of shrinking', { skip: skipWasm }, async t => {
  const svc = decisionService({ label: 'template', confidence: 0.85 });
  const f = fixture(t, { servingChecks: servingOff, loadReply: refuse16k({ error: { message: 'srv  load_model: SYNTHETIC-UNMATCHED startup problem' } }),
    autotuneExtra: planned({ loadAdvisor: createLoadAdvisor({ env: ADVISOR_ON, endpoint: svc }) }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed');
  assert.match(j.models[0].error, /chat template, so auto-tune stopped instead of trying smaller settings/);
  assert.equal(svc.asked.length, 1);
  assert.match(svc.asked[0].state, /SYNTHETIC-UNMATCHED/);
  const row = phase(j.models[0], 'context').steps[0];
  assert.deepEqual(row.classification, { source: 'advisor', rule: 'unknown', ruleId: null, advice: { label: 'template', permille: 850 }, adviceUsed: true, advisor: 'used' });
  assert.ok(j.log.some(l => l.text === 'Decision service advice for this failure: used.'));
  // Nothing was planned on a template outcome, and models.ini is back.
  assert.equal(probeRows(f).length, 0);
  assert.equal(fs.readFileSync(f.ini, 'utf8'), f.original);
  assert.ok(!JSON.stringify(f.manager.autotune.status().body).includes('SYNTHETIC-UNMATCHED'));
});

test('#1004 advisor on: a decision service over its budget is ignored and the calibrator\'s cause stands', { skip: skipWasm }, async t => {
  const svc = decisionService({ label: 'template', delayMs: 5000 });
  const f = fixture(t, { servingChecks: servingOff, loadReply: refuse16k({ error: { message: 'SYNTHETIC-UNMATCHED' } }),
    autotuneExtra: planned({ loadAdvisor: createLoadAdvisor({ env: ADVISOR_ON, endpoint: svc, budgetMs: 20 }) }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(probeRows(f)[0].outcome, 'load_failed');
  const c = phase(j.models[0], 'context').steps[0].classification;
  assert.deepEqual([c.source, c.advisor, c.adviceUsed], ['fallback', 'timeout', false]);
});

test('#1004 advisor on: a context-size error in the stream steps the context down (recall), not the cache type', { skip: skipWasm }, async t => {
  const svc = decisionService({ label: 'oom' });
  const err = `data: ${JSON.stringify({ error: { code: 400, message: 'the request exceeds the available context size, try increasing it' } })}\n\n`;
  const f = fixture(t, { servingChecks: servingOff, streamReply: o => (o['ctx-size'] === '16384' ? new Response(err) : null),
    autotuneExtra: planned({ loadAdvisor: createLoadAdvisor({ env: ADVISOR_ON, endpoint: svc }) }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  // Without the advisor this stream error counted as out of memory (a more compact cache type).
  assert.deepEqual(probeRows(f)[0], { step: 'probe', ctx: 16384, kv: 'bf16', outcome: 'recall_failed' });
  assert.equal(svc.asked.length, 0);
});

test('#1004 advisor off (default): outcomes are what they were and nothing is asked', async t => {
  const svc = decisionService({ label: 'template' });
  const script = [{ step: 'probe', ctx: 16384, kv: 'bf16', fill: 14000, estimateMib: 5000 }];
  const seen = [];
  const planner = { mode: () => 'wasm', plan: r => { seen.push(r); return script[r.results.length] || { step: 'fail', code: 'no_context', message: 'No context size passed the fill-and-recall test.' }; } };
  const f = fixture(t, { servingChecks: servingOff, loadReply: refuse16k({ error: { message: 'CUDA error: out of memory' } }),
    autotuneExtra: planned({ planner, loadAdvisor: createLoadAdvisor({ env: {}, endpoint: svc, verdict: () => assert.fail('no verdict when off') }) }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed');
  assert.deepEqual(seen.at(-1).results.map(r => r.outcome), ['load_failed']);
  assert.equal(phase(j.models[0], 'context').steps[0].classification, undefined);
  assert.equal(svc.asked.length, 0);
  assert.equal(f.manager.autotune.status().body.loadAdvisor, 'off');
});

test('#1004 advisor on but the verdict module unusable: the calibrator\'s cause stands', async t => {
  const script = [{ step: 'probe', ctx: 16384, kv: 'bf16', fill: 14000, estimateMib: 5000 }];
  const seen = [];
  const planner = { mode: () => 'wasm', plan: r => { seen.push(r); return script[r.results.length] || { step: 'fail', code: 'no_context', message: 'No context size passed the fill-and-recall test.' }; } };
  const f = fixture(t, { servingChecks: servingOff, loadReply: refuse16k({ error: { message: 'odd' } }),
    autotuneExtra: planned({ planner, loadAdvisor: createLoadAdvisor({ env: ADVISOR_ON, endpoint: null, verdict: () => { throw Error('module gone'); }, log: () => {} }) }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  await finished(f.manager);
  assert.deepEqual(seen.at(-1).results.map(r => r.outcome), ['load_failed']);
});

test('#1004 advisor on: a rejected long prompt\'s error body is read (capped) and a rule names it', { skip: skipWasm }, async t => {
  const svc = decisionService({ label: 'template' });
  const body = JSON.stringify({ error: { code: 500, message: 'ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 9126805504' } });
  const f = fixture(t, { servingChecks: servingOff, streamReply: o => (o['ctx-size'] === '16384' ? new Response(body, { status: 500 }) : null),
    autotuneExtra: planned({ loadAdvisor: createLoadAdvisor({ env: ADVISOR_ON, endpoint: svc }) }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  const c = phase(j.models[0], 'context').steps[0].classification;
  assert.deepEqual([probeRows(f)[0].outcome, c.source, c.ruleId], ['oom', 'rule', 'text_oom']);
  assert.equal(svc.asked.length, 0);
});

// ── core#18 review: #1047 engine words stay out of reasons, #1048 flag off reads nothing ──
const sseError = message => `data: ${JSON.stringify({ error: { code: 500, message } })}\n\n`;
for (const on of [false, true]) test(`#1047 a stream error's engine text never reaches status() or the state file (advisor ${on ? 'on' : 'off'})`, { skip: skipWasm }, async t => {
  const f = fixture(t, { servingChecks: servingOff, streamReply: o => (o['ctx-size'] === '16384' ? new Response(sseError('SECRET-xyz engine detail')) : null),
    autotuneExtra: planned({ loadAdvisor: createLoadAdvisor({ env: on ? ADVISOR_ON : {}, endpoint: decisionService({ label: 'oom' }) }) }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  assert.match(phase(j.models[0], 'context').steps[0].reason, /^The engine reported an error during the long prompt\./);
  assert.ok(!JSON.stringify(f.manager.autotune.status().body).includes('SECRET-xyz'));
  assert.ok(!fs.readFileSync(f.stateFile, 'utf8').includes('SECRET-xyz'));
});

// A 500 whose body stream records whether it was read and whether it was cancelled.
function watchedBody({ endless = false } = {}) {
  const seen = { pulled: 0, cancelled: false };
  const body = new ReadableStream({
    pull(c) { seen.pulled++; if (seen.pulled === 1) c.enqueue(new TextEncoder().encode('failed to allocate buffer ')); else if (!endless) c.close(); else return new Promise(() => {}); },
    cancel() { seen.cancelled = true; },
  }, { highWaterMark: 0 });
  return { seen, response: () => new Response(body, { status: 500 }) };
}

test('#1048 advisor off: a rejected prompt\'s error body is not read and no evidence is attached', async t => {
  const w = watchedBody();
  const script = [{ step: 'probe', ctx: 16384, kv: 'f16', fill: 14000, estimateMib: 5000 }];
  const planner = { mode: () => 'wasm', plan: r => script[r.results.length] || { step: 'fail', code: 'no_context', message: 'No context size passed the fill-and-recall test.' } };
  let judged = 0;
  const advisor = { enabled: () => false, judge: async () => { judged++; return null; } };
  const f = fixture(t, { servingChecks: servingOff, streamReply: o => (o['ctx-size'] === '16384' && o['cache-type-k'] === 'f16' ? w.response() : null), autotuneExtra: planned({ planner, loadAdvisor: advisor }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  await finished(f.manager);
  assert.equal(w.seen.pulled, 0);
  assert.equal(judged, 0);
});

test('#1048 the calibrator attaches evidence only when asked', async () => {
  const { createCalibrator } = require('./llamacpp-calibration.cjs');
  // The calibrator alone, a refused load: probe without and with evidence.
  const status = { synthetic: 'unloaded' };
  const request = async (p) => (p === '/models/load' ? { ok: false, status: 500, body: { error: { message: 'out of memory' } } } : { ok: true, body: {} });
  const presets = { get: () => ({ revision: 'r1', options: { parallel: '1' } }), snapshot: () => ({ text: '', revision: 'r1' }) };
  const cal = createCalibrator({ request, rawModels: async () => ({ ok: true, body: { data: [{ id: 'synthetic', status: { value: status.synthetic } }] } }), presets,
    maintenance: { hold: () => () => {} }, applyUnlocked: async () => ({ ok: true }), sleep: async () => {}, readMemory: () => 20, stream: async () => assert.fail('no stream') });
  const off = await cal.probe('synthetic', { ctx: 4096, fill: 1000, baseRevision: 'r1' });
  const on = await cal.probe('synthetic', { ctx: 4096, fill: 1000, baseRevision: 'r1', evidence: true });
  assert.equal(off.passed, false);
  assert.equal(off.evidence, undefined);
  assert.deepEqual(on.evidence, { status: 500, text: '{"error":{"message":"out of memory"}}' });
});

test('#1048 advisor on: an error body that never ends is cancelled at the deadline, and what arrived is used', { skip: skipWasm }, async t => {
  const w = watchedBody({ endless: true });
  const svc = decisionService({ label: 'template' });
  const f = fixture(t, { servingChecks: servingOff, streamReply: o => (o['ctx-size'] === '16384' && o['cache-type-k'] === 'bf16' ? w.response() : null),
    autotuneExtra: planned({ loadAdvisor: createLoadAdvisor({ env: ADVISOR_ON, endpoint: svc }) }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  for (let i = 0; i < 400 && f.manager.autotune.status().body.job?.status === 'running'; i++) await new Promise(r => setTimeout(r, 25));
  const j = await finished(f.manager);
  assert.equal(j.status, 'passed', j.error);
  assert.equal(w.seen.cancelled, true);
  assert.deepEqual([probeRows(f)[0].outcome, phase(j.models[0], 'context').steps[0].classification.ruleId], ['oom', 'text_oom']);
  assert.equal(svc.asked.length, 0);
});

// ── #1049: an engine failure's own words never become a step reason, note or job error ──
const noSecret = f => {
  assert.ok(!JSON.stringify(f.manager.autotune.status().body).includes('SECRET-abc'));
  assert.ok(!fs.readFileSync(f.stateFile, 'utf8').includes('SECRET-abc'));
};
test('#1049 a quality-probe failure carrying engine text stays out of status() and the state file', async t => {
  const f = fixture(t, { onChat: ({ prompt }) => { if (QUALITY.some(q => q.prompt === prompt)) throw Error('fetch failed: SECRET-abc engine detail'); } });
  const quiet = console.error; console.error = () => {}; t.after(() => { console.error = quiet; });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.notEqual(j.status, 'passed');
  assert.match(JSON.stringify(j), /The model server request failed\./);
  noSecret(f);
});
test('#1049 the same failure inside the planned quality probe (withQuality catch) is not recorded either', { skip: skipWasm }, async t => {
  let armed = false;
  const f = fixture(t, { servingChecks: servingOff, autotuneExtra: planned(),
    onChat: ({ prompt }) => { if (QUALITY.some(q => q.prompt === prompt)) { armed = true; throw Error('SECRET-abc engine detail: out of memory'); } } });
  const quiet = console.error; console.error = () => {}; t.after(() => { console.error = quiet; });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  await finished(f.manager);
  assert.ok(armed);
  noSecret(f);
});

// ── #1057: the owner's KV policy: bf16 by default, q8_0 the floor, q5 per model, precision first ──
const { kvCandidates, preferKv, bf16Unsupported } = require('./llamacpp-full-autotune.cjs');
// A dense 32-layer model with a 64k trained context. At 6 GiB, q8_0 fits 24k against bf16's 12k
// (exactly twice); at 10 GiB, 64k against 40k (1.6x). Sized like the planner (estimateFootprint).
const DENSE_64K = { meta: { contextLength: 65536, blockCount: 32, headCount: 32, headCountKv: 8, embeddingLength: 4096 }, modelBytes: 2e9, mmprojBytes: 0 };

test('#1057 kvCandidates: bf16 then q8_0; q5 only with the model opt-in; q4_0 only with both opt-ins', () => {
  const prior = process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV;
  try {
    delete process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV;
    assert.deepEqual(kvCandidates(), ['bf16', 'q8_0']);
    assert.deepEqual(kvCandidates({ allowQ5Kv: true }), ['bf16', 'q8_0', 'q5_1', 'q5_0']);
    assert.deepEqual(kvCandidates({ allowQ5Kv: 'yes' }), ['bf16', 'q8_0'], 'only a real true opts in');
    process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV = 'on';
    assert.deepEqual(kvCandidates(), ['bf16', 'q8_0']);
    assert.deepEqual(kvCandidates({ allowQ5Kv: true }), ['bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_0']);
  } finally { if (prior === undefined) delete process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV; else process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV = prior; }
});

test('#1057 preferKv: the most precise passing type unless a more compact one fits twice the context', () => {
  assert.equal(preferKv(['bf16', 'q8_0'], { bf16: 12288, q8_0: 24576 }), 'q8_0', 'exactly twice counts');
  assert.equal(preferKv(['bf16', 'q8_0'], { bf16: 12288, q8_0: 20480 }), 'bf16');
  assert.equal(preferKv(['bf16', 'q8_0'], null), 'bf16', 'unsizeable: precision alone');
  assert.equal(preferKv(['q8_0'], { bf16: 12288, q8_0: 20480 }), 'q8_0', 'bf16 failed: the floor');
  assert.equal(preferKv(['bf16', 'q8_0', 'q5_1', 'q5_0'], { bf16: 8192, q8_0: 12288, q5_1: 16384, q5_0: 16384 }), 'q5_1', 'q5 doubles bf16 where q8_0 does not');
  assert.equal(preferKv(['bf16', 'q8_0', 'q5_1'], { bf16: 8192, q8_0: 16384, q5_1: 24576 }), 'q8_0', 'q5 must double q8_0 once q8_0 is chosen');
  assert.equal(preferKv(['bf16', 'q8_0'], { bf16: null, q8_0: 4096 }), 'q8_0', 'bf16 fits no rung');
  assert.equal(preferKv([], {}), null);
});

test('#1057 bf16Unsupported: only the engine saying it has no bf16 cache, never memory', () => {
  for (const text of ['Unsupported cache type: bf16', 'error: unsupported KV cache type bf16', 'ggml_vulkan: Error: Missing op: FLASH_ATTN_EXT for BF16',
    'the backend does not support BF16 K/V with flash attention', 'cache_type_k bf16 is not supported by this build',
    'ggml_vulkan: Found 1 Vulkan devices\nllama_init_from_model: unsupported cache type: bf16'])
    assert.equal(bf16Unsupported(text), true, text);
  // #1061: a device banner naming bf16, then an unrelated failure line, is not "unsupported".
  assert.equal(bf16Unsupported('ggml_vulkan: 0 = AMD Radeon Graphics (RADV GFX1151) | uma: 1 | fp16: 1 | bf16: 0 | warp size: 64\nllama_init_from_model: failed to allocate KV buffer: memory type not supported, out of memory'), false);
  for (const text of ['', null, 'CUDA error: out of memory', 'failed to allocate bf16 buffer of size 9126805504', 'error loading model: missing tensor', 'unsupported template'])
    assert.equal(bf16Unsupported(text), false, String(text));
});

test('#1057 js order: q8_0 replaces bf16 only when it fits at least twice the context', async t => {
  const f = fixture(t, { autotuneExtra: { planFacts: async () => DENSE_64K, budgetGib: () => 6 } });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), kv = phase(j.models[0], 'kv');
  assert.equal(j.status, 'passed', j.error);
  assert.equal(kv.value.kv, 'q8_0');
  assert.deepEqual(kv.value.candidates.map(c => [c.kv, c.ceiling]), [['bf16', 12288], ['q8_0', 24576]]);
  assert.ok(j.log.some(l => l.text === 'Committed q8_0 KV cache after quality checks (it fits 24576 tokens, at least twice what bf16 fits).'));
  // 10 GiB: q8_0 fits 64k, bf16 40k: not twice, so bf16 stays although q8_0 measured faster.
  const g = fixture(t, { autotuneExtra: { planFacts: async () => DENSE_64K, budgetGib: () => 10 } });
  await g.manager.autotune.start('synthetic', { confirmPause: true });
  const k = await finished(g.manager);
  assert.equal(k.status, 'passed', k.error);
  assert.equal(phase(k.models[0], 'kv').value.kv, 'bf16');
  assert.ok(phase(k.models[0], 'kv').value.candidates.find(c => c.kv === 'q8_0').generation > phase(k.models[0], 'kv').value.candidates.find(c => c.kv === 'bf16').generation);
});

test('#1057 per-model settings: validated, saved with the tune state, survive a restart, never change a queued run', async t => {
  let stop = true;
  const f = fixture(t, { onChat: ({ manager }) => { if (stop) { stop = false; manager.autotune.cancel(); } } });
  const set = (m, b) => f.manager.autotune.setSettings(m, b);
  assert.equal(set('synthetic', { allowQ5Kv: 'true' }).status, 400);
  assert.equal(set('synthetic', {}).status, 400);
  assert.equal(set('synthetic', null).status, 400);
  assert.equal(set('', { allowQ5Kv: true }).status, 400);
  assert.equal(set('x'.repeat(201), { allowQ5Kv: true }).status, 400);
  assert.equal(set('not-configured', { allowQ5Kv: true }).status, 404);
  assert.equal(set('laya_multilingual_f16', { allowQ5Kv: true }).status, 400);
  // Off by default; a job started now tries bf16 and q8_0 only.
  assert.deepEqual(f.manager.autotune.status('synthetic').body.settings, { allowQ5Kv: false });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const cancelled = await finished(f.manager);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.models[0].kv, ['bf16', 'q8_0']);
  // #1060: not while the cancelled run can be resumed.
  assert.equal(set('synthetic', { allowQ5Kv: true }).status, 409);
  const resumedFirst = f.manager;
  assert.equal((await resumedFirst.autotune.resume({ confirmPause: true })).status, 202);
  assert.equal((await finished(resumedFirst)).status, 'passed');
  const on = set('synthetic', { allowQ5Kv: true });
  assert.equal(on.status, 200);
  assert.deepEqual(on.body.settings, { allowQ5Kv: true });
  assert.deepEqual(on.body.kvCandidates, ['bf16', 'q8_0', 'q5_1', 'q5_0']);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).settings, { synthetic: { allowQ5Kv: true } });
  const manager = f.restart();
  assert.deepEqual(manager.autotune.status('synthetic').body.settings, { allowQ5Kv: true });
  // The resumed run kept the list it started with.
  assert.deepEqual(phase(manager.autotune.status().body.job.models[0], 'kv').steps.map(s => s.id), ['bf16', 'q8_0']);
  // Off again removes the entry.
  manager.autotune.setSettings('synthetic', { allowQ5Kv: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).settings, {});
});

// A scripted planner that probes at 8k with the request's first type until a pass, then runs on.
const scriptedFrom = (seen, at = r => (r.ladder.length === 1 ? r.ladder[0] : 8192)) => ({ mode: () => 'wasm', plan: r => {
  seen.push(JSON.parse(JSON.stringify(r)));
  const res = r.results, kv = r.kv[0], has = (step, id) => res.some(x => x.step === step && (!id || x.id === id));
  if (!res.some(x => x.step === 'probe' && x.outcome === 'passed')) {
    if (res.some(x => x.step === 'probe')) return { step: 'fail', code: 'no_context', message: 'No context size passed the fill-and-recall test.' };
    const c = at(r);
    return { step: 'probe', ctx: c, kv, fill: Math.floor(c * 0.9) - 256, estimateMib: 4000 };
  }
  const ctx = Math.max(...res.filter(x => x.step === 'probe' && x.outcome === 'passed').map(x => x.ctx));
  for (const id of ['sampling', 'drafting', 'batch']) if (!has('phase', id)) return { step: 'phase', id, ctx, kv };
  if (!has('verify')) return { step: 'verify', ctx, kv, fill: Math.floor(ctx * 0.9) - 256, estimateMib: 4000 };
  if (!has('serving')) return { step: 'serving', ctx, kv };
  return { step: 'done', ctx, kv };
} });
const refuseBf16 = text => o => (o['cache-type-k'] === 'bf16' ? { ok: false, status: 500, body: { error: { message: text } } } : null);

test('#1057 planned: an engine that rejects bf16 gets f16 in its place, recorded on the plan and noted on the job', async t => {
  const seen = [];
  const f = fixture(t, { servingChecks: servingOff, loadReply: refuseBf16('llama_init_from_model: unsupported cache type: bf16 (Vulkan, flash attention)'),
    autotuneExtra: planned({ planner: scriptedFrom(seen) }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.equal(item.result.kv, 'f16');
  assert.deepEqual(item.result.kvFallback, { from: 'bf16', to: 'f16', at: 8192 });
  assert.equal(f.options('synthetic')['cache-type-k'], 'f16');
  // The rejected bf16 step is not a planner result; the next request offers f16 instead. (The
  // baseline's one-rung sizing questions are left out.)
  const steps = seen.filter(r => r.ladder.length > 1);
  assert.deepEqual(steps[0].kv, ['bf16', 'q8_0']);
  assert.deepEqual(steps[1].kv, ['f16', 'q8_0']);
  assert.deepEqual(steps[1].results, []);
  const rows = phase(item, 'context').steps;
  assert.deepEqual(rows.map(r => [r.kv, r.status]), [['bf16', 'failed'], ['f16', 'passed']]);
  assert.match(rows[0].reason, /does not support a bf16 KV cache, so auto-tune uses f16/);
  assert.ok(j.log.some(l => /does not support a bf16 KV cache/.test(l.text)));
  // The engine's own words stay out of status() and the state file (#1047).
  assert.ok(!JSON.stringify(f.manager.autotune.status().body).includes('llama_init_from_model'));
  assert.ok(!fs.readFileSync(f.stateFile, 'utf8').includes('llama_init_from_model'));
  assert.deepEqual(item.plan.request.kv, ['f16', 'q8_0']);
});

test('#1057 planned: a bf16 failure that is not "unsupported" (out of memory) stays a failure with bf16', async t => {
  const seen = [];
  const f = fixture(t, { servingChecks: servingOff, loadReply: refuseBf16('ggml_vulkan: failed to allocate bf16 buffer: out of device memory'),
    autotuneExtra: planned({ planner: scriptedFrom(seen) }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed');
  assert.deepEqual(seen.at(-1).results.map(r => [r.kv, r.outcome]), [['bf16', 'load_failed']]);
  assert.deepEqual(seen.at(-1).kv, ['bf16', 'q8_0']);
  assert.equal(j.models[0].plan.kvFallback, undefined);
  assert.ok(!f.requests.some(r => r.options['cache-type-k'] === 'f16' && r.options['ctx-size'] === '8192'));
});

test('#1057 planned (wasm): bf16 rejected at its first probe, f16 runs the same search', { skip: skipWasm }, async t => {
  const f = fixture(t, { servingChecks: servingOff, loadReply: refuseBf16('Unsupported cache type: bf16'), autotuneExtra: planned() });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  const results = JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).job.models[0].plan.results;
  assert.deepEqual(results.filter(r => r.step === 'probe').map(r => [r.ctx, r.kv, r.outcome]),
    [[16384, 'f16', 'recall_failed'], [8192, 'f16', 'passed'], [12288, 'f16', 'recall_failed']]);
  assert.equal(item.result.kv, 'f16');
  assert.equal(item.result.context, 8192);
  assert.equal(phase(item, 'context').steps[0].label, 'Fill 16,384 · bf16 KV cache');
});

test('#1057 planned (wasm): the request carries the model\'s list, and q5 wins only where it doubles the context', { skip: skipWasm }, async t => {
  const w = require('./dav-parse-wasm.cjs'), { ladder } = require('./llamacpp-calibration.cjs');
  const req = (kv, budgetMib) => ({ facts: { nCtxTrain: 65536, blockCount: 32, headCount: 32, headCountKv: 8, embeddingLength: 4096, modelBytes: 2e9, ubatch: 2048, slots: 1 },
    memory: { budgetMib, memAvailableMib: null, reserveMib: 2560, floorMib: 2048, cacheRamMib: 1024 }, ladder: ladder(65536), kv, results: [] });
  const first = (kv, mib) => { const s = w.autotunePlan(req(kv, mib)); return [s.ctx, s.kv]; };
  // 7424 MiB: bf16 24k; q8_0 does not double it; q5_1 fits 64k, which does.
  assert.deepEqual(first(kvCandidates(), 7424), [24576, 'bf16']);
  assert.deepEqual(first(kvCandidates({ allowQ5Kv: true }), 7424), [65536, 'q5_1']);
  // 16 GiB: bf16 at the trained maximum whatever is allowed.
  assert.deepEqual(first(kvCandidates({ allowQ5Kv: true }), 16384), [65536, 'bf16']);
  // The planned job sends the model's own list.
  const seen = [];
  const f = fixture(t, { servingChecks: servingOff, autotuneExtra: planned({ planner: { mode: () => 'wasm', plan: r => { seen.push(r); return w.autotunePlan(r); } } }) });
  f.manager.autotune.setSettings('synthetic', { allowQ5Kv: true });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  assert.equal((await finished(f.manager)).status, 'passed');
  assert.deepEqual(seen[0].kv, ['bf16', 'q8_0', 'q5_1', 'q5_0']);
});

// ── #1058: an engine that dies loading bf16, saying nothing ──
test('#1058 planned: bf16 crashing (no text) at the smallest rung gets f16 once; earlier bf16 failures are dropped', async t => {
  const seen = [];
  const f = fixture(t, { servingChecks: servingOff, failLoadBf16: true, autotuneExtra: planned({ planner: scriptedFrom(seen, r => r.ladder[0]) }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.equal(item.result.kv, 'f16');
  assert.deepEqual(item.result.kvFallback, { from: 'bf16', to: 'f16', at: 4096 });
  assert.match(phase(item, 'context').steps[0].reason, /failed to load a bf16 KV cache even at the smallest context/);
  assert.deepEqual(item.plan.results.filter(r => r.step === 'probe').map(r => [r.ctx, r.kv, r.outcome]), [[4096, 'f16', 'passed']]);
});

test('#1058 planned: before leaving bf16 after silent failures, one bf16 probe at the smallest rung decides', async t => {
  // Dies everywhere: the smallest-rung check dies too, so f16 takes over.
  const f = fixture(t, { servingChecks: servingOff, failLoadBf16: true, autotuneExtra: planned({ planner: scriptedFrom([]) }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(phase(item, 'context').steps.map(r => [r.ctx, r.kv, r.status]), [[8192, 'bf16', 'failed'], [4096, 'bf16', 'failed'], [8192, 'f16', 'passed']]);
  assert.equal(item.result.kv, 'f16');
  // Dies only above 4k: bf16 loads at the smallest rung, so it is supported and stays.
  const g = fixture(t, { servingChecks: servingOff, failLoadBf16: o => o['ctx-size'] !== '4096', autotuneExtra: planned({ planner: scriptedFrom([]) }) });
  await g.manager.autotune.start('synthetic', { confirmPause: true });
  const k = await finished(g.manager);
  assert.equal(k.status, 'passed', k.error);
  assert.equal(k.models[0].result.kv, 'bf16');
  assert.equal(k.models[0].plan.kvFallback, undefined);
  assert.deepEqual(k.models[0].plan.results.filter(r => r.step === 'probe').map(r => [r.ctx, r.kv, r.outcome]), [[8192, 'bf16', 'load_failed'], [4096, 'bf16', 'passed']]);
});

test('#1058 planned: a bf16 failure that says why (out of memory) is never retried at the smallest rung', async t => {
  const seen = [];
  const f = fixture(t, { servingChecks: servingOff, loadReply: refuseBf16('ggml_vulkan: out of device memory'), autotuneExtra: planned({ planner: scriptedFrom(seen) }) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed');
  assert.deepEqual(seen.filter(r => r.ladder.length > 1).at(-1).results.map(r => [r.ctx, r.kv, r.outcome]), [[8192, 'bf16', 'load_failed']]);
});

test('#1058 planned (wasm): bf16 crashing everywhere ends with f16, not q8_0', { skip: skipWasm }, async t => {
  const f = fixture(t, { servingChecks: servingOff, failLoadBf16: true, autotuneExtra: planned() });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.equal(item.result.kv, 'f16');
  assert.ok(!item.plan.results.some(r => r.kv === 'bf16'), 'no bf16 failure carried over');
  assert.equal(new Set(phase(item, 'context').steps.map(s => s.id)).size, phase(item, 'context').steps.length, 'row ids stay unique');
});

test('#1058 js order: bf16 that does not load gets f16 once in its place', async t => {
  const f = fixture(t, { failLoadBf16: true });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0], kv = phase(item, 'kv');
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(kv.steps.map(s => [s.id, s.status]), [['bf16', 'failed'], ['f16', 'passed'], ['q8_0', 'passed']]);
  assert.equal(item.result.kv, 'f16');
  assert.deepEqual(item.result.kvFallback, { from: 'bf16', to: 'f16' });
  assert.ok(j.log.some(l => /bf16 KV cache did not load; trying f16/.test(l.text)));
});
