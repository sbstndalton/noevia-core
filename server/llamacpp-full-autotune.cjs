'use strict';
// One maintenance lease and one rollback journal for KV → context → drafting/batch.
// Children never acquire a second lease or publish independent success to the UI.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WORKLOADS, geomean } = require('./llamacpp-autotune.cjs');
const VERSION = 2;
const KV = ['f16', 'q8_0', 'q4_0'];
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

function createFullAutotuner({ request, rawModels, presets, maintenance, applyUnlocked, identityFor,
  speedFactory, contextFactory, stateFile, now = Date.now,
  readMemory = require('./llamacpp-calibration.cjs').readMemAvailableGib, memoryFloorGib = 2, onResult = async () => {} }) {
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
  state.history ||= {};
  let cancelled = false, child = null, completion = Promise.resolve(), starting = false, inflight = null;
  const save = () => { const tmp = `${stateFile}.${crypto.randomUUID()}`; fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, stateFile); };
  const publicJob = j => j && (({ originalText, lastRevision, ...rest }) => rest)(j);
  const check = () => { if (cancelled) throw Object.assign(Error('Cancelled'), { cancelled: true }); };
  const note = (j, text) => { (j.log ||= []).push({ at: now(), text }); if (j.log.length > 400) j.log.shift(); save(); };
  async function signature(model) {
    // Full file identity/build/hardware plus all effective model settings, not merely a model name.
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
      const profile = presets.get(row.id);
      const args = row.status?.args || [];
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
  const status = model => ({ ok: true, status: 200, body: { job: publicJob(state.job), history: model ? state.history[model] || [] : [] } });
  async function untuned() { try { return { ok: true, status: 200, body: await candidates() }; } catch (e) { return { ok: false, status: 502, body: { error: e.message } }; } }
  async function unloadAll() {
    const r = await rawModels();
    if (!r.ok) throw Error('The model server is not responding.');
    for (const row of r.body.data || []) if (['loaded', 'loading'].includes(row.status?.value)) {
      const u = await request('/models/unload', { method: 'POST', body: JSON.stringify({ model: row.id }) }, 60000);
      if (!u.ok) throw Error('Could not unload models before testing.');
    }
  }
  async function write(j, options) {
    check();
    const r = await applyUnlocked({ model: j.model, baseRevision: j.lastRevision, options });
    if (!r.ok) throw Error(r.body?.error || 'Could not save settings; the profile may have changed.');
    j.lastRevision = presets.snapshot().revision; save();
  }
  async function chat(model, prompt, max) {
    check();
    const rows = await rawModels();
    if (!rows.ok) throw Error('The model server stopped responding.');
    if (rows.body.data.some(r => r.id !== model && ['loaded', 'loading'].includes(r.status?.value))) throw Object.assign(Error('Another client loaded a model during tuning.'), { fatal: true });
    const controller = new AbortController(); inflight = controller;
    let lowMemory = false;
    const guard = () => { const free = readMemory(); if (free != null && free < memoryFloorGib) { lowMemory = true; controller.abort(); } };
    guard(); const timer = setInterval(guard, 500);
    let r;
    try { r = await request('/v1/chat/completions', { method: 'POST', signal: controller.signal, body: JSON.stringify({ model, stream: false, temperature: 0,
      max_tokens: max, cache_prompt: false, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'user', content: prompt }] }) }, 180000); }
    finally { clearInterval(timer); inflight = null; }
    check();
    if (lowMemory) throw Error('Available memory fell below the safety floor.');
    if (!r.ok || !r.body?.choices?.length) return null;
    const t = r.body.timings || {};
    return { text: r.body.choices[0]?.message?.content || '', gen: Number(t.predicted_per_second), drafted: Number(t.draft_n) || 0, accepted: Number(t.draft_n_accepted) || 0 };
  }
  async function validate(model) {
    const quality = await qualityCheck(model, chat);
    if (!quality.passed) throw Error('The final profile failed the three quality checks.');
    const workloads = [];
    for (const w of WORKLOADS) {
      const r = await chat(model, w.prompt, w.max);
      if (!r || !Number.isFinite(r.gen) || r.gen <= 0) throw Error('Missing final throughput measurements.');
      workloads.push({ workload: w.id, gen: r.gen, drafted: r.drafted, accepted: r.accepted });
    }
    const drafted = workloads.reduce((n, w) => n + w.drafted, 0), accepted = workloads.reduce((n, w) => n + w.accepted, 0);
    return { quality, workloads, generation: Math.round(geomean(workloads.map(w => w.gen)) * 10) / 10,
      acceptance: drafted ? Math.round(100 * accepted / drafted) : null };
  }
  async function loadWinner(j) {
    const response = await request('/models/load', { method: 'POST', body: JSON.stringify({ model: j.model }) }, 600000);
    if (!response.ok) throw Error('The winning profile could not be loaded.');
    for (let polls = 0; polls < 1200; polls++) {
      check();
      const free = readMemory(); if (free != null && free < memoryFloorGib) throw Error('Available memory fell below the safety floor.');
      const r = await rawModels();
      if (!r.ok) throw Error('The model server stopped responding.');
      if (r.body.data.some(m => m.id !== j.model && ['loaded', 'loading'].includes(m.status?.value))) throw Object.assign(Error('Another client loaded a model during tuning.'), { fatal: true });
      const row = r.body.data.find(m => m.id === j.model);
      if (row?.status?.value === 'loaded') return;
      if (!row || row.status?.failed || row.status?.value === 'unloaded') throw Error('The winning profile failed to load.');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw Error('Loading the winning profile timed out.');
  }
  async function stage(j, factory, name) {
    check();
    if (presets.snapshot().revision !== j.lastRevision) throw Error('Settings changed outside auto-tune.');
    const offset = j.steps.length;
    child = factory({
      applyUnlocked: body => {
        if (body.baseRevision !== j.lastRevision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
        return applyUnlocked(body);
      },
      onWrite: revision => { j.lastRevision = revision; save(); },
      onUpdate: c => { if (!c) return; j.phase = `${name}: ${c.phase}`;
        j.steps = [...j.steps.slice(0, offset), ...c.steps.map(s => ({ ...s, label: `${name} · ${s.label || `${s.kind} ${s.ctx}`}` }))]; save(); },
      qualityCheck: async (model, send) => { check(); const result = await qualityCheck(model, send); check(); return result; },
    });
    try {
      const started = await child.start(j.model, { confirmPause: true, promptBudgetSeconds: j.promptBudgetSeconds, resume: false });
      if (!started.ok) throw Error(started.body?.error || `${name} could not start.`);
      if (cancelled) child.cancel();
      await child.completion(); check();
      const result = child.status(j.model).body.job;
      if (result.status !== 'passed') throw Object.assign(Error(result.error || `${name} failed.`), { fatal: result.restored === false || /Another client/.test(result.error || '') });
      return result.result;
    } finally { child = null; }
  }
  async function restore(j) {
    if (j.originalText == null) return;
    if (presets.snapshot().revision !== j.lastRevision) { j.restored = false; return; }
    const unloaded = await request('/models/unload', { method: 'POST', body: JSON.stringify({ model: j.model }) }, 60000);
    if (!unloaded.ok) throw Error('Could not unload the test model before restoring.');
    presets.commit({ baseRevision: j.lastRevision, text: j.originalText });
    j.lastRevision = presets.snapshot().revision;
    const reload = await request('/models?reload=1', {}, 120000);
    j.restored = reload.ok;
    save();
  }
  async function tune(j) {
    await unloadAll(); check();
    const snapshot = presets.snapshot(); j.originalText = snapshot.text; j.lastRevision = snapshot.revision; save();
    const base = { ...presets.get(j.model).options };
    const results = [];
    for (const kv of KV) {
      check(); note(j, `Testing ${kv} KV cache: context, three draft profiles, n-gram and three quality checks per setting`);
      try {
        await unloadAll();
        await write(j, { ...Object.fromEntries(presets.get(j.model).fields.map(k => [k, ''])), ...base, 'cache-type-k': kv, 'cache-type-v': kv, 'spec-type': 'none', 'spec-draft-n-max': '', 'spec-draft-p-min': '' });
        await stage(j, contextFactory, `${kv} context`);
        const speed = await stage(j, speedFactory, `${kv} speed`);
        // Drafting has its own memory overhead. Recheck capacity with the chosen draft/batch.
        const context = await stage(j, contextFactory, `${kv} final context`);
        const measured = await validate(j.model);
        const options = { ...presets.get(j.model).options };
        results.push({ ...speed, ...measured, kv, context: context.appliedCtx, applied: options, extensions: [] });
        note(j, `${kv} passed: ${measured.generation} tokens/s, context ${context.appliedCtx}, draft acceptance ${measured.acceptance ?? 'n/a'}%`);
      } catch (e) {
        check();
        // A profile conflict is not an unsupported candidate: stop without overwriting it.
        if (e.fatal || presets.snapshot().revision !== j.lastRevision) throw e;
        note(j, `${kv} rejected: ${e.message}`);
      }
      j.progress = { done: KV.indexOf(kv) + 1, total: KV.length, percent: Math.round((KV.indexOf(kv) + 1) / (KV.length + 1) * 100) }; save();
    }
    check();
    const best = results.sort((a, b) => b.generation - a.generation || b.context - a.context)[0];
    if (!best) throw Error('No KV/drafting configuration passed context and quality checks.');
    await unloadAll();
    // Clear keys introduced by a losing trial as well as writing the winner.
    const options = Object.fromEntries(Object.keys(presets.get(j.model).options).map(k => [k, '']));
    await write(j, { ...options, ...best.applied });
    j.phase = 'Verifying saved winner'; save();
    await loadWinner(j);
    const final = await validate(j.model); check();
    j.result = { ...best, ...final, loaded: true, version: VERSION, signature: await signature(j.model), candidates: results.map(r => ({ kv: r.kv, context: r.context, generation: r.generation, spec: r.spec })) };
    state.history[j.model] = [{ at: now(), ...j.result }, ...(state.history[j.model] || [])].slice(0, 10);
    delete j.originalText; save();
    try { await onResult({ model: j.model, result: j.result }); } catch { note(j, 'Settings saved, but qualification evidence could not be recorded.'); }
    note(j, `Saved ${best.specLabel}, ${best.kv} KV and ${best.context} context together. Three quality probes passed; this is a smoke test, not a general quality guarantee.`);
  }
  async function run(j, release) {
    try {
      for (let index = 0; index < j.queue.length; index++) {
        check(); const item = j.queue[index]; j.model = item.model; j.steps = []; j.result = undefined; j.restored = undefined;
        j.progress = { done: 0, total: KV.length, percent: 0 }; item.status = 'running'; save();
        try { await tune(j); item.status = 'passed'; item.result = j.result; }
        catch (e) {
          await restore(j).catch(() => { j.restored = false; });
          item.status = cancelled ? 'cancelled' : 'failed'; item.error = e.message;
          if (cancelled || e.fatal || j.restored === false) throw e;
        }
        delete j.originalText;
        j.queueProgress = { done: index + 1, total: j.queue.length }; save();
      }
      j.status = j.queue.every(i => i.status === 'passed') ? 'passed' : 'failed';
      if (j.status === 'failed') j.error = j.queue.filter(i => i.status === 'failed').map(i => `${i.model}: ${i.error}`).join('; ');
      j.phase = j.status === 'passed' ? 'Done' : 'Finished with failures';
      j.progress = { done: j.steps.length, total: j.steps.length, percent: 100 };
    } catch (e) { j.status = cancelled ? 'cancelled' : 'failed'; j.phase = cancelled ? 'Cancelled' : 'Failed'; j.error = e.message;
      if (j.restored === false) j.error += ' Settings changed or restoration failed; inspect the profile before using it.';
    } finally {
      for (const item of j.queue) if (item.status === 'pending') item.status = 'skipped';
      j.finishedAt = now(); delete j.originalText; child = null; save(); release();
    }
  }
  async function start(model, { confirmPause, promptBudgetSeconds = 120, untuned: bulk = false } = {}) {
    if (confirmPause !== true) return { ok: false, status: 400, body: { error: 'Confirm that chat can pause and other model-server clients are stopped.' } };
    if (!Number.isInteger(Number(promptBudgetSeconds)) || promptBudgetSeconds < 15 || promptBudgetSeconds > 1800) return { ok: false, status: 400, body: { error: 'Choose a prompt time limit between 15 and 1800 seconds.' } };
    if (starting || state.job?.status === 'running') return { ok: false, status: 409, body: { error: 'Auto-tune is already running.' } };
    starting = true;
    let release;
    try {
      const scan = await candidates();
      const models = bulk ? scan.models : [model];
      if (!bulk && ![...scan.models, ...scan.skipped.filter(s => s.reason === 'Current tune already applied').map(s => s.model)].includes(model)) return { ok: false, status: 400, body: { error: 'Choose a configured chat model.' } };
      if (!models.length) return { ok: false, status: 409, body: { error: 'All configured chat models already have current tunes.' } };
      release = maintenance.hold('Chat is paused while automatic model tuning runs.');
      cancelled = false;
      const j = { id: crypto.randomUUID(), model: models[0], bulk, promptBudgetSeconds: Number(promptBudgetSeconds), status: 'running', phase: 'Preparing', startedAt: now(),
        steps: [], log: [], queue: models.map(model => ({ model, status: 'pending' })), queueProgress: { done: 0, total: models.length }, progress: { done: 0, total: KV.length, percent: 0 } };
      state.job = j; save(); completion = run(j, release); completion.catch(() => {});
      return { ok: true, status: 202, body: publicJob(j) };
    } catch (e) { release?.(); return { ok: false, status: 409, body: { error: e.message } }; }
    finally { starting = false; }
  }
  function cancel() {
    if (state.job?.status !== 'running') return { ok: false, status: 409, body: { error: 'No auto-tune is running.' } };
    cancelled = true; child?.cancel(); inflight?.abort(); return { ok: true, status: 202, body: publicJob(state.job) };
  }
  async function recover() {
    const j = state.job; if (j?.status !== 'running') return;
    await restore(j).catch(() => { j.restored = false; });
    j.status = 'interrupted'; j.phase = 'Interrupted'; j.finishedAt = now();
    j.error = j.restored === false ? 'Restart interrupted tuning; settings could not safely be restored.' : 'Restart interrupted tuning. Start again to remeasure.';
    for (const item of j.queue || []) if (['running', 'pending'].includes(item.status)) item.status = 'interrupted';
    delete j.originalText; save();
  }
  return { start, cancel, status, untuned, recover, completion: () => completion };
}
module.exports = { createFullAutotuner, qualityCheck, QUALITY, VERSION };
