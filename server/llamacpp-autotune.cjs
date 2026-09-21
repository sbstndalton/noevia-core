'use strict';
// Measured auto-tune for native llama.cpp models: tune first, then extend.
//
// 1. Generation: at the model's current context, try speculative decoding off, the built-in or
//    beside-the-model MTP head (three draft profiles) and n-gram drafting on fixed short workloads
//    (list, prose, code), thinking off, temperature 0. A config counts only if it loads, drafts
//    when it claims to, and reproduces the "off" answer on the deterministic list workload.
//    The winner must beat "off" by MIN_GAIN on the geometric mean of tokens/s.
// 2. Prompt: micro-batch sizes on a ~3K-token prompt, keeping the fastest by prompt tokens/s.
// 3. The winning settings are saved to the preset and recorded in a lookup table keyed by
//    architecture, quantisation and hardware. The table orders what to try first next time and
//    proposes extensions (longer context from measured prompt speed, a quantised KV cache when
//    context is memory-bound); each extension is only applied through a measurement: context
//    goes through the existing calibration, which starts automatically when asked.
//
// Safety mirrors calibration: holds the maintenance gate (chat pauses), refuses to start with
// requests in flight, restores the original preset on cancel or failure, stops a step when
// available memory falls below the floor, and aborts if another client loads a model.
const fs = require('node:fs');
const crypto = require('node:crypto');

const MIN_GAIN = 0.05;
const PAD = 'The garden committee reviewed irrigation, seed orders, volunteer rotas and pump maintenance. ';
const WORKLOADS = [
  { id: 'list', max: 160, prompt: 'List the whole numbers from 1 to 60, separated by commas, and nothing else.' },
  { id: 'prose', max: 160, prompt: 'Write one paragraph explaining why community gardens matter to a neighbourhood.' },
  { id: 'code', max: 200, prompt: 'Write a JavaScript function median(values) that returns the median of an array without modifying it. Code only.' },
];
const SPEC_CANDIDATES = [
  { id: 'off', label: 'Off', options: { 'spec-type': 'none', 'spec-draft-n-max': '', 'spec-draft-p-min': '' } },
  { id: 'mtp', label: 'MTP (engine defaults)', needsHead: true, options: { 'spec-type': 'draft-mtp', 'spec-draft-n-max': '', 'spec-draft-p-min': '' } },
  { id: 'mtp-deep', label: 'MTP deep drafts', needsHead: true, options: { 'spec-type': 'draft-mtp', 'spec-draft-n-max': '8', 'spec-draft-p-min': '0.05' } },
  { id: 'mtp-shallow', label: 'MTP shallow drafts', needsHead: true, options: { 'spec-type': 'draft-mtp', 'spec-draft-n-max': '2', 'spec-draft-p-min': '0.6' } },
  { id: 'ngram', label: 'N-gram', options: { 'spec-type': 'ngram-simple', 'spec-draft-n-max': '', 'spec-draft-p-min': '' } },
];
const UBATCH_CANDIDATES = [512, 1024, 2048];
const HISTORY_PER_MODEL = 10;
const PARTIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TUNED_KEYS = ['spec-type', 'spec-draft-n-max', 'spec-draft-p-min', 'ubatch-size', 'batch-size'];
const TOTAL_STEPS = SPEC_CANDIDATES.length + 3;

function geomean(values) {
  const v = values.filter((x) => x > 0);
  return v.length ? Math.exp(v.reduce((a, x) => a + Math.log(x), 0) / v.length) : 0;
}

// ── lookup table ──────────────────────────────────────────────────────────
function createTable(file) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { entries: {} }; } };
  const keyOf = ({ arch, quant, hardware }) => [arch || '?', quant || '?', hardware || '?'].join('|');
  function record(identity, result) {
    const data = read();
    data.entries[keyOf(identity)] = { ...identity, ...result, at: Date.now() };
    const tmp = `${file}.${crypto.randomUUID()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  // Exact match first, then same architecture on this hardware, then same architecture anywhere.
  function lookup({ arch, quant, hardware }) {
    const all = Object.values(read().entries);
    return all.find((e) => e.arch === arch && e.quant === quant && e.hardware === hardware)
      || all.filter((e) => e.arch === arch && e.hardware === hardware).sort((a, b) => b.at - a.at)[0]
      || all.filter((e) => e.arch === arch).sort((a, b) => b.at - a.at)[0] || null;
  }
  // Candidates in the order most likely to win, so a cancelled run still learned the best one.
  function order(identity, candidates) {
    const hit = lookup(identity);
    if (!hit?.spec) return candidates;
    const off = candidates.filter((c) => c.id === 'off'), prior = candidates.filter((c) => c.id === hit.spec && c.id !== 'off');
    return [...off, ...prior, ...candidates.filter((c) => c.id !== 'off' && c.id !== hit.spec)];
  }
  return { record, lookup, order, read };
}

// Extensions the measurements justify. Each is a proposal the tuner or the user then verifies.
function extensions({ options, native, promptPerSecond, budgetSeconds, calibratedCtx }) {
  const out = [];
  const ctx = Number(options['ctx-size']) || 0;
  if (promptPerSecond > 0) {
    const byTime = Math.floor(promptPerSecond * budgetSeconds);
    const target = Math.min(native || byTime, byTime);
    if (target > ctx * 1.25) out.push({ id: 'context', action: 'calibrate', from: ctx, to: target,
      why: `measured prompt speed (${Math.round(promptPerSecond)} tokens/s) fills about ${target.toLocaleString('en-US')} tokens within ${budgetSeconds} s` });
    // The configured context is only real if it can be filled: an unmeasured maximum is worse than
    // a smaller measured one, because every long chat then stalls or fails.
    else if (ctx > byTime * 1.1) out.push({ id: 'context-too-large', action: 'calibrate', from: ctx, to: byTime,
      why: `at the measured ${Math.round(promptPerSecond)} tokens/s a full ${ctx.toLocaleString('en-US')}-token prompt needs about ${Math.round(ctx / promptPerSecond)} s, over the ${budgetSeconds} s budget` });
  }
  const k = options['cache-type-k'] || 'f16';
  if (calibratedCtx && native && calibratedCtx < native && ['f16', 'f32', 'bf16'].includes(k)) {
    out.push({ id: 'kv-q8', action: 'apply-then-calibrate', options: { 'cache-type-k': 'q8_0', 'cache-type-v': 'q8_0' },
      why: 'context stopped below the trained length; a q8_0 KV cache halves its memory at a small quality cost' });
  }
  return out;
}

function createAutotuner(deps) {
  const {
    request, rawModels, presets, maintenance, applyUnlocked, stateFile, tableFile,
    identityFor = async () => ({}), calibrate = async () => null,
    readMemory = require('./llamacpp-calibration.cjs').readMemAvailableGib, memoryFloorGib = 2,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), timeouts = {},
  } = deps;
  const limits = { load: 600000, chat: 180000, unload: 60000, poll: 500, ...timeouts };
  const table = createTable(tableFile);
  let state = { job: null, history: {} };
  let cancelRequested = false;
  const load = () => { try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = { job: null, history: {} }; } if (!state.history) state.history = {}; if (!state.partial) state.partial = {}; };
  // Measured results survive a cancel or a restart: a later run continues instead of repeating
  // tests. Keyed by model plus the configuration they were measured under, so a changed preset,
  // model file or engine build starts fresh.
  const partialKey = (model, identity, base) => [model, identity.arch, identity.quant, identity.hardware,
    crypto.createHash('sha256').update(JSON.stringify(Object.entries(base).filter(([k]) => !TUNED_KEYS.includes(k)).sort())).digest('hex').slice(0, 12)].join('|');
  // A partial older than the TTL is not reused: the hardware, the build or the model may have
  // changed under it. Expired entries are DROPPED rather than left in the state file, and the
  // caller is told whether anything was actually resumed — asking to resume and silently
  // re-running every measurement is the kind of quiet difference that wastes an hour.
  const partialFor = (key) => {
    const hit = state.partial[key];
    if (hit && Date.now() - hit.at < PARTIAL_TTL_MS) return hit;
    if (hit) delete state.partial[key];
    return { at: Date.now(), spec: {}, batch: {} };
  };
  /** Sweep every partial whose TTL has passed, so the state file cannot grow without bound. */
  const prunePartials = () => {
    let removed = 0;
    for (const [key, hit] of Object.entries(state.partial || {})) {
      if (!hit || Date.now() - hit.at >= PARTIAL_TTL_MS) { delete state.partial[key]; removed++; }
    }
    return removed;
  };
  const save = () => { if (!stateFile) return; const tmp = `${stateFile}.${crypto.randomUUID()}`; fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, stateFile); };
  const publicJob = (job) => job && (({ originalText, ...rest }) => rest)(job);
  // Steps are known up front, so progress is honest: finished steps out of the planned total.
  function progress(job) {
    const done = job.steps.filter((s) => s.status !== 'running').length;
    job.progress = { done, total: Math.max(TOTAL_STEPS, job.steps.length), percent: Math.min(99, Math.round((done / Math.max(TOTAL_STEPS, job.steps.length)) * 100)) };
  }
  // A line-by-line account of what auto-tune is doing. A run is 5-15 minutes of a mostly
  // silent progress bar: a single test can spend a minute loading the engine, and a person
  // watching a still screen reasonably concludes that nothing is happening. So every step says
  // what it is about to do, with the settings it is about to try, and the long waits report
  // themselves while they wait.
  const LOG_CAP = 400;
  let lastLogSave = 0;
  function note(job, text, { force = false } = {}) {
    if (!job) return;
    if (!job.log) job.log = [];
    job.log.push({ at: now(), text: String(text).slice(0, 300) });
    // Oldest first, and say that some were dropped rather than silently losing the beginning.
    if (job.log.length > LOG_CAP) job.log.splice(0, job.log.length - LOG_CAP, { at: now(), text: `… earlier lines dropped (keeping the last ${LOG_CAP})` });
    // The state file is written for every step already; a heartbeat every few seconds does not
    // need its own write, so log-only updates are throttled.
    if (force || now() - lastLogSave > 2000) { lastLogSave = now(); save(); }
  }
  /** The settings a test actually writes, as a person would read them back. */
  const describe = (options) => Object.entries(options || {})
    .map(([k, v]) => (v === '' ? `${k} (unset)` : `${k} ${v}`)).join(' · ') || 'no changes';

  const cancelled = () => Object.assign(Error('cancelled'), { cancelled: true });
  const fatal = (message) => Object.assign(Error(message), { fatal: true });

  async function listing() {
    const r = await rawModels();
    if (!r.ok || !Array.isArray(r.body?.data)) throw fatal('The model server is not responding.');
    return r.body.data;
  }
  async function unload(model) {
    await request('/models/unload', { method: 'POST', body: JSON.stringify({ model }) }, limits.unload).catch(() => {});
    for (const until = now() + limits.unload; now() < until;) {
      const row = (await listing().catch(() => [])).find((m) => m.id === model);
      if (!row || !['loaded', 'loading'].includes(row.status?.value)) return;
      await sleep(limits.poll);
    }
  }
  async function unloadAll() {
    for (const m of await listing()) if (['loaded', 'loading'].includes(m.status?.value)) await unload(m.id);
  }
  async function loadAndWait(model, job = null) {
    note(job, `Loading ${model} into the engine`);
    const startedAt = now();
    const started = await request('/models/load', { method: 'POST', body: JSON.stringify({ model }) }, 120000).catch(() => null);
    if (!started?.ok) { note(job, 'The engine refused the load request'); return false; }
    let announced = 0;
    for (const until = now() + limits.load; now() <= until;) {
      if (cancelRequested) throw cancelled();
      // The part that looks like nothing is happening: say so, every few seconds, with how
      // long it has been.
      const waited = Math.round((now() - startedAt) / 1000);
      if (waited >= announced + 5) { announced = waited; note(job, `still loading · ${waited}s`); }
      const memory = readMemory();
      if (memory != null && memory < memoryFloorGib) return false;
      const rows = await listing();
      if (rows.some((m) => m.id !== model && ['loaded', 'loading'].includes(m.status?.value))) throw fatal('Another client loaded a model during auto-tune. Stop Diary background jobs and other clients, then retry.');
      const row = rows.find((m) => m.id === model);
      if (row?.status?.value === 'loaded') { note(job, `Loaded in ${Math.round((now() - startedAt) / 1000)}s`); return true; }
      if (!row || row.status?.failed || row.status?.value === 'unloaded') { note(job, 'The engine did not load it with these settings'); return false; }
      await sleep(limits.poll);
    }
    return false;
  }
  async function chat(model, prompt, max) {
    const r = await request('/v1/chat/completions', { method: 'POST', body: JSON.stringify({
      model, stream: false, temperature: 0, max_tokens: max, cache_prompt: false,
      chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'user', content: prompt }] }) }, limits.chat);
    if (!r.ok || !Array.isArray(r.body?.choices)) return null;
    const t = r.body.timings || {};
    return { text: r.body.choices[0]?.message?.content || '', gen: Number(t.predicted_per_second) || 0, prompt: Number(t.prompt_per_second) || 0,
      drafted: Number(t.draft_n) || 0, accepted: Number(t.draft_n_accepted) || 0 };
  }

  // Write options, load, measure, unload. Returns the step record.
  async function measure(job, kind, candidate, options, run) {
    if (cancelRequested) throw cancelled();
    const record = { kind, id: candidate.id, label: candidate.label, status: 'running', startedAt: now() };
    job.steps.push(record); job.phase = `${kind === 'spec' ? 'Generation' : 'Prompt'} test: ${candidate.label}`; progress(job);
    note(job, `— ${candidate.label} —`, { force: true });
    note(job, `Settings: ${describe(options)}`);
    try {
      const applied = await applyUnlocked({ model: job.model, baseRevision: presets.get(job.model).revision, options });
      if (!applied.ok) throw fatal(applied.body?.error || 'Could not write the test profile.');
      job.lastRevision = presets.get(job.model).revision;
      if (!await loadAndWait(job.model, job)) { record.status = 'failed'; record.reason = 'Did not load with these settings.'; return record; }
      note(job, 'Warm-up request (the first one pays for graph setup)');
      await chat(job.model, 'Reply with OK.', 8); // warm-up: first request pays graph setup
      Object.assign(record, await run());
      note(job, record.status === 'measured'
        ? `Measured: ${kind === 'spec' ? `${record.score} tokens/s` : `${record.promptPerSecond} prompt tokens/s`}`
        : `${record.status}: ${record.reason || 'no reason given'}`, { force: true });
      return record;
    } catch (e) {
      if (e.cancelled || e.fatal) { record.status = e.cancelled ? 'skipped' : 'failed'; record.reason = e.message; throw e; }
      record.status = 'failed'; record.reason = 'The engine failed during this test.'; return record;
    } finally {
      record.seconds = Math.round((now() - record.startedAt) / 1000);
      progress(job); save();
      note(job, `Unloading before the next test (this test took ${record.seconds}s)`);
      await unload(job.model).catch(() => {});
    }
  }

  async function run(job, release) {
    let calibrateAfter = null;
    try {
      note(job, `Starting auto-tune for ${job.model}`, { force: true });
      note(job, 'Unloading every model so each test starts from the same place');
      await unloadAll();
      note(job, 'Saving the current settings so they can be restored if anything goes wrong');
      const snapshot = presets.snapshot();
      job.originalText = snapshot.text; job.originalRevision = snapshot.revision; save();
      const identity = await identityFor(job.model).catch(() => ({})) || {};
      job.identity = identity;
      const base = { ...presets.get(job.model).options };
      const key = partialKey(job.model, identity, base);
      prunePartials();
      const partial = job.resume ? partialFor(key) : { at: Date.now(), spec: {}, batch: {} };
      // Say plainly whether resuming found anything. `false` after asking to resume means the
      // saved measurements had expired (or this configuration changed), and everything is
      // being measured again.
      job.resumed = job.resume && (Object.keys(partial.spec).length > 0 || Object.keys(partial.batch).length > 0);
      note(job, job.resumed ? 'Earlier measurements for this configuration were found and will be reused'
        : job.resume ? 'No earlier measurements to reuse; measuring everything' : 'Measuring everything from scratch, as asked');
      note(job, 'Step 1 of 2: generation speed — speculative decoding off, then each drafting method');
      state.partial[key] = partial;
      const keep = (kind, id, value) => { partial[kind][id] = value; partial.at = Date.now(); save(); };

      // 1. Generation.
      let reference = partial.spec.off?.reference || null;
      const spec = [];
      for (const candidate of table.order(identity, SPEC_CANDIDATES)) {
        const cached = partial.spec[candidate.id];
        if (cached) { const rec = { kind: 'spec', id: candidate.id, label: candidate.label, ...cached.record, reused: true }; job.steps.push(rec); spec.push(rec); progress(job); note(job, `${candidate.label}: reusing the earlier measurement${rec.score ? ` (${rec.score} tokens/s)` : ''}`, { force: true }); continue; }
        const rec = await measure(job, 'spec', candidate, candidate.options, async () => {
          const rows = [];
          for (const w of WORKLOADS) {
            note(job, `Running the ${w.id} workload (up to ${w.max} tokens)`);
            const r = await chat(job.model, w.prompt, w.max);
            if (!r) { note(job, `The ${w.id} workload got no answer`, { force: true }); return { status: 'failed', reason: `No answer on the ${w.id} workload.` }; }
            note(job, `${w.id}: ${Math.round(r.gen * 10) / 10} tokens/s${r.drafted ? `, ${Math.round((r.accepted / r.drafted) * 100)}% of ${r.drafted} drafts accepted` : ''}`);
            rows.push({ workload: w.id, gen: Math.round(r.gen * 10) / 10, drafted: r.drafted, accepted: r.accepted, text: r.text });
          }
          return { status: 'measured', workloads: rows, score: Math.round(geomean(rows.map((x) => x.gen)) * 10) / 10 };
        });
        if (rec.status !== 'measured') { keep('spec', candidate.id, { record: { status: rec.status, reason: rec.reason } }); spec.push(rec); continue; }
        const byId = Object.fromEntries(rec.workloads.map((w) => [w.workload, w]));
        // Copy the reference answers: the step record drops its texts below to stay small.
        if (candidate.id === 'off') reference = Object.fromEntries(Object.entries(byId).map(([k, w]) => [k, { text: w.text }]));
        if (candidate.needsHead && !rec.workloads.some((w) => w.drafted > 0)) { rec.status = 'rejected'; rec.reason = 'No MTP head: nothing was drafted.'; }
        else if (reference && candidate.id !== 'off' && byId.list?.text !== reference.list?.text) { rec.status = 'rejected'; rec.reason = 'Changed the deterministic list output.'; }
        // Speed only counts if the answers are the same; say which way it went and why.
        if (rec.status === 'rejected') note(job, `Rejected ${candidate.label}: ${rec.reason}`, { force: true });
        else if (candidate.id !== 'off' && reference) note(job, `${candidate.label} gave the same answers as the baseline`);
        for (const w of rec.workloads) delete w.text;
        keep('spec', candidate.id, { record: { status: rec.status, reason: rec.reason, score: rec.score, workloads: rec.workloads }, ...(candidate.id === 'off' ? { reference } : {}) });
        spec.push(rec);
      }
      const off = spec.find((s) => s.id === 'off' && s.status === 'measured');
      if (!off) {
        // Usually the saved context is too large to load at all: measuring it is the way out, so
        // say that plainly and offer the calibration rather than a bare failure.
        job.baselineFailed = true;
        if (job.extendContext) calibrateAfter = job.model;
        throw fatal(`This model did not run with its current settings (context ${presets.get(job.model).options['ctx-size'] || 'unset'}), so there was nothing to compare. ${job.extendContext ? 'Measuring the largest context it can actually load has been started.' : 'Run Measure context first, then auto-tune.'}`);
      }
      const bestSpec = spec.filter((s) => s.status === 'measured').sort((a, b) => b.score - a.score)[0];
      const specWinner = bestSpec.id !== 'off' && bestSpec.score >= off.score * (1 + MIN_GAIN) ? bestSpec : off;
      const perWorkload = Object.fromEntries(WORKLOADS.map((w) => {
        const best = spec.filter((s) => s.status === 'measured').map((s) => ({ id: s.id, gen: s.workloads.find((x) => x.workload === w.id)?.gen || 0 })).sort((a, b) => b.gen - a.gen)[0];
        return [w.id, best?.id || 'off'];
      }));
      const winnerOptions = SPEC_CANDIDATES.find((c) => c.id === specWinner.id).options;
      note(job, specWinner.id === 'off'
        ? `Keeping speculative decoding off: nothing beat ${off.score} tokens/s by the ${Math.round(MIN_GAIN * 100)}% it has to`
        : `Chose ${specWinner.label}: ${specWinner.score} tokens/s against ${off.score} with it off`, { force: true });
      note(job, 'Step 2 of 2: prompt speed — trying micro-batch sizes on top of that choice');

      // 2. Prompt throughput (micro-batch), on top of the generation winner.
      const tokensTarget = 3000;
      const prompt = `${PAD.repeat(Math.ceil(tokensTarget / 18))}\nIn one sentence, what did the committee review?`;
      const batch = [];
      for (const ub of UBATCH_CANDIDATES) {
        const candidate = { id: `ubatch-${ub}`, label: `Micro-batch ${ub}` };
        const options = { ...winnerOptions, 'ubatch-size': String(ub), 'batch-size': String(Math.max(2048, ub)) };
        const cached = partial.batch[candidate.id];
        if (cached && cached.spec === specWinner.id) { const rec = { kind: 'prompt', id: candidate.id, label: candidate.label, ...cached.record, options, reused: true }; job.steps.push(rec); batch.push(rec); progress(job); note(job, `${candidate.label}: reusing the earlier measurement${rec.promptPerSecond ? ` (${rec.promptPerSecond} prompt tokens/s)` : ''}`, { force: true }); continue; }
        const rec = await measure(job, 'prompt', candidate, options, async () => {
          note(job, 'Sending a ~3000-token prompt to measure prompt throughput');
          const r = await chat(job.model, prompt, 16);
          return r && r.prompt > 0 ? { status: 'measured', promptPerSecond: Math.round(r.prompt) } : { status: 'failed', reason: 'The long prompt failed.' };
        });
        rec.options = options;
        keep('batch', candidate.id, { spec: specWinner.id, record: { status: rec.status, reason: rec.reason, promptPerSecond: rec.promptPerSecond } });
        batch.push(rec);
      }
      const bestBatch = batch.filter((b) => b.status === 'measured').sort((a, b) => b.promptPerSecond - a.promptPerSecond)[0];
      const finalOptions = bestBatch ? bestBatch.options : winnerOptions;

      // 3. Save the winner and leave it loaded.
      note(job, bestBatch ? `Chose micro-batch ${bestBatch.options['ubatch-size']} (${bestBatch.promptPerSecond} prompt tokens/s)` : 'No micro-batch size measured; keeping the generation choice as it is', { force: true });
      note(job, `Saving the tuned settings: ${describe(finalOptions)}`);
      const applied = await applyUnlocked({ model: job.model, baseRevision: presets.get(job.model).revision, options: finalOptions });
      if (!applied.ok) throw fatal(applied.body?.error || 'Could not save the tuned profile.');
      job.lastRevision = presets.get(job.model).revision;
      const tuned = { ...base, ...Object.fromEntries(Object.entries(finalOptions).filter(([, v]) => v !== '')) };
      for (const [k, v] of Object.entries(finalOptions)) if (v === '') delete tuned[k];
      const ext = extensions({ options: tuned, native: job.native, promptPerSecond: bestBatch?.promptPerSecond || 0, budgetSeconds: job.promptBudgetSeconds, calibratedCtx: 0 });
      job.result = {
        spec: specWinner.id, specLabel: specWinner.label, generation: specWinner.score, generationOff: off.score,
        gain: off.score > 0 ? Math.round((specWinner.score / off.score - 1) * 100) : 0, perWorkload,
        ubatch: bestBatch ? Number(bestBatch.options['ubatch-size']) : null, promptPerSecond: bestBatch?.promptPerSecond || null,
        applied: finalOptions, extensions: ext,
      };
      table.record(identity, { spec: specWinner.id, perWorkload, generation: specWinner.score, generationOff: off.score, ubatch: job.result.ubatch, promptPerSecond: job.result.promptPerSecond, model: job.model });
      job.phase = 'Loading the tuned profile'; save();
      note(job, 'Loading the tuned profile so it is ready to use');
      job.result.loaded = await loadAndWait(job.model, job).catch(() => false);
      delete state.partial[key];
      job.status = 'passed'; job.phase = 'Done'; job.progress = { done: job.steps.length, total: job.steps.length, percent: 100 };
      note(job, job.result.loaded ? 'Done — the tuned profile is loaded and ready' : 'Done — saved, but the tuned profile did not load; it will on the next request', { force: true });
      state.history[job.model] = [{ at: now(), ...job.result }, ...(state.history[job.model] || [])].slice(0, HISTORY_PER_MODEL);
      if (job.extendContext && ext.some((e) => e.id === 'context')) calibrateAfter = job.model;
    } catch (e) {
      job.status = e.cancelled ? 'cancelled' : 'failed';
      job.phase = e.cancelled ? 'Cancelled' : 'Failed';
      if (!e.cancelled) job.error = e.message || 'Auto-tune failed.';
      note(job, e.cancelled ? 'Cancelled — measurements so far are kept' : `Stopped: ${job.error}`, { force: true });
      try {
        if (job.originalText != null && job.lastRevision && presets.snapshot().revision === job.lastRevision) {
          note(job, 'Putting the original settings back');
          presets.commit({ baseRevision: job.lastRevision, text: job.originalText });
          await request('/models?reload=1', {}, 120000).catch(() => {});
          job.restored = true;
          note(job, 'Original settings restored', { force: true });
        } else if (job.originalText != null && job.lastRevision) {
          job.restored = false;
          // Someone else changed the settings while this ran; overwriting their change would be
          // worse than leaving it, so say so instead.
          note(job, 'Not restoring: the settings were changed by someone else during the run', { force: true });
        }
      } catch { job.restored = false; note(job, 'Could not restore the original settings', { force: true }); }
    } finally {
      job.finishedAt = now();
      delete job.originalText;
      cancelRequested = false;
      save();
      release();
    }
    // Extension step: context is only raised through the measured calibration, after the gate is free.
    if (calibrateAfter) {
      note(job, 'Starting the context measurement');
      const started = await calibrate(calibrateAfter, job.promptBudgetSeconds).catch((e) => ({ ok: false, body: { error: e.message } }));
      job.calibration = started?.ok ? 'started' : `not started: ${started?.body?.error || 'unavailable'}`;
      note(job, started?.ok ? 'Context measurement started — see Measure context' : `Context measurement not started: ${started?.body?.error || 'unavailable'}`, { force: true });
    }
  }

  async function start(model, { confirmPause, promptBudgetSeconds = 120, extendContext = false, resume = true } = {}) {
    if (confirmPause !== true) return { ok: false, status: 400, body: { error: 'Confirm that chat can pause and that Diary background jobs and other clients are stopped.' } };
    promptBudgetSeconds = Number(promptBudgetSeconds);
    if (!Number.isInteger(promptBudgetSeconds) || promptBudgetSeconds < 15 || promptBudgetSeconds > 1800) return { ok: false, status: 400, body: { error: 'Choose a prompt time limit between 15 and 1800 seconds.' } };
    if (state.job?.status === 'running') return { ok: false, status: 409, body: { error: 'Auto-tune is already running.' } };
    let rows;
    try { rows = await listing(); } catch { return { ok: false, status: 502, body: { error: 'The model server is not responding.' } }; }
    const row = rows.find((m) => m.id === model);
    if (!row) return { ok: false, status: 404, body: { error: 'Choose an installed model.' } };
    if (!presets.get(model).exists) return { ok: false, status: 409, body: { error: 'Set up this model first; auto-tune starts from its saved settings.' } };
    let release;
    try { release = maintenance.hold(`Chat is paused while noevia auto-tunes ${model}. It will be available again when tuning finishes or is cancelled.`); }
    catch { return { ok: false, status: 409, body: { error: 'Requests are in progress. Wait for them to finish, then start auto-tune.' } }; }
    cancelRequested = false;
    const job = { id: crypto.randomUUID(), model, promptBudgetSeconds, extendContext: extendContext === true, resume: resume !== false, native: Number(row.meta?.n_ctx_train) || 0, status: 'running', phase: 'Preparing', startedAt: now(), steps: [], progress: { done: 0, total: TOTAL_STEPS, percent: 0 } };
    state.job = job; save();
    run(job, release).catch(() => {});
    return { ok: true, status: 202, body: publicJob(job) };
  }
  function cancel() {
    if (state.job?.status !== 'running') return { ok: false, status: 409, body: { error: 'No auto-tune is running.' } };
    cancelRequested = true;
    return { ok: true, status: 202, body: publicJob(state.job) };
  }
  function status(model) {
    return { ok: true, status: 200, body: { job: publicJob(state.job), history: model ? state.history[model] || [] : undefined, table: model ? null : undefined } };
  }
  async function recover() {
    load();
    const job = state.job;
    if (!job || job.status !== 'running') return;
    job.status = 'interrupted'; job.finishedAt = now(); job.error = 'noevia stopped during auto-tune.';
    try { if (job.originalText != null && job.lastRevision) { presets.commit({ baseRevision: job.lastRevision, text: job.originalText }); job.restored = true; await request('/models?reload=1', {}, 120000).catch(() => {}); } } catch { job.restored = false; }
    delete job.originalText; save();
  }
  load();
  // `_partialFor`/`_state` are exposed for tests only, like `_state` already was.
  return { start, cancel, status, recover, table, _state: () => state, _partialFor: partialFor, _prunePartials: prunePartials };
}

module.exports = { createAutotuner, createTable, extensions, geomean, SPEC_CANDIDATES, WORKLOADS, MIN_GAIN };
