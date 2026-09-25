'use strict';
// Measured context calibration for native llama.cpp models. Instead of predicting what
// fits, it asks the engine. Quick load checks (8K, doubling, then refined) find the
// largest size that loads, which only bounds the search: loading reserves memory but
// proves little. The real test is a near-full prompt that must finish within the admin's
// time limit and recall a marker from its start; those run middle-out between 8K and the
// load ceiling. The largest size that passed is written to the preset. Works on any hardware llama.cpp supports, because
// the only inputs are load outcomes, request outcomes and (when noevia shares the host)
// available system memory.
//
// Safety: holds the inference maintenance gate for the whole run (noevia chat pauses
// with an explanation), refuses to start while requests are in flight, aborts if another
// client loads a model, stops a step when available memory falls below a floor, and
// restores the original preset file on cancel, failure or an interrupted run.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { CTX_CANDIDATES } = require('./llamacpp-autoconfig.cjs');
const { isSystemModel, modelPathFromArgs, SYSTEM_MODEL_REASON } = require('./model-system.cjs');

const PAD = 'This is synthetic padding for a context allocation validation.\n';
const GIB = 1024 ** 3;
const HISTORY_PER_MODEL = 10;

function readMemAvailableGib() {
  // Inside a container /proc/meminfo reports the host, which is what a shared-memory GPU
  // allocates from. Returns null when unreadable (the guard is then skipped and noted).
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    return match ? Number(match[1]) * 1024 / GIB : null;
  } catch { return null; }
}

function ladder(native) {
  const ceiling = native > 0 ? native : 131072; // unknown training length: stay conservative
  return [...new Set([...CTX_CANDIDATES, ...(native > 0 ? [native] : [])])].filter(c => c >= 4096 && c <= ceiling).sort((a, b) => a - b);
}

function createCalibrator(deps) {
  const {
    request, rawModels, presets, maintenance, applyUnlocked, stateFile,
    stream = async () => { throw Error('Streaming is not configured.'); },
    conservativeFor = async () => null,
    readMemory = readMemAvailableGib,
    memoryFloorGib = 2,
    onResult = () => {},
    onUpdate = () => {}, onWrite = () => {},
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = () => Date.now(),
    timeouts = {},
  } = deps;
  const limits = { load: 600000, smoke: 180000, long: 7200000, unload: 60000, poll: 500, memoryPoll: 1000, recover: 180000, ...timeouts };
  let state = { job: null, history: {} };
  let cancelRequested = false, inflight = null;
  let completion = Promise.resolve();

  function load() {
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = { job: null, history: {} }; }
    if (!state.history || typeof state.history !== 'object') state.history = {};
  }
  function save() {
    onUpdate(state.job);
    if (!stateFile) return;
    const temp = `${stateFile}.${crypto.randomUUID()}`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, stateFile);
  }
  const publicJob = job => job && (({ originalText, ...rest }) => rest)(job);

  // A run that was still marked running when noevia stopped: put the preset back if the
  // file is still exactly what the job last wrote, so an operator's later edit survives.
  const NOT_RESTORED = ' The original profile was not restored because models.ini changed since the run started; check this model\'s context size.';
  async function recover() {
    load();
    const job = state.job;
    if (!job || job.status !== 'running') return;
    job.status = 'interrupted';
    job.finishedAt = now();
    job.error = 'noevia stopped during calibration.';
    try {
      if (job.originalText != null && job.lastRevision) {
        await presets.commit({ baseRevision: job.lastRevision, text: job.originalText });
        job.restored = true;
        await request('/models?reload=1', {}, 120000).catch(() => {});
      }
    } catch { job.restored = false; }
    if (job.restored === false) job.error += NOT_RESTORED;
    delete job.originalText;
    save();
  }

  const loadedOthers = (models, model) => models.filter(m => m.id !== model && ['loaded', 'loading'].includes(m.status?.value));

  async function listing(signal) {
    const response = await rawModels(signal);
    if (!response.ok || !Array.isArray(response.body?.data)) throw Object.assign(Error('The model server is not responding.'), { backend: true });
    return response.body.data;
  }
  async function waitForBackend() {
    const deadline = now() + limits.recover;
    while (now() < deadline) {
      try { await listing(); return true; } catch {}
      await sleep(2000);
    }
    return false;
  }
  async function unloadAll(except) {
    const models = await listing();
    for (const m of models) if (m.id !== except && ['loaded', 'loading'].includes(m.status?.value)) await request('/models/unload', { method: 'POST', body: JSON.stringify({ model: m.id }) }, limits.unload).catch(() => {});
    const deadline = now() + limits.unload;
    while (now() < deadline) {
      const rows = await listing();
      if (!rows.some(m => m.id !== except && m.status?.value !== 'unloaded')) return;
      await sleep(limits.poll);
    }
    throw Error('Models did not unload in time.');
  }
  async function unload(model) {
    await request('/models/unload', { method: 'POST', body: JSON.stringify({ model }) }, limits.unload).catch(() => {});
    const deadline = now() + limits.unload;
    while (now() < deadline) {
      try { const row = (await listing()).find(m => m.id === model); if (row?.status?.value === 'unloaded') return; } catch {}
      await sleep(limits.poll);
    }
  }

  // Samples on a timer during long requests and on every poll, so a fast load cannot
  // slip between samples. Returns {stop, check}; check() reports whether the floor held.
  function watchMemory(step, controller) {
    const sample = () => {
      const value = readMemory();
      if (value == null) return true;
      step.minAvailableGib = Math.min(step.minAvailableGib ?? Infinity, Math.round(value * 100) / 100);
      if (value < memoryFloorGib) { step.memoryFloorHit = true; controller.abort(); return false; }
      return true;
    };
    if (readMemory() == null) { step.memoryGuard = 'unavailable'; return { stop() {}, check: () => true }; }
    sample();
    const timer = setInterval(sample, limits.memoryPoll);
    return { stop: () => clearInterval(timer), check: sample };
  }

  async function chat(model, body, timeout, signal) {
    return request('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model, temperature: 0, stream: false, chat_template_kwargs: { enable_thinking: false }, ...body }), signal }, timeout);
  }
  async function tokensPerPadLine(model, signal) {
    try {
      const r = await request('/tokenize', { method: 'POST', body: JSON.stringify({ model, content: PAD.repeat(50) }), signal }, 30000);
      const n = Array.isArray(r.body?.tokens) ? r.body.tokens.length : 0;
      if (r.ok && n > 0) return n / 50;
    } catch {}
    return 16; // overestimate so the prompt undershoots rather than overflows
  }

  async function loadAndWait(model) {
    try {
      const started = await request('/models/load', { method: 'POST', body: JSON.stringify({ model }) }, 120000);
      if (!started.ok) return false;
      const deadline = now() + limits.load;
      for (let polls = 0; now() <= deadline && polls < 2400; polls++) {
        const row = (await listing()).find(m => m.id === model);
        if (row?.status?.value === 'loaded') return true;
        if (!row || row.status?.failed || row.status?.value === 'unloaded') return false;
        await sleep(limits.poll);
      }
    } catch {}
    return false;
  }

  // Streams a chat completion with prompt progress. Resolves with the generated text and
  // timing, or overBudget with the predicted total when the prompt would take too long.
  async function streamLong(model, content, controller, record, budgetMs) {
    const startedAt = now();
    let response;
    try {
      response = await stream('/v1/chat/completions', { method: 'POST', signal: controller.signal, body: JSON.stringify({ model, stream: true, return_progress: true, temperature: 0, cache_prompt: false, max_tokens: 64, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'user', content }] }) });
    } catch (e) { if (controller.signal.aborted) throw e; return { ok: false, error: 'The long prompt could not be sent.' }; }
    if (!response.ok || !response.body) return { ok: false, error: `The engine rejected the long prompt (HTTP ${response.status}).` };
    const decoder = new TextDecoder();
    let buffer = '', text = '', promptTokens = null, promptPerSecond = null, promptMs = null, lastSave = 0, stopped = null;
    // Leave the read loop before aborting: exiting a for-await over an already-aborted
    // body re-throws the abort, which would misreport a deliberate stop as a failure.
    read: for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let value; try { value = JSON.parse(data); } catch { continue; }
          if (value.error) { stopped = { ok: false, error: value.error.message || 'The engine reported an error.' }; break read; }
          const progress = value.prompt_progress;
          if (progress && progress.total > 0) {
            const done = Math.max(0, progress.processed - (progress.cache || 0)), remaining = progress.total - progress.processed;
            record.progress = Math.round((progress.processed / progress.total) * 100);
            const elapsed = now() - startedAt;
            // The engine reports a one-token event first; extrapolating from it would
            // predict a runaway time. Wait for a real batch before judging.
            if (done >= 512 && progress.time_ms >= 500) {
              const etaMs = elapsed + remaining * (progress.time_ms / done);
              record.etaSeconds = Math.round(Math.max(0, etaMs - elapsed) / 1000);
              // Stop early only when clearly over; a size near the limit runs to the end and
              // is judged by the engine's measured prompt time instead of a forecast.
              if ((elapsed > 5000 && etaMs > budgetMs * 1.15) || etaMs > budgetMs * 2) { stopped = { ok: false, overBudget: true, predicted: true, etaMs }; break read; }
            }
            if (now() - lastSave > 1500) { lastSave = now(); save(); }
          }
          if (now() - startedAt > budgetMs * 1.5) { stopped = { ok: false, overBudget: true, predicted: false, etaMs: now() - startedAt }; break read; }
          const delta = value.choices?.[0]?.delta || {};
          text += `${delta.content || ''}${delta.reasoning_content || ''}`;
          if (value.timings) { promptTokens = Number(value.timings.prompt_n) || promptTokens; promptPerSecond = Number(value.timings.prompt_per_second) || promptPerSecond; promptMs = Number(value.timings.prompt_ms) || promptMs; }
          if (value.usage?.prompt_tokens) promptTokens = Number(value.usage.prompt_tokens);
        }
      }
    }
    if (stopped) { controller.abort(); delete record.etaSeconds; return stopped; }
    delete record.etaSeconds;
    const tookMs = promptMs || (now() - startedAt);
    if (tookMs > budgetMs) return { ok: false, overBudget: true, predicted: false, etaMs: tookMs };
    return { ok: true, text, promptTokens, promptPerSecond, promptSeconds: Math.round(tookMs / 100) / 10 };
  }

  // One measured step: write the context, load, and test. Returns true when it passed.
  async function step(job, ctx, kind) {
    if (cancelRequested) throw Object.assign(Error('cancelled'), { cancelled: true });
    const record = { ctx, kind, status: 'running', startedAt: now() };
    job.steps.push(record); job.phase = kind === 'long' ? `Long-prompt test at ${ctx.toLocaleString('en-US')} tokens` : `Loading at ${ctx.toLocaleString('en-US')} tokens`;
    save();
    // Memory freed by the previous unload can take a moment to return.
    for (let waited = 0; readMemory() != null && readMemory() < memoryFloorGib; waited++) {
      if (waited >= 30) { record.status = 'failed'; record.reason = `Available memory stayed below ${memoryFloorGib} GiB with the model unloaded.`; save(); throw Object.assign(Error(`Available memory stayed below ${memoryFloorGib} GiB even with the model unloaded. Free memory on this machine, then retry.`), { fatal: true }); }
      await sleep(1000);
    }
    const controller = new AbortController();
    inflight = controller;
    const memory = watchMemory(record, controller);
    const finish = (status, reason) => { record.status = status; if (reason) record.reason = reason; record.seconds = Math.round((now() - record.startedAt) / 1000); save(); return status === 'passed'; };
    try {
      await unloadAll();
      const applied = await applyUnlocked({ model: job.model, baseRevision: job.lastRevision || job.originalRevision, options: { ...job.base, 'ctx-size': String(ctx) } });
      if (!applied.ok) throw Object.assign(Error(applied.body?.error || 'Could not write the test profile.'), { fatal: true });
      job.lastRevision = presets.get(job.model).revision;
      onWrite(job.lastRevision);
      const started = await request('/models/load', { method: 'POST', body: JSON.stringify({ model: job.model }), signal: controller.signal }, 120000);
      if (!started.ok) return finish('failed', 'The engine refused to load the model at this size.');
      const deadline = now() + limits.load;
      for (;;) {
        if (cancelRequested) throw Object.assign(Error('cancelled'), { cancelled: true });
        if (!memory.check() || record.memoryFloorHit) return finish('failed', `Available memory fell below ${memoryFloorGib} GiB.`);
        if (now() > deadline) return finish('failed', 'Loading did not finish in time.');
        const rows = await listing(controller.signal).catch(e => { if (record.memoryFloorHit) return []; throw e; });
        if (loadedOthers(rows, job.model).length) throw Object.assign(Error('Another client loaded a model during calibration. Stop Diary background jobs and other clients, then retry.'), { fatal: true });
        const row = rows.find(m => m.id === job.model);
        if (row?.status?.value === 'loaded') { if (!memory.check()) return finish('failed', `Available memory fell below ${memoryFloorGib} GiB.`); break; }
        if (!row || row.status?.failed || row.status?.value === 'unloaded') return finish('failed', 'The model failed to load at this size.');
        await sleep(limits.poll);
      }
      if (kind === 'load') {
        const smoke = await chat(job.model, { messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_tokens: 16 }, limits.smoke, controller.signal);
        if (record.memoryFloorHit) return finish('failed', `Available memory fell below ${memoryFloorGib} GiB.`);
        return smoke.ok && Array.isArray(smoke.body?.choices) ? finish('passed') : finish('failed', 'The loaded model did not answer a short request.');
      }
      // Near-capacity recall test against the per-slot window, streamed so progress can
      // be watched: the run stops as soon as the full prompt is predicted to exceed the
      // time limit, rather than waiting it out.
      const slots = Math.max(1, Number(job.base.parallel || presets.get(job.model).options.parallel) || 1);
      const target = Math.floor((ctx / slots) * 0.9) - 256;
      const marker = `CAL-${crypto.randomInt(1000, 9999)}-${crypto.randomInt(1000, 9999)}`;
      const perLine = await tokensPerPadLine(job.model, controller.signal);
      const repeats = Math.max(1, Math.floor(target / perLine));
      const budgetMs = job.promptBudgetSeconds * 1000;
      const result = await streamLong(job.model, `Remember the start marker: ${marker}.\n${PAD.repeat(repeats)}\nReturn only the start marker.`, controller, record, budgetMs);
      if (record.memoryFloorHit) return finish('failed', `Available memory fell below ${memoryFloorGib} GiB.`);
      if (result.overBudget) return finish('failed', result.predicted
        ? `Filling this context would take about ${Math.ceil(result.etaMs / 1000)} s, over the ${job.promptBudgetSeconds} s limit.`
        : `Filling this context took ${Math.ceil(result.etaMs / 1000)} s, over the ${job.promptBudgetSeconds} s limit.`);
      if (!result.ok) return finish('failed', result.error || 'The long prompt failed.');
      record.promptTokens = result.promptTokens;
      if (result.promptPerSecond) record.promptPerSecond = Math.round(result.promptPerSecond);
      if (result.promptSeconds) record.promptSeconds = result.promptSeconds;
      if (!result.text.includes(marker)) return finish('failed', 'The model did not recall the marker from the start of the prompt.');
      if (record.promptTokens && record.promptTokens < target * 0.8) return finish('failed', 'The engine accepted fewer prompt tokens than requested.');
      return finish('passed');
    } catch (e) {
      if (e.cancelled || cancelRequested) { finish('skipped', 'Cancelled.'); throw Object.assign(Error('cancelled'), { cancelled: true }); }
      if (e.fatal) { finish('failed', e.message); throw e; }
      if (record.memoryFloorHit) return finish('failed', `Available memory fell below ${memoryFloorGib} GiB.`);
      // The engine went away (for example an out-of-memory restart): that size failed.
      const back = await waitForBackend();
      if (!back) { finish('failed', 'The model server stopped responding.'); throw Object.assign(Error('The model server did not come back after a failed step.'), { fatal: true }); }
      return finish('failed', 'The model server failed during this step.');
    } finally {
      memory.stop();
      inflight = null;
      await unload(job.model).catch(() => {});
    }
  }

  async function run(job, release) {
    try {
      await unloadAll();
      const snapshot = presets.snapshot();
      job.originalText = snapshot.text;
      job.originalRevision = snapshot.revision;
      save();
      const grid = ladder(job.native);
      const start = grid.find(c => c >= 8192) || grid.at(-1);
      let lastPass = 0, firstFail = 0, ctx = start;
      for (;;) {
        if (await step(job, ctx, 'load')) {
          lastPass = ctx;
          if (ctx >= grid.at(-1)) break;
          ctx = grid.find(c => c >= ctx * 2) || grid.at(-1);
        } else { firstFail = ctx; break; }
      }
      if (!lastPass) throw Object.assign(Error(`The model did not load even at ${start.toLocaleString('en-US')} tokens.`), { fatal: true });
      for (let i = 0; firstFail && i < 3; i++) {
        const between = grid.filter(c => c > lastPass && c < firstFail);
        if (!between.length) break;
        const mid = between[Math.floor(between.length / 2)];
        if (await step(job, mid, 'load')) lastPass = mid; else firstFail = mid;
      }
      job.result = { loadCtx: lastPass };
      // Load checks only bound the search; a size counts when a near-full prompt finishes
      // within the time limit and recalls its start marker. Start in the middle of the
      // model's range and move up on a pass, down on a failure.
      const sizes = grid.filter(c => c >= start && c <= lastPass);
      let low = -1, high = sizes.length, idx = Math.floor((sizes.length - 1) / 2);
      for (let tests = 0; high - low > 1 && tests < 7; tests++) {
        if (await step(job, sizes[idx], 'long')) low = idx; else high = idx;
        idx = low + Math.max(1, Math.floor((high - low) / 2));
        if (idx >= high) break;
      }
      if (low < 0) throw Object.assign(Error(`No size passed the long-prompt test within ${job.promptBudgetSeconds} s, down to ${start.toLocaleString('en-US')} tokens.`), { fatal: true });
      const chosen = sizes[low];
      job.result.verifiedCtx = chosen;
      await unloadAll();
      const applied = await applyUnlocked({ model: job.model, baseRevision: job.lastRevision || job.originalRevision, options: { ...job.base, 'ctx-size': String(chosen) } });
      if (!applied.ok) throw Object.assign(Error(applied.body?.error || 'Could not save the calibrated profile.'), { fatal: true });
      job.lastRevision = presets.get(job.model).revision;
      onWrite(job.lastRevision);
      job.result.appliedCtx = chosen;
      // Leave the model loaded with its calibrated profile, ready for the next chat.
      job.phase = 'Loading the calibrated profile';
      save();
      job.result.loaded = await loadAndWait(job.model);
      if (!job.result.loaded) throw Object.assign(Error('The calibrated profile did not load.'), { fatal: true });
      job.status = 'passed';
      job.phase = 'Done';
      const props = await request('/props', {}, 8000).catch(() => null);
      const entry = { at: now(), promptBudgetSeconds: job.promptBudgetSeconds, ...job.result, build: props?.body?.build_info || null, slots: Math.max(1, Number(presets.get(job.model).options.parallel) || 1) };
      state.history[job.model] = [entry, ...(state.history[job.model] || [])].slice(0, HISTORY_PER_MODEL);
      try { await onResult({ model: job.model, status: 'passed', entry }); } catch { /* evidence is best-effort */ }
    } catch (e) {
      job.status = e.cancelled ? 'cancelled' : 'failed';
      job.phase = e.cancelled ? 'Cancelled' : 'Failed';
      if (!e.cancelled) job.error = e.message || 'Calibration failed.';
      // Put the original profile back; never overwrite a file someone else changed since.
      try {
        if (job.originalText != null && job.lastRevision && presets.snapshot().revision === job.lastRevision) {
          await presets.commit({ baseRevision: job.lastRevision, text: job.originalText });
          onWrite(presets.snapshot().revision);
          await request('/models?reload=1', {}, 120000).catch(() => {});
          job.restored = true;
        } else if (job.originalText != null && job.lastRevision) job.restored = false;
      } catch { job.restored = false; }
      if (job.restored === false) job.error = (job.error || (e.cancelled ? 'Calibration cancelled.' : 'Calibration failed.')) + NOT_RESTORED;
      // Evidence identity must reflect the restored profile, so record only after restoring.
      if (!e.cancelled && e.fatal) { try { await onResult({ model: job.model, status: 'failed', entry: { at: now(), promptBudgetSeconds: job.promptBudgetSeconds, error: job.error } }); } catch { /* best-effort */ } }
    } finally {
      job.finishedAt = now();
      delete job.originalText;
      cancelRequested = false;
      save();
      release();
    }
  }

  async function start(model, { promptBudgetSeconds = 120, confirmPause } = {}) {
    if (confirmPause !== true) return { ok: false, status: 400, body: { error: 'Confirm that chat can pause and that Diary background jobs and other clients are stopped.' } };
    promptBudgetSeconds = Number(promptBudgetSeconds);
    if (!Number.isInteger(promptBudgetSeconds) || promptBudgetSeconds < 15 || promptBudgetSeconds > 1800) return { ok: false, status: 400, body: { error: 'Choose a prompt time limit between 15 and 1800 seconds.' } };
    if (state.job?.status === 'running') return { ok: false, status: 409, body: { error: 'A calibration is already running.' } };
    let models;
    try { models = await listing(); } catch { return { ok: false, status: 502, body: { error: 'The model server is not responding.' } }; }
    const row = models.find(m => m.id === model);
    if (!row) return { ok: false, status: 404, body: { error: 'Choose an installed model.' } };
    if (isSystemModel(model, modelPathFromArgs(row.status?.args))) return { ok: false, status: 400, body: { error: SYSTEM_MODEL_REASON } };
    let base = {}, native = Number(row.meta?.n_ctx_train) || 0;
    const profile = presets.get(model);
    const conservative = await conservativeFor(model).catch(() => null);
    if (!native && conservative?.native) native = conservative.native;
    // A model with no profile yet starts from the estimator's settings (context aside).
    if (!profile.exists && conservative?.values) {
      for (const [key, value] of Object.entries(conservative.values)) if (key !== 'ctx-size' && profile.fields.includes(key)) base[key] = value;
    }
    if (!profile.exists && !base.parallel) base.parallel = '1';
    let release;
    try { release = maintenance.hold(`Chat is paused while noevia calibrates ${model}. It will be available again when calibration finishes or is cancelled.`); }
    catch { return { ok: false, status: 409, body: { error: 'Requests are in progress. Wait for them to finish, then start calibration.' } }; }
    cancelRequested = false;
    const job = { id: crypto.randomUUID(), model, promptBudgetSeconds, native, base, status: 'running', phase: 'Preparing', startedAt: now(), steps: [], memoryFloorGib, memoryGuard: readMemory() == null ? 'unavailable' : 'active' };
    state.job = job;
    save();
    completion = run(job, release);
    completion.catch(() => {});
    return { ok: true, status: 202, body: publicJob(job) };
  }

  function cancel() {
    if (state.job?.status !== 'running') return { ok: false, status: 409, body: { error: 'No calibration is running.' } };
    cancelRequested = true;
    inflight?.abort();
    return { ok: true, status: 202, body: publicJob(state.job) };
  }

  function status(model) {
    return { ok: true, status: 200, body: { job: publicJob(state.job), history: model ? state.history[model] || [] : undefined } };
  }

  load();
  return { start, cancel, status, recover, completion: () => completion, _state: () => state };
}

module.exports = { createCalibrator, ladder, readMemAvailableGib };
