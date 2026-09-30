'use strict';
// A durable ordered script: one model lease, then KV, context, drafting and batch commits.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WORKLOADS, SPEC_CANDIDATES, geomean } = require('./llamacpp-autotune.cjs');
const { hasHarmonyReasoning, quirksOf, toIniOptions, INI_KEY_LIST } = require('./sampling-recommendation.cjs');
const { isSystemModel, modelPathFromArgs, SYSTEM_MODEL_REASON } = require('./model-system.cjs');
const VERSION = 3;
// Q5 is the automatic floor for KV cache quantization (issue #190): Q4 degrades quality too
// much to select automatically. Q4 stays reachable only through an explicit override env var,
// never as a routine candidate, and never below Q5 by default. f16/q8_0 remain above the floor.
const KV_FLOOR_OVERRIDE_ENV = 'NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV';
const allowBelowQ5Kv = () => ['1', 'true', 'yes', 'on'].includes(String(process.env[KV_FLOOR_OVERRIDE_ENV] || '').toLowerCase());
const kvCandidates = () => allowBelowQ5Kv() ? ['f16', 'q8_0', 'q5_1', 'q5_0', 'q4_0'] : ['f16', 'q8_0', 'q5_1', 'q5_0'];
const UBATCH = [512, 1024, 2048];
const PAD = 'The garden committee reviewed irrigation, seed orders, volunteer rotas and pump maintenance. ';
const PHASES = [['sampling', 'Sampling'], ['kv', 'KV cache'], ['context', 'Context size'], ['drafting', 'Drafting'], ['batch', 'Batch and micro-batch']];
const QUALITY = [
  { id: 'arithmetic', prompt: 'Compute (17 * 4) - 9. Reply with only the integer.', expected: '59' },
  { id: 'extraction', prompt: 'Record: name=Juniper; code=AX-417; colour=blue. Return only the code, without quotes.', expected: 'AX-417' },
  { id: 'reasoning', prompt: 'All daxes are blue. No blue things are round. Can a dax be round? Reply with only yes or no.', expected: 'no' },
];
// Family facts (Harmony reasoning budget and effort) come from the shared per-family table (#308, #328).
// A short final answer may follow analysis on Harmony models. Keep this finite and
// require the final content itself to pass every probe; analysis is not an answer.
const qualityBudget = model => quirksOf(model).qualityBudget || 64;
function normalizedAnswer(text) {
  let answer = text.trim().toLowerCase();
  // Accept formatting around the entire answer, never a correct substring inside prose.
  for (const mark of ['**', '__', '`']) {
    if (answer.startsWith(mark) && answer.endsWith(mark) && answer.length > mark.length * 2)
      answer = answer.slice(mark.length, -mark.length).trim();
  }
  return answer.replace(/[.!]$/, '').trim();
}
// Arithmetic only: a worked line such as `68 - 9 = 59` is a correct answer. Everything in the reply
// must be numeric/operator characters and the value after the last `=` must be exactly the expected
// integer, so prose ("not 59, it's 61") and lists ("59 or 61") still fail.
const WORKED_SUM = /^[\d\s+\-−*x×÷/().]+(?:=\s*[\d\s+\-−*x×÷/().]+)*=\s*(\d+)$/;
const acceptsAnswer = (q, answer) => answer === q.expected.toLowerCase()
  || (q.id === 'arithmetic' && WORKED_SUM.exec(answer)?.[1] === q.expected);
// A short, printable excerpt of a wrong answer so the panel shows what the model said.
const snippetOf = text => {
  const flat = String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 24 ? flat.slice(0, 23) + '…' : flat;
};
// #328: the gate is relative. A baseline measured once per model at its reference settings (f16
// KV cache and drafting off, or the current profile when f16 does not load) decides which probes
// can discriminate for this model: a probe the model already gets wrong there says nothing about
// the tuned settings, so candidates are judged only on the probes the baseline passed and are not
// sent the others. Without a baseline (an older resumed job) every probe is required, as before.
async function qualityCheck(model, chat, baseline = null) {
  const checks = [];
  const probes = baseline ? QUALITY.filter(q => baseline.probes.includes(q.id)) : QUALITY;
  for (const q of probes) {
    const r = await chat(model, q.prompt, qualityBudget(model));
    const answer = typeof r?.text === 'string' ? normalizedAnswer(r.text) : '';
    const reason = r?.failure || (r?.finishReason === 'length' ? 'truncated' : !answer ? 'no response' :
      !acceptsAnswer(q, answer) ? 'mismatch' : null);
    checks.push({ id: q.id, passed: !reason, ...(reason ? { reason } : {}),
      ...(reason === 'mismatch' ? { answer: snippetOf(r.text) } : {}) });
  }
  const skipped = baseline ? baseline.skipped.map(s => s.id) : [];
  return { passed: checks.every(c => c.passed), checks, ...(skipped.length ? { skipped } : {}) };
}
const qualityFailure = quality => 'Quality checks failed: ' + quality.checks.filter(c => !c.passed)
  .map(c => c.id + ' (' + c.reason + ')').join(', ') + '.' + quality.checks
  .filter(c => !c.passed && c.answer).map(c => ' Answered ' + c.id + ': "' + c.answer + '".').join('');
// An HTTP error is the engine failing, not the model answering: it cannot mark a probe as one the
// model gets wrong, so a baseline with one is not usable.
const engineFailed = quality => quality.checks.some(c => /^HTTP\b/.test(c.reason || ''));
const REFERENCE_LABEL = { f16: 'f16 KV cache, drafting off', current: 'the current settings, drafting off' };
function baselineOf(reference, quality) {
  return { reference, probes: quality.checks.filter(c => c.passed).map(c => c.id),
    skipped: quality.checks.filter(c => !c.passed).map(c => ({ id: c.id, reason: c.reason, ...(c.answer ? { answer: c.answer } : {}) })) };
}
const baselineSummary = b => 'Quality baseline at ' + REFERENCE_LABEL[b.reference] + ': ' + [
  ...b.probes.map(id => id + ' passed'),
  ...b.skipped.map(s => s.id + ' skipped (the model gets this wrong at its reference settings'
    + (s.answer ? '; answered "' + s.answer + '"' : '') + ')'),
].join(', ') + '.';
const NO_PROBE_PASSED = 'The model failed every quality probe at its reference settings, so auto-tune cannot tell whether a setting harms it.';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = value => Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
const cancelledError = () => Object.assign(Error('Cancelled'), { cancelled: true });
const publicJob = job => job && JSON.parse(JSON.stringify(job, (key, value) =>
  key.startsWith('_') || ['originalText', 'lastRevision', 'originalRevision', 'beforeText'].includes(key) ? undefined : value));
const step = (id, label) => ({ id, label, status: 'pending' });
function stepsFor(id) {
  return id === 'sampling' ? [step('apply', 'Recommended sampling')]
    : id === 'kv' ? kvCandidates().map(k => step(k, k + ' KV cache'))
    : id === 'drafting' ? SPEC_CANDIDATES.map(c => step(c.id, c.label))
    : id === 'batch' ? UBATCH.map(n => step(String(n), 'Micro-batch ' + n))
    : [step('capacity', 'Load and long-prompt recall')];
}
function newModel(model) {
  return { model, status: 'pending', phases: PHASES.map(([id, label]) => ({
    id, label, status: 'pending', steps: stepsFor(id),
  })) };
}

// Messages written for people carry publicMessage; anything else (fs, network, parser detail)
// is logged and replaced by a fixed sentence before it reaches the client.
const publicFail = message => Object.assign(Error(message), { publicMessage: message });
function clientMessage(e, fallback) {
  if (e?.publicMessage) return String(e.publicMessage);
  if (Number.isInteger(e?.status) && e.status < 500 && e.message) return e.message;
  console.error('[autotune]', e?.stack || e);
  return fallback;
}

function createFullAutotuner({ request, rawModels, presets, maintenance, applyUnlocked, identityFor,
  contextFactory, samplingFor = null, stateFile, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  betweenModelsMs = 1000, idleTimeoutMs = 300000,
  readMemory = require('./llamacpp-calibration.cjs').readMemAvailableGib, memoryFloorGib = 2, onResult = async () => {},
  // #545: true when a router row is a preset whose model file is not in the models folder.
  fileMissing = () => false }) {
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
  state.history ||= {};
  let cancelled = false, child = null, completion = Promise.resolve(), starting = false, inflight = null, idleAbort = null;
  const save = () => { const tmp = stateFile + '.' + crypto.randomUUID(); fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, stateFile); };
  const check = () => { if (cancelled) throw cancelledError(); };
  const note = (j, text) => { (j.log ||= []).push({ at: now(), text }); if (j.log.length > 400) j.log.shift(); save(); };
  const phaseOf = (item, id) => item.phases.find(p => p.id === id);
  const currentPhase = item => item.phases.find(p => p.status !== 'passed');
  // kvCandidates: the list this server really tries, so the panel never describes another build's.
  const status = model => ({ ok: true, status: 200, body: { job: publicJob(state.job), history: model ? state.history[model] || [] : [], kvCandidates: kvCandidates() } });
  async function signature(model, suppliedIdentity) {
    const identity = suppliedIdentity || await identityFor(model);
    if (!identity) throw publicFail('Model identity could not be read.');
    const profile = presets.get(model);
    return hash({ version: VERSION, identity, options: sorted({ ...profile.defaults, ...profile.options }) });
  }
  async function candidates() {
    const r = await rawModels();
    if (!r.ok || !Array.isArray(r.body?.data)) throw publicFail('The model server is not responding.');
    const models = [], skipped = [];
    for (const row of r.body.data) {
      const profile = presets.get(row.id), args = row.status?.args || [];
      if (isSystemModel(row.id, modelPathFromArgs(args))) {
        skipped.push({ model: row.id, reason: SYSTEM_MODEL_REASON }); continue;
      }
      if (fileMissing(row)) { skipped.push({ model: row.id, reason: 'Model file missing from the models folder' }); continue; }
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
  async function untuned() { try { return { ok: true, status: 200, body: await candidates() }; } catch (e) { return { ok: false, status: 502, body: { error: clientMessage(e, 'Could not list untuned models.') } }; } }
  async function unloadAll({ restoring = false } = {}) {
    if (!restoring) check();
    const r = await rawModels();
    if (!r.ok || !Array.isArray(r.body?.data)) throw Error('The model server is not responding.');
    for (const row of r.body.data) if (['loaded', 'loading'].includes(row.status?.value)) {
      if (!restoring) check();
      const u = await request('/models/unload', { method: 'POST', body: JSON.stringify({ model: row.id }) }, 60000);
      if (!u.ok) throw Error('Could not unload ' + row.id + ' before testing.');
    }
    // The router acknowledges unload before its model state changes. Profile writes require
    // every row to be exactly unloaded; transitional and failed states remain unsafe.
    const deadline = now() + 60000;
    for (let poll = 0; poll < 120; poll++) {
      if (!restoring) check();
      const listing = await rawModels();
      if (!listing.ok || !Array.isArray(listing.body?.data)) throw Error('The model server stopped responding while unloading.');
      const pending = listing.body.data.filter(row => row.status?.value !== 'unloaded');
      if (!pending.length) return;
      if (poll === 119 || now() >= deadline) throw Error('Timed out waiting for router unload: ' + pending.map(row =>
        row.id + ' (' + (row.status?.value || 'unknown') + ')').join(', ') + '.');
      await sleep(500);
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
      ...(quirksOf(model).reasoningEffort ? { reasoning_effort: quirksOf(model).reasoningEffort } : {}),
      chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'user', content: prompt }],
    }) }, 180000); }
    finally { clearInterval(timer); inflight = null; }
    check();
    if (lowMemory) throw Error('Available memory fell below the safety floor.');
    if (!r.ok) return { failure: 'HTTP ' + (r.status || 'error') };
    if (!r.body?.choices?.length) return { failure: 'no response' };
    const t = r.body.timings || {};
    return { text: r.body.choices[0]?.message?.content || '', gen: Number(t.predicted_per_second),
      prompt: Number(t.prompt_per_second), drafted: Number(t.draft_n) || 0, accepted: Number(t.draft_n_accepted) || 0,
      finishReason: r.body.choices[0]?.finish_reason };
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
  // The baseline of the model being tuned, once it has at least one discriminative probe.
  const gate = model => { const b = state.job?.models?.find(m => m.model === model)?.baseline; return b?.probes?.length ? b : null; };
  async function validate(model, measured = null) {
    const quality = measured || await qualityCheck(model, chat, gate(model));
    if (!quality.passed) throw Error(qualityFailure(quality));
    const workloads = [];
    for (const w of WORKLOADS) {
      const r = await chat(model, w.prompt, hasHarmonyReasoning(model) ? Math.max(w.max, 512) : w.max);
      if (!r || !Number.isFinite(r.gen) || r.gen <= 0) throw Error('Missing throughput measurements.');
      // These are capped timing samples, so a nonempty sample may finish at the cap.
      // An analysis-only reply has no final sample to compare or measure.
      if (!r.text?.trim()) throw Error('Workload did not produce a final answer.');
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
      applyUnlocked: async body => {
        if (body.baseRevision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
        await unloadAll();
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
      const final = await qualityCheck(j.model, chat, gate(j.model));
      if (!final.passed) throw Error(qualityFailure(final));
    }
  }
  const BASELINE_KEYS = ['cache-type-k', 'cache-type-v', 'spec-type', 'spec-draft-n-max', 'spec-draft-p-min'];
  const REFERENCE = { 'cache-type-k': 'f16', 'cache-type-v': 'f16', 'spec-type': 'none', 'spec-draft-n-max': '', 'spec-draft-p-min': '' };
  const keysOf = options => Object.fromEntries(BASELINE_KEYS.map(k => [k, options[k] || '']));
  // Records the baseline on the model's queue entry (kept across Resume) and stops the job when
  // no probe passed: then no setting can be judged. That is fatal on purpose, so the optional
  // sampling phase cannot swallow it.
  function setBaseline(j, reference, quality) {
    const item = j.models.find(m => m.model === j.model);
    item.baseline = baselineOf(reference, quality); save();
    note(j, baselineSummary(item.baseline));
    if (!item.baseline.probes.length) throw Object.assign(Error(NO_PROBE_PASSED + ' ' + qualityFailure(quality)), { fatal: true, publicMessage: NO_PROBE_PASSED });
    return item.baseline;
  }
  // Measures the baseline when a phase needs it before the KV phase's f16 candidate can supply it
  // (sampling about to be applied, or f16 did not load). Tries f16 first, then the settings the
  // phase started from, and always leaves the KV and drafting keys as it found them.
  async function ensureBaseline(j, original, { tryF16 = true } = {}) {
    if (gate(j.model)) return;
    const restore = keysOf(original);
    const attempt = async (reference, options) => {
      check(); note(j, 'Measuring the quality baseline at ' + REFERENCE_LABEL[reference] + '.');
      try {
        await write(j, options); await load(j);
        const quality = await qualityCheck(j.model, chat);
        if (engineFailed(quality)) throw Error(qualityFailure(quality));
        return quality;
      } catch (e) {
        if (e.fatal || e.cancelled || cancelled) throw e;
        note(j, 'The baseline at ' + REFERENCE_LABEL[reference] + ' could not be measured: ' + e.message);
        return null;
      }
    };
    let reference = 'f16', quality = tryF16 ? await attempt('f16', REFERENCE) : null;
    if (!quality) { reference = 'current'; quality = await attempt('current', { ...restore, 'spec-type': 'none', 'spec-draft-n-max': '', 'spec-draft-p-min': '' }); }
    await write(j, restore);
    if (!quality) throw Object.assign(Error('The quality baseline could not be measured at the reference or current settings.'), { fatal: true });
    setBaseline(j, reference, quality);
  }
  // Scripted, deterministic (#308): the recommendation table decides, nothing is measured to
  // choose it. Written through the same applyUnlocked path as every other step (so
  // MODELS_INI_WRITER=model-loader keeps a single writer), loaded and probed once to prove the
  // engine accepts it, and put back by runPhase's restore if any of that fails. An operator's own
  // sampling keys, model-level or in the [*] defaults, are never overwritten.
  async function runSampling(j, p) {
    const rec = samplingFor ? await samplingFor(j.model) : null;
    const options = rec ? toIniOptions(rec.values) : {};
    const profile = presets.get(j.model);
    const own = INI_KEY_LIST.filter(k => profile.options[k] || profile.defaults[k]);
    const skip = reason => {
      record(p, 'apply', 'skipped', { reason });
      p.value = { skipped: true, reason, ...(rec ? { tier: rec.tier, source: rec.source } : {}) };
      note(j, 'Sampling left unchanged: ' + reason);
    };
    if (!Object.keys(options).length) return skip('No recommended sampling values; the engine defaults stay in force.');
    if (own.length) return skip('Sampling is already set in models.ini (' + own.join(', ') + '); left as configured.');
    await ensureBaseline(j, profile.options);
    check(); note(j, 'Applying recommended sampling (' + rec.source + ').');
    record(p, 'apply', 'running', { startedAt: now() });
    await write(j, options);
    await load(j);
    const final = await validate(j.model);
    record(p, 'apply', 'passed', { value: options, finishedAt: now() });
    p.value = { applied: true, tier: rec.tier, source: rec.source, family: rec.familyId, values: options, quality: final.quality };
    note(j, 'Committed recommended sampling: ' + Object.entries(options).map(([k, v]) => k + ' ' + v).join(', ') + '.');
  }
  async function runKv(j, p) {
    const before = { ...presets.get(j.model).options }, results = [];
    for (const kv of kvCandidates()) {
      check(); note(j, 'Testing ' + kv + ' KV cache with drafting off.');
      await unloadAll();
      // With no baseline yet, the f16 candidate is the reference setting itself: its probes become
      // the baseline instead of loading the same profile twice.
      const reuse = kv === 'f16' && !gate(j.model);
      const measured = await measure(j, p, kv, { 'cache-type-k': kv, 'cache-type-v': kv,
        'spec-type': 'none', 'spec-draft-n-max': '', 'spec-draft-p-min': '' }, async () => {
        if (!reuse) return validate(j.model);
        const quality = await qualityCheck(j.model, chat);
        if (engineFailed(quality)) throw Error(qualityFailure(quality));
        const b = setBaseline(j, 'f16', quality);
        // Judged like any later candidate: on the probes its own run passed, the rest skipped.
        return validate(j.model, { passed: true, checks: quality.checks.filter(c => b.probes.includes(c.id)),
          ...(b.skipped.length ? { skipped: b.skipped.map(s => s.id) } : {}) });
      });
      if (measured) results.push({ kv, ...measured });
      if (kv === 'f16' && !gate(j.model)) await ensureBaseline(j, before, { tryF16: false });
    }
    const best = results.sort((a, b) => b.generation - a.generation || kvCandidates().indexOf(a.kv) - kvCandidates().indexOf(b.kv))[0];
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
        const quality = await qualityCheck(j.model, chat, gate(j.model));
        if (!quality.passed) throw Error(qualityFailure(quality));
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
  const phaseRuns = { sampling: runSampling, kv: runKv, context: runContext, drafting: runDrafting, batch: runBatch };
  async function restorePhase(j, p) {
    if (p._beforeText == null) return true;
    if (presets.snapshot().revision !== j._revision) { p.restored = false; return false; }
    try {
      await unloadAll({ restoring: true });
      await presets.commit({ baseRevision: j._revision, text: p._beforeText });
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
    p.steps = stepsFor(p.id);
    j.phase = p.label; save();
    try {
      await phaseRuns[p.id](j, p); check();
      if (presets.snapshot().revision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
      p.status = 'passed'; p.finishedAt = now(); p._committedRevision = j._revision;
      delete p._beforeText; save();
    } catch (e) {
      const restored = await restorePhase(j, p);
      // Sampling is an optional nicety: a failure there must not fail a tune that the measured
      // phases would complete. Once models.ini is confirmed restored, record why and go on.
      // Cancellation, outside edits and unsafe restores still stop the job as for any phase.
      if (p.id === 'sampling' && restored && !cancelled && !e.cancelled && !e.fatal) {
        for (const s of p.steps) if (s.status !== 'skipped') { s.status = 'failed'; s.reason = e.message; }
        p.status = 'passed'; p.reason = e.message; p.value = { skipped: true, failed: true, reason: e.message };
        p.finishedAt = now(); note(j, 'Recommended sampling was not applied and models.ini was restored: ' + e.message);
        return;
      }
      p.status = cancelled || e.cancelled ? 'interrupted' : 'failed'; p.reason = e.message;
      for (const s of p.steps) if (s.status === 'running') { s.status = 'interrupted'; s.reason = e.message; }
      p.finishedAt = now(); save();
      if (!restored) throw Object.assign(Error(e.message + ' Settings changed or restoration failed; inspect models.ini before resuming.'), { unsafe: true });
      throw e;
    }
  }
  async function finishModel(j, item, final) {
    const identity = await identityFor(item.model);
    if (!identity || hash({ ...identity, profile: undefined }) !== item._identity)
      throw Object.assign(Error('Model identity changed since tuning began.'), { fatal: true });
    const kv = phaseOf(item, 'kv').value, ctx = phaseOf(item, 'context').value,
      draft = phaseOf(item, 'drafting').value, batch = phaseOf(item, 'batch').value;
    const result = { kv: kv.kv, context: ctx.context, spec: draft.spec, specLabel: draft.specLabel,
      generation: final.generation, acceptance: final.acceptance, ubatch: batch.ubatch,
      promptPerSecond: batch.promptPerSecond, quality: final.quality, extensions: [],
      sampling: phaseOf(item, 'sampling')?.value || null, ...(item.baseline ? { baseline: item.baseline } : {}),
      loaded: true, version: VERSION, signature: await signature(item.model, identity) };
    if (presets.snapshot().revision !== j._revision)
      throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
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
          if (!identity) throw Object.assign(Error('Model identity could not be read.'), { fatal: true });
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
          // A restart can land after the final phase committed but before this summary.
          // Confirm the saved profile loads and passes again before reporting it ready.
          if (presets.snapshot().revision !== j._revision)
            throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
          j.phase = 'Verifying saved profile'; save();
          await unloadAll();
          await load(j);
          const final = await validate(item.model);
          check();
          await finishModel(j, item, final);
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
    if (!bulk && isSystemModel(model)) return { ok: false, status: 400, body: { error: SYSTEM_MODEL_REASON } };
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
    } catch (e) { return { ok: false, status: 409, body: { error: clientMessage(e, 'Auto-tune could not start.') } }; }
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
      try {
        if (!j.originalText || !j.lastRevision || presets.snapshot().revision !== j.lastRevision)
          throw Error('The profile changed after the run.');
        const unloaded = await request('/models/unload', { method: 'POST', body: JSON.stringify({ model: j.model }) }, 60000);
        if (!unloaded.ok) throw Error('Could not unload the test model.');
        await presets.commit({ baseRevision: j.lastRevision, text: j.originalText });
        const reload = await request('/models?reload=1', {}, 120000);
        if (!reload.ok) throw Error('The router did not confirm restored settings.');
        j.restored = true;
      } catch { j.restored = false; }
      delete j.originalText; j.status = 'interrupted';
      j.error = j.restored ? 'An older tuning run was interrupted and restored. Start a new tune.'
        : 'An older tuning run was interrupted; settings could not safely be restored. Inspect models.ini before tuning again.';
      save(); return;
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
    // A job persisted by a pre-patch build may still list a system routing model (e.g. Laya) in
    // its queue. Never resume tuning it — drop it from the queue and record why, same as a fresh
    // scan would have. If nothing tunable remains, the job is done rather than resumable.
    // The router's --model path counts too: a neutral id can still point at Laya's weights.
    let rows;
    try { rows = await rawModels(); } catch { rows = null; }
    if (!rows?.ok || !Array.isArray(rows.body?.data)) return { ok: false, status: 409, body: { error: 'The model server is not responding.' } };
    const pathOf = id => modelPathFromArgs(rows.body.data.find(row => row.id === id)?.status?.args || []);
    const isSystem = id => isSystemModel(id, pathOf(id));
    const systemItems = j.models.filter(item => isSystem(item.model));
    if (systemItems.length) {
      j.models = j.models.filter(item => !isSystem(item.model));
      j.skipped = [...(j.skipped || []), ...systemItems.map(item => ({ model: item.model, reason: SYSTEM_MODEL_REASON }))];
      if (j.model && isSystem(j.model)) j.model = j.models[0]?.model || j.model;
      if (!j.models.length) {
        j.status = 'passed'; j.phase = 'Done'; j.finishedAt = now(); j.error = undefined;
        save();
        return { ok: true, status: 200, body: publicJob(j) };
      }
      save();
    }
    starting = true;
    try {
      for (const item of j.models.filter(m => m.status !== 'passed')) {
        if (!rows.body.data.some(row => row.id === item.model) || !presets.get(item.model).exists) throw publicFail('A queued model is no longer configured.');
        const identity = await identityFor(item.model);
        if (!identity) throw publicFail('A queued model identity could not be read.');
        if (item._identity && item._identity !== hash({ ...identity, profile: undefined })) throw publicFail('A queued model changed since tuning began.');
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
    } catch (e) { return { ok: false, status: 409, body: { error: clientMessage(e, 'Auto-tune could not resume.') } }; }
    finally { starting = false; }
  }
  return { start, resume, cancel, status, untuned, recover, completion: () => completion };
}
module.exports = { createFullAutotuner, qualityCheck, qualityFailure, QUALITY, VERSION, newModel, hasHarmonyReasoning };
