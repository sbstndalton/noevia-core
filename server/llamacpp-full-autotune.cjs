'use strict';
// A durable ordered script: one model lease, then KV, context, drafting and batch commits.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WORKLOADS, SPEC_CANDIDATES, geomean } = require('./llamacpp-autotune.cjs');
const VERSION = 3;
const KV = ['f16', 'q8_0', 'q4_0'];
const UBATCH = [512, 1024, 2048];
const PAD = 'The garden committee reviewed irrigation, seed orders, volunteer rotas and pump maintenance. ';
const PHASES = [['kv', 'KV cache'], ['context', 'Context size'], ['drafting', 'Drafting'], ['batch', 'Batch and micro-batch']];
const QUALITY = [
  { id: 'arithmetic', prompt: 'Compute (17 * 4) - 9. Reply with only the integer.', expected: '59' },
  { id: 'extraction', prompt: 'Record: name=Juniper; code=AX-417; colour=blue. Return only the code, without quotes.', expected: 'AX-417' },
  { id: 'reasoning', prompt: 'All daxes are blue. No blue things are round. Can a dax be round? Reply with only yes or no.', expected: 'no' },
];
async function qualityCheck(model, chat) {
  const checks = [];
  for (const q of QUALITY) {
    const r = await chat(model, q.prompt, 64);
    checks.push({ id: q.id, passed: !!r && r.text.trim().toLowerCase().replace(/[.!]$/, '') === q.expected.toLowerCase() });
  }
  return { passed: checks.every(c => c.passed), checks };
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = value => Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
const cancelledError = () => Object.assign(Error('Cancelled'), { cancelled: true });
const publicJob = job => job && JSON.parse(JSON.stringify(job, (key, value) =>
  key.startsWith('_') || ['originalText', 'lastRevision', 'originalRevision', 'beforeText'].includes(key) ? undefined : value));
const step = (id, label) => ({ id, label, status: 'pending' });
function newModel(model) {
  return { model, status: 'pending', phases: PHASES.map(([id, label]) => ({
    id, label, status: 'pending', steps: id === 'kv' ? KV.map(k => step(k, k + ' KV cache'))
      : id === 'drafting' ? SPEC_CANDIDATES.map(c => step(c.id, c.label))
      : id === 'batch' ? UBATCH.map(n => step(String(n), 'Micro-batch ' + n))
      : [step('capacity', 'Load and long-prompt recall')],
  })) };
}

function createFullAutotuner({ request, rawModels, presets, maintenance, applyUnlocked, identityFor,
  contextFactory, stateFile, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  betweenModelsMs = 1000, idleTimeoutMs = 300000,
  readMemory = require('./llamacpp-calibration.cjs').readMemAvailableGib, memoryFloorGib = 2, onResult = async () => {} }) {
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
  state.history ||= {};
  let cancelled = false, child = null, completion = Promise.resolve(), starting = false, inflight = null, idleAbort = null;
  const save = () => { const tmp = stateFile + '.' + crypto.randomUUID(); fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, stateFile); };
  const check = () => { if (cancelled) throw cancelledError(); };
  const note = (j, text) => { (j.log ||= []).push({ at: now(), text }); if (j.log.length > 400) j.log.shift(); save(); };
  const phaseOf = (item, id) => item.phases.find(p => p.id === id);
  const currentPhase = item => item.phases.find(p => p.status !== 'passed');
  const status = model => ({ ok: true, status: 200, body: { job: publicJob(state.job), history: model ? state.history[model] || [] : [] } });
  async function signature(model) {
    const identity = await identityFor(model);
    if (!identity) throw Error('Model identity could not be read.');
    const profile = presets.get(model);
    return hash({ version: VERSION, identity, options: sorted({ ...profile.defaults, ...profile.options }) });
  }
  async function candidates() {
    const r = await rawModels();
    if (!r.ok || !Array.isArray(r.body?.data)) throw Error('The model server is not responding.');
    const models = [], skipped = [];
    for (const row of r.body.data) {
      const profile = presets.get(row.id), args = row.status?.args || [];
      if (!profile.exists || args.some(a => ['--embedding', '--embeddings', '--rerank', '--reranking'].includes(a)) ||
          ['embedding', 'embeddings', 'rerank', 'reranking'].some(k => ['true', '1', 'on'].includes(String(profile.options[k])))) {
        skipped.push({ model: row.id, reason: 'Not a configured chat model' }); continue;
      }
      const current = await signature(row.id);
      if (state.history[row.id]?.some(h => h.version === VERSION && h.signature === current)) skipped.push({ model: row.id, reason: 'Current tune already applied' });
      else models.push(row.id);
    }
    return { models, skipped };
  }
  async function untuned() { try { return { ok: true, status: 200, body: await candidates() }; } catch (e) { return { ok: false, status: 502, body: { error: e.message } }; } }
  async function unloadAll() {
    const r = await rawModels();
    if (!r.ok || !Array.isArray(r.body?.data)) throw Error('The model server is not responding.');
    for (const row of r.body.data) if (['loaded', 'loading'].includes(row.status?.value)) {
      const u = await request('/models/unload', { method: 'POST', body: JSON.stringify({ model: row.id }) }, 60000);
      if (!u.ok) throw Error('Could not unload models before testing.');
    }
  }
  async function write(j, options) {
    check();
    if (presets.snapshot().revision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
    await unloadAll();
    const r = await applyUnlocked({ model: j.model, baseRevision: j._revision, options });
    if (!r.ok) throw Object.assign(Error(r.body?.error || 'Could not save settings; the profile may have changed.'), { fatal: r.status === 409 });
    j._revision = presets.snapshot().revision; save();
  }
  async function chat(model, prompt, max) {
    check();
    const rows = await rawModels();
    if (!rows.ok || !Array.isArray(rows.body?.data)) throw Error('The model server stopped responding.');
    if (rows.body.data.some(r => r.id !== model && ['loaded', 'loading'].includes(r.status?.value)))
      throw Object.assign(Error('Another client loaded a model during tuning.'), { fatal: true });
    const controller = new AbortController(); inflight = controller;
    let lowMemory = false;
    const guard = () => { const free = readMemory(); if (free != null && free < memoryFloorGib) { lowMemory = true; controller.abort(); } };
    guard(); const timer = setInterval(guard, 500);
    let r;
    try { r = await request('/v1/chat/completions', { method: 'POST', signal: controller.signal, body: JSON.stringify({
      model, stream: false, temperature: 0, max_tokens: max, cache_prompt: false,
      chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'user', content: prompt }],
    }) }, 180000); }
    finally { clearInterval(timer); inflight = null; }
    check();
    if (lowMemory) throw Error('Available memory fell below the safety floor.');
    if (!r.ok || !r.body?.choices?.length) return null;
    const t = r.body.timings || {};
    return { text: r.body.choices[0]?.message?.content || '', gen: Number(t.predicted_per_second),
      prompt: Number(t.prompt_per_second), drafted: Number(t.draft_n) || 0, accepted: Number(t.draft_n_accepted) || 0 };
  }
  async function load(j) {
    check();
    const response = await request('/models/load', { method: 'POST', body: JSON.stringify({ model: j.model }) }, 600000);
    if (!response.ok) throw Error('The test profile could not be loaded.');
    for (let polls = 0; polls < 1200; polls++) {
      check();
      const free = readMemory(); if (free != null && free < memoryFloorGib) throw Error('Available memory fell below the safety floor.');
      const r = await rawModels();
      if (!r.ok) throw Error('The model server stopped responding.');
      if (r.body.data.some(m => m.id !== j.model && ['loaded', 'loading'].includes(m.status?.value)))
        throw Object.assign(Error('Another client loaded a model during tuning.'), { fatal: true });
      const row = r.body.data.find(m => m.id === j.model);
      if (row?.status?.value === 'loaded') return;
      if (!row || row.status?.failed || row.status?.value === 'unloaded') throw Error('The test profile failed to load.');
      await sleep(500);
    }
    throw Error('Loading the test profile timed out.');
  }
  async function validate(model) {
    const quality = await qualityCheck(model, chat);
    if (!quality.passed) throw Error('The profile failed the three quality checks.');
    const workloads = [];
    for (const w of WORKLOADS) {
      const r = await chat(model, w.prompt, w.max);
      if (!r || !Number.isFinite(r.gen) || r.gen <= 0) throw Error('Missing throughput measurements.');
      workloads.push({ workload: w.id, gen: r.gen, drafted: r.drafted, accepted: r.accepted, text: r.text });
    }
    const drafted = workloads.reduce((n, w) => n + w.drafted, 0), accepted = workloads.reduce((n, w) => n + w.accepted, 0);
    return { quality, workloads, generation: Math.round(geomean(workloads.map(w => w.gen)) * 10) / 10,
      acceptance: drafted ? Math.round(100 * accepted / drafted) : null };
  }
  const compact = result => ({ ...result, workloads: result.workloads?.map(({ text, ...row }) => row) });
  function record(p, id, status, details = {}) {
    const row = p.steps.find(s => s.id === id);
    Object.assign(row, details, { status });
    save();
  }
  async function measure(j, p, id, options, evaluate) {
    check();
    record(p, id, 'running', { startedAt: now() });
    try {
      await write(j, options);
      await load(j);
      const result = await evaluate();
      record(p, id, 'passed', { ...compact(result), value: options, finishedAt: now() });
      return result;
    } catch (e) {
      record(p, id, cancelled ? 'interrupted' : 'failed', { reason: e.message, finishedAt: now() });
      if (e.fatal || e.cancelled || cancelled || presets.snapshot().revision !== j._revision) throw e;
      return null;
    }
  }
  async function contextStage(j, p, prefix = '') {
    check();
    if (presets.snapshot().revision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
    const offset = prefix ? p.steps.length : 0;
    child = contextFactory({
      applyUnlocked: body => {
        if (body.baseRevision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
        return applyUnlocked(body);
      },
      onWrite: revision => { j._revision = revision; save(); },
      onUpdate: c => {
        if (!c) return;
        j.phase = p.label + ': ' + c.phase;
        const steps = c.steps.map((s, index) => ({ id: prefix + index, label: prefix + (s.kind === 'long' ? 'Recall ' : 'Load ') + s.ctx,
          status: s.status === 'passed' ? 'passed' : s.status === 'running' ? 'running' : s.status === 'skipped' ? 'skipped' : 'failed',
          reason: s.reason, ctx: s.ctx, promptPerSecond: s.promptPerSecond, promptSeconds: s.promptSeconds }));
        p.steps = [...p.steps.slice(0, offset), ...steps]; save();
      },
    });
    try {
      const started = await child.start(j.model, { confirmPause: true, promptBudgetSeconds: j.promptBudgetSeconds });
      if (!started.ok) throw Error(started.body?.error || 'Context measurement could not start.');
      if (cancelled) child.cancel();
      await child.completion(); check();
      const result = child.status(j.model).body.job;
      if (result.status !== 'passed') throw Object.assign(Error(result.error || 'Context measurement failed.'), { fatal: result.restored === false });
      return result.result;
    } finally { child = null; }
  }
  async function verifyContext(j, p) {
    const committed = Number(phaseOf(j.models.find(m => m.model === j.model), 'context').value?.context);
    const measured = await contextStage(j, p, 'Context check · ');
    if (measured.appliedCtx < committed) throw Error('The saved context no longer passes with this setting.');
    if (measured.appliedCtx !== committed) {
      await write(j, { 'ctx-size': String(committed) });
      await load(j);
      const final = await qualityCheck(j.model, chat);
      if (!final.passed) throw Error('The committed context failed quality checks after verification.');
    }
  }
  async function runKv(j, p) {
    const before = { ...presets.get(j.model).options }, results = [];
    for (const kv of KV) {
      check(); note(j, 'Testing ' + kv + ' KV cache with drafting off.');
      await unloadAll();
      const measured = await measure(j, p, kv, { 'cache-type-k': kv, 'cache-type-v': kv,
        'spec-type': 'none', 'spec-draft-n-max': '', 'spec-draft-p-min': '' }, () => validate(j.model));
      if (measured) results.push({ kv, ...measured });
    }
    const best = results.sort((a, b) => b.generation - a.generation || KV.indexOf(a.kv) - KV.indexOf(b.kv))[0];
    if (!best) throw Error('No KV cache type passed quality and throughput checks.');
    const restoreSpec = Object.fromEntries(['spec-type', 'spec-draft-n-max', 'spec-draft-p-min'].map(k => [k, before[k] || '']));
    await write(j, { 'cache-type-k': best.kv, 'cache-type-v': best.kv, ...restoreSpec });
    await load(j);
    const final = await validate(j.model);
    p.value = { kv: best.kv, generation: best.generation, quality: final.quality, candidates: results.map(r => ({ kv: r.kv, generation: r.generation })) };
    note(j, 'Committed ' + best.kv + ' KV cache after quality checks.');
  }
  async function runContext(j, p) {
    const result = await contextStage(j, p);
    p.value = { context: result.appliedCtx, verifiedCtx: result.verifiedCtx, loadCtx: result.loadCtx };
    note(j, 'Committed context ' + result.appliedCtx + ' after long-prompt recall.');
  }
  async function runDrafting(j, p) {
    const results = [];
    let reference = null;
    for (const candidate of SPEC_CANDIDATES) {
      check(); note(j, 'Testing drafting: ' + candidate.label);
      await unloadAll();
      const measured = await measure(j, p, candidate.id, candidate.options, () => validate(j.model));
      if (!measured) continue;
      if (candidate.id === 'off') reference = measured.workloads.find(w => w.workload === 'list')?.text;
      if (candidate.id !== 'off' && (!measured.workloads.some(w => w.drafted > 0) ||
          measured.workloads.find(w => w.workload === 'list')?.text !== reference)) {
        record(p, candidate.id, 'failed', { reason: 'No active drafting or the deterministic list answer changed.' });
        continue;
      }
      results.push({ candidate, ...measured });
    }
    const off = results.find(r => r.candidate.id === 'off');
    if (!off) throw Error('The drafting-off baseline failed.');
    const best = results.sort((a, b) => b.generation - a.generation)[0];
    await write(j, best.candidate.options);
    await load(j);
    const final = await validate(j.model);
    await verifyContext(j, p);
    p.value = { spec: best.candidate.id, specLabel: best.candidate.label, generation: final.generation,
      acceptance: final.acceptance, quality: final.quality, baseline: off.generation };
    note(j, 'Committed drafting: ' + best.candidate.label + '.');
  }
  async function runBatch(j, p) {
    const prompt = PAD.repeat(Math.ceil(3000 / 18)) + '\nIn one sentence, what did the committee review?';
    const results = [];
    for (const ub of UBATCH) {
      check(); note(j, 'Testing micro-batch ' + ub);
      await unloadAll();
      const options = { 'ubatch-size': String(ub), 'batch-size': String(Math.max(2048, ub)) };
      const measured = await measure(j, p, String(ub), options, async () => {
        const quality = await qualityCheck(j.model, chat);
        if (!quality.passed) throw Error('The profile failed the three quality checks.');
        const r = await chat(j.model, prompt, 16);
        if (!r || !Number.isFinite(r.prompt) || r.prompt <= 0) throw Error('Missing prompt throughput measurement.');
        return { promptPerSecond: Math.round(r.prompt), quality };
      });
      if (measured) results.push({ ub, ...measured });
    }
    const best = results.sort((a, b) => b.promptPerSecond - a.promptPerSecond || a.ub - b.ub)[0];
    if (!best) throw Error('No micro-batch setting passed quality and prompt throughput checks.');
    await write(j, { 'ubatch-size': String(best.ub), 'batch-size': String(Math.max(2048, best.ub)) });
    await load(j);
    const final = await validate(j.model);
    await verifyContext(j, p);
    p.value = { ubatch: best.ub, batch: Math.max(2048, best.ub), promptPerSecond: best.promptPerSecond,
      generation: final.generation, acceptance: final.acceptance, quality: final.quality };
    note(j, 'Committed micro-batch ' + best.ub + '.');
  }
  const phaseRuns = { kv: runKv, context: runContext, drafting: runDrafting, batch: runBatch };
  async function restorePhase(j, p) {
    if (p._beforeText == null) return true;
    if (presets.snapshot().revision !== j._revision) { p.restored = false; return false; }
    try {
      await unloadAll();
      presets.commit({ baseRevision: j._revision, text: p._beforeText });
      j._revision = presets.snapshot().revision; save();
      const reload = await request('/models?reload=1', {}, 120000);
      if (!reload.ok) throw Error('The router did not confirm restored settings.');
      p.restored = true;
      delete p._beforeText; save();
      return true;
    } catch { p.restored = false; save(); return false; }
  }
  async function runPhase(j, item, p) {
    check();
    if (presets.snapshot().revision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
    p._beforeText = presets.snapshot().text;
    p.status = 'running'; p.startedAt = now();
    p.steps = p.id === 'kv' ? KV.map(k => step(k, k + ' KV cache'))
      : p.id === 'drafting' ? SPEC_CANDIDATES.map(c => step(c.id, c.label))
      : p.id === 'batch' ? UBATCH.map(n => step(String(n), 'Micro-batch ' + n))
      : [step('capacity', 'Load and long-prompt recall')];
    j.phase = p.label; save();
    try {
      await phaseRuns[p.id](j, p); check();
      if (presets.snapshot().revision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
      p.status = 'passed'; p.finishedAt = now(); p._committedRevision = j._revision;
      delete p._beforeText; save();
    } catch (e) {
      const restored = await restorePhase(j, p);
      p.status = cancelled || e.cancelled ? 'interrupted' : 'failed'; p.reason = e.message;
      for (const s of p.steps) if (s.status === 'running') { s.status = 'interrupted'; s.reason = e.message; }
      p.finishedAt = now(); save();
      if (!restored) throw Object.assign(Error(e.message + ' Settings changed or restoration failed; inspect models.ini before resuming.'), { unsafe: true });
      throw e;
    }
  }
  async function finishModel(j, item) {
    const kv = phaseOf(item, 'kv').value, ctx = phaseOf(item, 'context').value,
      draft = phaseOf(item, 'drafting').value, batch = phaseOf(item, 'batch').value;
    const result = { kv: kv.kv, context: ctx.context, spec: draft.spec, specLabel: draft.specLabel,
      generation: batch.generation, acceptance: batch.acceptance, ubatch: batch.ubatch,
      promptPerSecond: batch.promptPerSecond, quality: batch.quality, extensions: [],
      loaded: true, version: VERSION, signature: await signature(item.model) };
    item.result = result; item.status = 'passed';
    state.history[item.model] = [{ at: now(), ...result }, ...(state.history[item.model] || [])].slice(0, 10);
    save();
    try { await onResult({ model: item.model, result }); } catch { note(j, 'Settings saved, but qualification evidence could not be recorded.'); }
  }
  async function run(j) {
    try {
      for (let index = 0; index < j.models.length; index++) {
        check();
        const item = j.models[index];
        if (item.status === 'passed') continue;
        j.model = item.model;
        j.phase = 'Waiting for chat to become idle'; j.waiting = true; save();
        idleAbort = new AbortController();
        let release;
        try {
          release = await maintenance.holdWhenIdle('Chat is paused while noevia tunes ' + item.model + ': preparing.', {
            timeoutMs: idleTimeoutMs, signal: idleAbort.signal,
          });
          idleAbort = null; j.waiting = false; item.status = 'running'; save();
          const identity = await identityFor(item.model);
          const stableIdentity = hash({ ...identity, profile: undefined });
          if (item._identity && item._identity !== stableIdentity) throw Object.assign(Error('Model identity changed since tuning began.'), { fatal: true });
          item._identity = stableIdentity;
          if (presets.snapshot().revision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
          for (const p of item.phases) {
            if (p.status === 'passed') continue;
            check(); j.phase = p.label;
            release.setReason('Chat is paused while noevia tunes ' + item.model + ': ' + p.label.toLowerCase() + '.');
            await runPhase(j, item, p);
          }
          await finishModel(j, item);
        } finally {
          idleAbort = null; j.waiting = false; release?.(); save();
        }
        j.queueProgress = { done: j.models.filter(m => m.status === 'passed').length, total: j.models.length }; save();
        if (index < j.models.length - 1) {
          j.phase = 'Chat is available between models'; save();
          await sleep(betweenModelsMs); check();
        }
      }
      j.status = 'passed'; j.phase = 'Done';
    } catch (e) {
      j.status = cancelled || e.cancelled ? 'cancelled' : e.idleTimeout ? 'interrupted' : 'failed';
      j.phase = j.status === 'cancelled' ? 'Cancelled' : j.status === 'interrupted' ? 'Waiting timed out' : 'Failed';
      j.error = e.message;
      if (e.unsafe) j._unsafe = true;
      const item = j.models?.find(m => m.model === j.model && m.status === 'running');
      if (item) { item.status = j.status === 'cancelled' ? 'interrupted' : 'failed'; item.error = e.message; }
    } finally {
      j.finishedAt = now(); j.waiting = false; child = null; idleAbort = null; save();
    }
  }
  async function start(model, { confirmPause, promptBudgetSeconds = 120, untuned: bulk = false } = {}) {
    if (confirmPause !== true) return { ok: false, status: 400, body: { error: 'Confirm that chat can pause and other model-server clients are stopped.' } };
    promptBudgetSeconds = Number(promptBudgetSeconds);
    if (!Number.isInteger(promptBudgetSeconds) || promptBudgetSeconds < 15 || promptBudgetSeconds > 1800)
      return { ok: false, status: 400, body: { error: 'Choose a prompt time limit between 15 and 1800 seconds.' } };
    if (starting || state.job?.status === 'running') return { ok: false, status: 409, body: { error: 'Auto-tune is already running.' } };
    starting = true;
    try {
      const scan = await candidates();
      const models = bulk ? scan.models : [model];
      if (!bulk && ![...scan.models, ...scan.skipped.filter(s => s.reason === 'Current tune already applied').map(s => s.model)].includes(model))
        return { ok: false, status: 400, body: { error: 'Choose a configured chat model.' } };
      if (!models.length) return { ok: false, status: 409, body: { error: 'All configured chat models already have current tunes.' } };
      cancelled = false;
      const j = { id: crypto.randomUUID(), model: models[0], bulk, promptBudgetSeconds, status: 'running',
        phase: 'Preparing', startedAt: now(), log: [], models: models.map(newModel), _revision: presets.snapshot().revision,
        queueProgress: { done: 0, total: models.length } };
      state.job = j; save(); completion = run(j); completion.catch(() => {});
      return { ok: true, status: 202, body: publicJob(j) };
    } catch (e) { return { ok: false, status: 409, body: { error: e.message } }; }
    finally { starting = false; }
  }
  function cancel() {
    if (state.job?.status !== 'running') return { ok: false, status: 409, body: { error: 'No auto-tune is running.' } };
    cancelled = true; child?.cancel(); inflight?.abort(); idleAbort?.abort();
    return { ok: true, status: 202, body: publicJob(state.job) };
  }
  async function recover() {
    const j = state.job;
    if (j?.status !== 'running') return;
    // Pre-v3 jobs have a single snapshot. They cannot be resumed into the new phase schema.
    if (!Array.isArray(j.models)) {
      if (j.originalText && presets.snapshot().revision === j.lastRevision) {
        try { presets.commit({ baseRevision: j.lastRevision, text: j.originalText }); await request('/models?reload=1', {}, 120000); } catch { j.restored = false; }
      }
      delete j.originalText; j.status = 'interrupted'; j.error = 'An older tuning run was interrupted. Start a new tune.'; save(); return;
    }
    const item = j.models.find(m => m.status === 'running');
    const p = item?.phases.find(p => p.status === 'running');
    if (p) {
      const restored = await restorePhase(j, p);
      p.status = 'interrupted'; p.reason = 'Restart interrupted this phase.';
      for (const s of p.steps) if (s.status === 'running') { s.status = 'interrupted'; s.reason = p.reason; }
      if (!restored) j._unsafe = true;
      item.status = 'interrupted';
    }
    else if (item) item.status = 'interrupted';
    j.status = 'interrupted'; j.phase = 'Interrupted'; j.finishedAt = now();
    j.error = j._unsafe ? 'Restart interrupted tuning; settings could not safely be restored. Inspect models.ini before resuming.'
      : 'Restart interrupted tuning. Completed settings remain saved.';
    save();
  }
  async function resume({ confirmPause } = {}) {
    if (confirmPause !== true) return { ok: false, status: 400, body: { error: 'Confirm that chat can pause before resuming auto-tune.' } };
    const j = state.job;
    if (starting || !j || !['cancelled', 'interrupted', 'failed'].includes(j.status) || !Array.isArray(j.models))
      return { ok: false, status: 409, body: { error: 'No resumable auto-tune is available.' } };
    if (j._unsafe || j.models.some(m => m.phases.some(p => p.restored === false)))
      return { ok: false, status: 409, body: { error: 'Settings could not safely be restored; inspect models.ini before starting a new tune.' } };
    if (presets.snapshot().revision !== j._revision)
      return { ok: false, status: 409, body: { error: 'Settings changed outside auto-tune. Start a new tune after reviewing them.' } };
    starting = true;
    try {
      const rows = await rawModels();
      if (!rows.ok || !Array.isArray(rows.body?.data)) throw Error('The model server is not responding.');
      for (const item of j.models.filter(m => m.status !== 'passed')) {
        if (!rows.body.data.some(row => row.id === item.model) || !presets.get(item.model).exists) throw Error('A queued model is no longer configured.');
        const identity = await identityFor(item.model);
        if (item._identity && item._identity !== hash({ ...identity, profile: undefined })) throw Error('A queued model changed since tuning began.');
      }
      cancelled = false; j.status = 'running'; j.error = undefined; j.finishedAt = undefined;
      for (const item of j.models) if (item.status !== 'passed') {
        item.status = 'pending'; delete item.error;
        for (const p of item.phases) if (p.status !== 'passed') {
          p.status = 'pending'; delete p.reason; delete p.restored;
          p.steps = p.steps.map(s => ({ ...s, status: 'pending', reason: undefined }));
        }
      }
      save(); completion = run(j); completion.catch(() => {});
      return { ok: true, status: 202, body: publicJob(j) };
    } catch (e) { return { ok: false, status: 409, body: { error: e.message } }; }
    finally { starting = false; }
  }
  return { start, resume, cancel, status, untuned, recover, completion: () => completion };
}
module.exports = { createFullAutotuner, qualityCheck, QUALITY, VERSION };
