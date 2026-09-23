'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createModelManager } = require('./model-manager.cjs');
const { createPresetStore } = require('./llamacpp-presets.cjs');
const { QUALITY, qualityCheck } = require('./llamacpp-full-autotune.cjs');

function fixture(t, { models = ['synthetic'], onChat, badQ4 = true, noHead = false, rejectAll = false, rejectModel = '', badBatch = false, failFinal = false, idleTimeoutMs = 300000, loseIdentityAfterStart = false, reloadFail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-tune-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ini = path.join(dir, 'models.ini'), stateFile = path.join(dir, 'tune.json');
  const original = 'version = 1\n' + [...models, 'embed'].map(m => `[${m}]\nmodel = /models/${m}.gguf\nctx-size = 8192\nparallel = 1\n`).join('');
  fs.writeFileSync(ini, original);
  const presets = createPresetStore(ini), status = Object.fromEntries([...models, 'embed'].map(m => [m, 'unloaded']));
  const requests = [], options = m => presets.get(m).options;
  let chats = 0, build = 'fake-v1', identityReads = 0;
  const fetchJson = async (url, opts = {}) => {
    const u = new URL(url), b = opts.body ? JSON.parse(opts.body) : {};
    if (opts.signal?.aborted) throw Error('aborted');
    if (u.pathname === '/models' && u.searchParams.has('reload')) return { ok: !reloadFail, body: {} };
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
      if (q && (rejectAll || b.model === rejectModel || (badQ4 && o['cache-type-k'] === 'q4_0'))) text = 'wrong';
      if (badBatch && q && o['ubatch-size']) text = 'wrong';
      if (failFinal && q && manager.autotune.status().body.job?.phase === 'Verifying saved profile') text = 'wrong';
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
    autotuneOptions: { sleep: async () => {}, betweenModelsMs: 25, idleTimeoutMs, readMemory: () => 20, identityFor: async m => (++identityReads > 1 && loseIdentityAfterStart ? null : { model: m, hardware: 'fake', build }) } });
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

const phase = (item, id) => item.phases.find(p => p.id === id);
test('ordered script commits KV, context, drafting and batch with measured evidence', async t => {
  const f = fixture(t);
  assert.deepEqual((await f.manager.autotune.untuned()).body.models, ['synthetic']);
  assert.equal((await f.manager.autotune.start('synthetic', { confirmPause: true })).status, 202);
  const j = await finished(f.manager), item = j.models[0];
  assert.equal(j.status, 'passed', j.error);
  assert.deepEqual(item.phases.map(p => [p.id, p.status]), [['kv','passed'],['context','passed'],['drafting','passed'],['batch','passed']]);
  assert.equal(item.result.kv, 'q8_0'); assert.equal(item.result.spec, 'mtp-deep');
  assert.equal(item.result.context, 16384); assert.equal(item.result.acceptance, 65);
  assert.equal(item.result.generation, 60);
  assert.equal(item.result.ubatch, 1024);
  assert.equal(phase(item, 'kv').steps.find(s => s.id === 'q4_0').status, 'failed');
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
  store.commit(probe);
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
  assert.deepEqual(j.models[0].phases.map(p => p.status), ['passed','passed','passed','passed']);
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
