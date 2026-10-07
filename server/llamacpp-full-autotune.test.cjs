'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createModelManager } = require('./model-manager.cjs');
const { createPresetStore } = require('./llamacpp-presets.cjs');
const { QUALITY, qualityCheck, qualityFailure, newModel } = require('./llamacpp-full-autotune.cjs');

function fixture(t, { badSampling = false, models = ['synthetic'], onChat, onUnload, badQ4 = true, badF16 = false, noHead = false, rejectAll = false, rejectModel = '', badBatch = false, failFinal = false, formattedQuality = false, reasoningOnly = false, truncatedWorkloads = false, idleTimeoutMs = 300000, loseIdentityAfterStart = false, reloadFail = false, unloadPolls = 0, unloadStuck = false, answerFor = null, failLoadF16 = false, httpFor = null, chatTemplate = null, servingFor = null, servingChecks = null, autotuneExtra = {} } = {}) {
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
    if (u.pathname === '/models/load') { status[b.model] = failLoadF16 && options(b.model)['cache-type-k'] === 'f16' ? 'unloaded' : 'loaded'; return { ok: true, body: {} }; }
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
      if (q && (rejectAll || (badSampling && o.temp) || b.model === rejectModel || (badF16 && o['cache-type-k'] === 'f16') || (badQ4 && ['q5_0', 'q5_1', 'q4_0'].includes(o['cache-type-k'])))) text = 'wrong';
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
    const content = Number(o['ctx-size']) <= (o['cache-type-k'] === 'f16' ? 8192 : 16384) ? marker : 'forgot';
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }], timings: { prompt_n: Math.floor(text.length / 5), prompt_ms: 100, prompt_per_second: 100000 } })}\n\ndata: [DONE]\n\n`);
  };
  const makeManager = () => createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic', presetPath: ini, fetchJson, fetchStream,
    calibrationStatePath: path.join(dir, 'cal.json'), autotuneStatePath: stateFile,
    calibrationOptions: { sleep: async () => {}, readMemory: () => 20 },
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
  assert.equal(item.result.kv, 'q8_0'); assert.equal(item.result.spec, 'mtp-deep');
  assert.equal(item.result.context, 16384); assert.equal(item.result.acceptance, 65);
  assert.equal(item.result.generation, 60);
  assert.equal(item.result.ubatch, 1024);
  assert.equal(phase(item, 'kv').steps.find(s => s.id === 'q5_0').status, 'failed');
  assert.equal(phase(item, 'kv').steps.find(s => s.id === 'q5_1').status, 'failed');
  assert.deepEqual(phase(item, 'kv').steps.map(s => s.id), ['f16', 'q8_0', 'q5_1', 'q5_0']);
  assert.equal(phase(item, 'context').value.context, 16384);
  assert.equal(phase(item, 'drafting').value.spec, 'mtp-deep');
  assert.equal(phase(item, 'batch').value.promptPerSecond, 800);
  const o = f.options('synthetic');
  assert.equal(o['ctx-size'], '16384'); assert.equal(o['cache-type-k'], 'q8_0');
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
  // f16 is the reference, so the rejected candidate is q8_0 (it breaks arithmetic, which f16 passed).
  const f = fixture(t, { badQ4: false, unloadPolls: 4, answerFor: ({ q, o }) => q.id === 'arithmetic' && o['cache-type-k'] === 'q8_0' ? '61' : null });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), kv = phase(j.models[0], 'kv');
  assert.equal(j.status, 'passed', j.error);
  assert.equal(kv.steps.find(s => s.id === 'q8_0').status, 'failed');
  assert.match(kv.steps.find(s => s.id === 'q8_0').reason, /arithmetic \(mismatch\)/);
  assert.equal(kv.steps.find(s => s.id === 'q5_1').status, 'passed');
  assert.equal(j.models[0].result.kv, 'q5_1');
});

test('an unload that never reaches unloaded stops without writing another profile', async t => {
  const f = fixture(t, { unloadStuck: true });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager);
  assert.equal(j.status, 'failed');
  assert.match(j.error, /Timed out waiting for router unload: synthetic \(unloading\)/);
  assert.equal(f.options('synthetic')['cache-type-k'], 'f16');
  assert.ok(f.requests.length > 0 && f.requests.every(r => r.options['cache-type-k'] === 'f16'), 'only the first candidate was measured');
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
  assert.equal(f.options('one')['ctx-size'], '16384');
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
  assert.equal(f.options('synthetic')['cache-type-k'], 'q8_0');
  assert.equal(f.options('synthetic')['ctx-size'], '16384');
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
  assert.equal(f.options('synthetic')['cache-type-k'], 'q8_0');
  assert.equal(f.options('synthetic')['ctx-size'], '16384');
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
  fs.writeFileSync(f.ini, fs.readFileSync(f.ini, 'utf8').replace('ctx-size = 16384', 'ctx-size = 12288'));
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, ['synthetic']);
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
  assert.equal(job.models[0].result.generation, 60);
});

test('KV phase never offers q4_0 by default and picks a Q5-or-higher profile even when q4 would be fastest (issue #190)', async t => {
  const f = fixture(t); // badQ4 defaults true: q5_0/q5_1/q4_0 all fail quality in this fixture
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(phase(item, 'kv').steps.map(s => s.id), ['f16', 'q8_0', 'q5_1', 'q5_0']);
  assert.ok(!phase(item, 'kv').steps.some(s => s.id === 'q4_0'), 'q4_0 must not be a candidate by default');
  assert.equal(item.result.kv, 'q8_0');
});

test('KV floor override env var adds q4_0 as a last-resort candidate, still below f16/q8_0/q5', async t => {
  const prior = process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV;
  process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV = '1';
  t.after(() => { if (prior === undefined) delete process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV; else process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV = prior; });
  const f = fixture(t);
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.deepEqual(phase(item, 'kv').steps.map(s => s.id), ['f16', 'q8_0', 'q5_1', 'q5_0', 'q4_0']);
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
  assert.equal(o['cache-type-k'], 'q8_0');
});

test('a failing sampling probe restores models.ini exactly, records why, and the tune carries on to complete', async t => {
  const f = fixture(t, { models: ['Qwen3-8B-Instruct'], badSampling: true });
  let atKv = null;
  await f.manager.autotune.start('Qwen3-8B-Instruct', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0], p = phase(item, 'sampling');
  assert.equal(j.status, 'passed', j.error);
  assert.equal(p.status, 'passed'); assert.equal(p.value.skipped, true); assert.equal(p.value.failed, true);
  assert.match(p.value.reason, /Quality checks failed/); assert.equal(p.steps[0].status, 'failed');
  assert.equal(phase(item, 'kv').status, 'passed'); assert.equal(item.result.kv, 'q8_0');
  assert.equal(item.result.sampling.failed, true);
  const o = f.options('Qwen3-8B-Instruct');
  for (const k of ['temp', 'top-p', 'top-k', 'min-p', 'repeat-penalty']) assert.equal(o[k], undefined, k);
  // Restored byte-identically before KV ran: the first KV probe saw no sampling keys.
  atKv = f.requests.find(r => r.options['cache-type-k'] === 'f16');
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

test('#328 baseline passing every probe reuses the f16 candidate instead of loading f16 twice', async t => {
  const f = fixture(t);
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(item.baseline, { reference: 'f16', probes: ['arithmetic', 'extraction', 'reasoning'], skipped: [] });
  // One probe set at f16 (the KV candidate, which is the baseline), none measured separately.
  assert.equal(f.requests.filter(r => r.options['cache-type-k'] === 'f16' && QUALITY.some(q => q.prompt === r.prompt)).length, 3);
  assert.equal(phase(item, 'kv').steps.find(s => s.id === 'f16').status, 'passed');
  assert.ok(j.log.some(l => /^Quality baseline at f16 KV cache, drafting off: arithmetic passed, extraction passed, reasoning passed\.$/.test(l.text)));
  assert.deepEqual(item.result.baseline, item.baseline);
});

test('#328 a probe the model fails at its reference settings is skipped, and the tune completes on the others', async t => {
  const f = fixture(t, { answerFor: e2b });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(item.baseline, { reference: 'f16', probes: ['extraction', 'reasoning'], skipped: [{ id: 'arithmetic', reason: 'mismatch', answer: '69' }] });
  assert.equal(probeRequests(f, 'arithmetic').length, 1, 'arithmetic is asked once, for the baseline, then never again');
  assert.ok(probeRequests(f, 'extraction').length > 5, 'the discriminative probes still gate every later step');
  assert.deepEqual(item.phases.map(p => p.status), ['passed', 'passed', 'passed', 'passed', 'passed']);
  assert.equal(item.result.kv, 'q8_0');
  assert.deepEqual(item.result.quality.skipped, ['arithmetic']);
  assert.ok(item.result.quality.checks.every(c => c.id !== 'arithmetic' && c.passed));
  assert.ok(j.log.some(l => l.text.includes('arithmetic skipped (the model gets this wrong at its reference settings; answered "69")')));
});

test('#328 a candidate that breaks a probe the baseline passed still fails', async t => {
  const f = fixture(t, { badQ4: false, answerFor: ({ q, o }) => e2b({ q }) ?? (q.id === 'extraction' && o['cache-type-k'] === 'q5_0' ? 'AX-471' : null) });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), kv = phase(j.models[0], 'kv');
  assert.equal(j.status, 'passed', j.error);
  const q50 = kv.steps.find(s => s.id === 'q5_0');
  assert.equal(q50.status, 'failed');
  assert.equal(q50.reason, 'Quality checks failed: extraction (mismatch). Answered extraction: "AX-471".');
  assert.equal(kv.steps.find(s => s.id === 'q5_1').status, 'passed');
  assert.equal(j.models[0].result.kv, 'q5_1');
});

test('#328 a model that fails every probe at its reference settings stops with a clear reason', async t => {
  const f = fixture(t, { rejectAll: true });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), kv = phase(j.models[0], 'kv');
  assert.equal(j.status, 'failed');
  assert.match(j.error, /^The model failed every quality probe at its reference settings/);
  assert.match(j.error, /arithmetic \(mismatch\), extraction \(mismatch\), reasoning \(mismatch\)/);
  assert.equal(kv.status, 'failed'); assert.equal(kv.restored, true);
  assert.deepEqual(kv.steps.map(s => s.status), ['failed', 'pending', 'pending', 'pending'], 'no further candidate is measured');
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
  assert.equal(phase(item, 'kv').steps.find(s => s.id === 'f16').status, 'failed');
  assert.equal(item.result.kv, 'q8_0');
  assert.ok(j.log.some(l => /^Quality baseline at the current settings, drafting off:/.test(l.text)));
});

test('#328 an engine error during the baseline never marks a probe as one the model gets wrong', async t => {
  // f16 loads but the engine errors on one probe: that f16 run cannot be the baseline, so the
  // current settings supply it, with every probe still counted.
  const f = fixture(t, { httpFor: ({ q, o }) => q?.id === 'extraction' && o['cache-type-k'] === 'f16' ? 500 : 0 });
  await f.manager.autotune.start('synthetic', { confirmPause: true });
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(item.baseline, { reference: 'current', probes: ['arithmetic', 'extraction', 'reasoning'], skipped: [] });
  assert.match(phase(item, 'kv').steps.find(s => s.id === 'f16').reason, /extraction \(HTTP 500\)/);
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
  assert.deepEqual(f.manager.autotune.status('synthetic').body.kvCandidates, ['f16', 'q8_0', 'q5_1', 'q5_0']);
  process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV = '1';
  t.after(() => { delete process.env.NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV; });
  assert.deepEqual(f.manager.autotune.status('synthetic').body.kvCandidates, ['f16', 'q8_0', 'q5_1', 'q5_0', 'q4_0']);
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
// Synthetic facts: a small dense model whose f16 KV cache fits 16k context in the 16 GiB budget.
// The fake engine recalls the marker up to 8k with f16 and up to 16k with a quantized cache.
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
  // 16k f16 forgets the marker, 8k passes, 12k forgets: 8k with f16.
  assert.deepEqual(results.filter(r => r.step === 'probe').map(r => [r.ctx, r.kv, r.outcome]),
    [[16384, 'f16', 'recall_failed'], [8192, 'f16', 'passed'], [12288, 'f16', 'recall_failed']]);
  assert.deepEqual(results.filter(r => r.step !== 'probe').map(r => r.step + (r.id ? ':' + r.id : '') + ':' + r.outcome),
    ['phase:sampling:skipped', 'phase:drafting:passed', 'phase:batch:passed', 'verify:passed', 'serving:skipped']);
  assert.equal(item.result.context, 8192);
  assert.equal(item.result.kv, 'f16');
  assert.equal(item.result.plan, 'wasm');
  assert.equal(f.options('synthetic')['ctx-size'], '8192');
  assert.equal(f.options('synthetic')['cache-type-k'], 'f16');
  // No repeated full context re-measurements in drafting or batch.
  for (const id of ['drafting', 'batch']) assert.ok(!phase(item, id).steps.some(s => /Context check/.test(s.label)), id);
  assert.deepEqual(phase(item, 'context').steps.map(s => s.label), ['Fill 16,384 · f16 KV cache', 'Fill 8,192 · f16 KV cache', 'Fill 12,288 · f16 KV cache']);
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
  assert.deepEqual(seen[0].kv, ['f16', 'q8_0', 'q5_1', 'q5_0']);
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
    if (cancelOnce && o['ctx-size'] === '8192' && o['cache-type-k'] === 'f16' && manager.autotune.status().body.job?.models[0].plan?.results.length === 1) { cancelOnce = false; manager.autotune.cancel(); }
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
    [[16384, 'f16', 'recall_failed'], [8192, 'f16', 'passed'], [12288, 'f16', 'recall_failed']]);
  assert.equal(j.models[0].result.context, 8192);
  assert.equal(backups(f.ini).length, 1);
});
