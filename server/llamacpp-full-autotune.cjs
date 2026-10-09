'use strict';
// A durable ordered script: one model lease, then KV, context, drafting and batch commits.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WORKLOADS, SPEC_CANDIDATES, geomean } = require('./llamacpp-tune-spec.cjs');
const { hasHarmonyReasoning, quirksOf, toIniOptions, INI_KEY_LIST } = require('./sampling-recommendation.cjs');
const { isSystemModel, modelPathFromArgs, SYSTEM_MODEL_REASON } = require('./model-system.cjs');
const VERSION = 3;
// #1062: waits for another router client per model before the tune stops as interrupted.
const FOREIGN_YIELDS = 6;
// #1079: Fast tunes a model's own models.ini section with today's prompt time limit; Long tunes its
// `<model>-long` section with a limit up to 1800 s, so the context search can reach whatever the
// memory budget allows (same planner, KV rules and memory budget; only the time limit differs).
const MODES = { fast: { defaultSeconds: 120, maxSeconds: 1800 }, long: { defaultSeconds: 1800, maxSeconds: 1800 } };
const LONG_SUFFIX = require('./long-profile.cjs').SUFFIX;
const LONG_PROFILE_REASON = 'Long-context profile — tuned with Long mode from its model';
const LONG_REFUSALS = {
  invalid_id: "This model's name is too long, or not a valid models.ini name, for a long-context profile.",
  ambiguous: 'models.ini has a section the model server would read differently (a duplicate or unusual header), so auto-tune does not add one. Check models.ini, then try again.',
  no_base: 'This model has no section of its own in models.ini, so there is nothing to copy for a long-context profile.',
  no_model: 'The model server does not say which file this model loads, so a long-context profile cannot point at it.',
  bad_path: "This model's file path cannot be written to models.ini safely, so no long-context profile was added.",
  too_large: 'models.ini would pass its 1 MiB limit with a long-context profile added.',
};
const longRefusal = reason => LONG_REFUSALS[reason] || 'The long-context profile could not be prepared safely; nothing was changed.';
const longClash = item => 'models.ini already has a section named ' + item.model + ' that loads a different file. Rename or remove it, then run a Long tune.';
// #1057 (owner's KV policy): bf16 (unquantized) by default, q8_0 the floor. q5_1/q5_0 only with
// the model's own opt-in (allowQ5Kv, saved with its tune settings below); q4_0 also needs the
// operator's override env var (#190), so it is never reached without both. f16 is no longer a
// candidate: it stands in for bf16 only when the engine rejects bf16 (see BF16_UNSUPPORTED).
// Both orders prefer precision: a more compact type is taken only when it fits about twice the
// context (the planner's rule in autotune-plan; preferKv for the js order's KV phase).
const KV_FLOOR_OVERRIDE_ENV = 'NOEVIA_AUTOTUNE_ALLOW_BELOW_Q5_KV';
const allowBelowQ5Kv = () => ['1', 'true', 'yes', 'on'].includes(String(process.env[KV_FLOOR_OVERRIDE_ENV] || '').toLowerCase());
const kvCandidates = ({ allowQ5Kv = false } = {}) => [
  'bf16', 'q8_0', ...(allowQ5Kv === true ? ['q5_1', 'q5_0', ...(allowBelowQ5Kv() ? ['q4_0'] : [])] : []),
];
const UNQUANTIZED = new Set(['bf16', 'f16']);
// The engine's own words for "this build cannot use a bf16 cache" (llama.cpp's cache type checks,
// a backend without the kernel). Read like load-verdict reads text: lowercase, _ and - as spaces.
// Only these, on a bf16 probe, swap f16 in; anything else (memory above all) stays a failure.
const BF16_UNSUPPORTED = [/unsupported (kv )?cache type/, /cache type .{0,24}not supported/,
  /bf16.{0,80}(unsupported|not supported|missing op|no kernel)/, /(unsupported|not supported|does not support|missing op|no kernel).{0,80}bf16/];
// #1061: one line at a time, so a device banner naming bf16 and a later failure line are never
// read as one sentence.
const bf16Unsupported = text => {
  if (typeof text !== 'string' || !text) return false;
  return text.split(/[\r\n]+/).some(line => {
    const flat = line.toLowerCase().replace(/[_-]/g, ' ').replace(/[ \t]+/g, ' ');
    return BF16_UNSUPPORTED.some(re => re.test(flat));
  });
};
const BF16_FALLBACK = 'This engine does not support a bf16 KV cache, so auto-tune uses f16 (also unquantized) in its place.';
// #1058: an engine that dies loading bf16 says nothing; at the smallest rung that is not memory.
const BF16_CRASH_FALLBACK = 'The engine failed to load a bf16 KV cache even at the smallest context without saying why, so auto-tune tries f16 (also unquantized) in its place.';
/** Precision first (#1057): the most precise passing type; a later (more compact) one replaces it
 *  only when its largest fitting context is at least twice the current choice's. `passed` is in
 *  candidate order; `ceilings` maps a type to its largest fitting rung (null: none), or is null
 *  when the model cannot be sized, and then the most precise passing type stands. */
function preferKv(passed, ceilings) {
  if (!passed.length) return null;
  if (!ceilings) return passed[0];
  let pick = null;
  for (const kv of passed) {
    const cap = ceilings[kv];
    if (cap == null) continue;
    if (!pick || cap >= 2 * pick.cap) pick = { kv, cap };
  }
  return pick ? pick.kv : passed[0];
}
const UBATCH = [512, 1024, 2048];
const PAD = 'The garden committee reviewed irrigation, seed orders, volunteer rotas and pump maintenance. ';
const PHASES = [['sampling', 'Sampling'], ['kv', 'KV cache'], ['context', 'Context size'], ['drafting', 'Drafting'], ['batch', 'Batch and micro-batch']];
// #1003 AUTOTUNE_PLAN_IMPL=wasm: Rust's planner (autotune-plan in dav-parse.wasm) orders the run.
// Context first, then the KV cache type for it, each choice proven by filling ~90% of the context
// and recalling a marker (plus the quality probes); then sampling, drafting and batch once each,
// one final fill check and the serving check, never a measured step twice. Default js: the order
// above. Read per job start, so a flip takes effect on the next tune.
const PLANNED_PHASES = [['context', 'Context and KV cache'], ['sampling', 'Sampling'], ['drafting', 'Drafting'], ['batch', 'Batch and micro-batch'], ['verify', 'Final fill check']];
const PLAN_FLAG = 'AUTOTUNE_PLAN_IMPL';
const planModeOf = (env = process.env) => (String(env[PLAN_FLAG] ?? '').trim().toLowerCase() === 'wasm' ? 'wasm' : 'js');
function defaultPlanner() {
  return { mode: () => planModeOf(), plan: request => require('./dav-parse-wasm.cjs').autotunePlan(request) };
}
// Kept free beside the tuned model for the services that run alongside it (Laya).
const SERVICES_RESERVE_MIB = 2560;
const PLAN_CAUSE = { oom: 'oom', load: 'load_failed', time: 'over_time', recall: 'recall_failed' };
const PLAN_STEP_LIMIT = 64;
// #1004 LAYA_LOAD_ADVISOR=on: a guessed failure cause is named by Rust's rules (load-verdict), the
// decision service advising only when no rule matches (load-advisor.cjs). Default off: unchanged.
function defaultLoadAdvisor() { return require('./load-advisor.cjs').createLoadAdvisor(); }
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
const REFERENCE_LABEL = { f16: 'f16 KV cache, drafting off', bf16: 'bf16 KV cache, drafting off', current: 'the current settings, drafting off' };
function baselineOf(reference, quality) {
  return { reference, probes: quality.checks.filter(c => c.passed).map(c => c.id),
    skipped: quality.checks.filter(c => !c.passed).map(c => ({ id: c.id, reason: c.reason, ...(c.answer ? { answer: c.answer } : {}) })) };
}
const baselineSummary = b => 'Quality baseline at ' + REFERENCE_LABEL[b.reference] + ': ' + [
  ...b.probes.map(id => id + ' passed'),
  ...b.skipped.map(s => s.id + ' skipped (the model gets this wrong at its reference settings'
    + (s.answer ? '; answered "' + s.answer + '"' : '') + ')'),
].join(', ') + '.';
// #1003 (CHAT_TEMPLATE_CAPS_IMPL=wasm): before a profile is signed off, one chat request shaped
// the way chat sends one (a system prompt, a user turn, the app's function-tool shape) must be
// served. Tools go only where chat would send them (the template check, chat-template-caps.cjs);
// an engine that still refuses them for the template gets the same one retry without tools that
// chat makes. The verdict is Rust's (chat-template-caps serving_verdict). Synthetic text only.
const SERVING_MESSAGES = [
  { role: 'system', content: 'You are a helpful assistant in a project workspace. Use a tool only when it is needed, and answer briefly.' },
  { role: 'user', content: 'Which seed orders did the garden committee approve last week?' },
];
const SERVING_TOOLS = [
  { type: 'function', function: { name: 'search_files', description: 'Search the files of this project.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to look for.' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'more_tools', description: "Call this only if none of the offered tools can do the user's task.", parameters: { type: 'object', properties: {} } } },
];
function defaultServingChecks() {
  const caps = require('./chat-template-caps.cjs'), wasm = require('./dav-parse-wasm.cjs');
  return { mode: () => caps.mode(), templateCaps: (t) => wasm.templateCaps(t), verdict: (status, body) => wasm.servingVerdict(status, body) };
}
const NO_PROBE_PASSED = 'The model failed every quality probe at its reference settings, so auto-tune cannot tell whether a setting harms it.';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = value => Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
const cancelledError = () => Object.assign(Error('Cancelled'), { cancelled: true });
const publicJob = job => job && JSON.parse(JSON.stringify(job, (key, value) =>
  key.startsWith('_') || ['originalText', 'lastRevision', 'originalRevision', 'beforeText'].includes(key) ? undefined : value));
const step = (id, label) => ({ id, label, status: 'pending' });
function stepsFor(id, kv = kvCandidates()) {
  return id === 'sampling' ? [step('apply', 'Recommended sampling')]
    : id === 'kv' ? kv.map(k => step(k, k + ' KV cache'))
    : id === 'drafting' ? SPEC_CANDIDATES.map(c => step(c.id, c.label))
    : id === 'batch' ? UBATCH.map(n => step(String(n), 'Micro-batch ' + n))
    : [step('capacity', 'Load and long-prompt recall')];
}
// kv: the cache types this item tries, fixed when the job starts (#1057), so a settings change
// mid-run or before a resume never changes a run that has measured already.
function newModel(model, planned = false, kv = kvCandidates()) {
  if (planned) return { model, status: 'pending', kv, plan: { results: [] }, phases: PLANNED_PHASES.map(([id, label]) => ({
    id, label, status: 'pending', steps: ['context', 'verify'].includes(id) ? [] : stepsFor(id, kv),
  })) };
  return { model, status: 'pending', kv, phases: PHASES.map(([id, label]) => ({
    id, label, status: 'pending', steps: stepsFor(id, kv),
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

// #1049: a rejection from the engine's own transport (fetch errors, stream or HTTP failures, anything
// the engine's words can reach) never becomes a step reason, phase reason, note or job error: those are
// stored in the state file and returned by status(). The caller sees a fixed sentence; the original is
// logged only. Errors noevia creates itself (literals in this file, publicFail) pass through untouched.
function engineBoundary(call) {
  return async (...args) => {
    try { return await call(...args); }
    catch (e) {
      if (e?.cancelled || e?.name === 'AbortError' || e?.fatal || e?.publicMessage) throw e;
      console.error('[autotune] engine request failed:', e?.stack || e);
      throw Object.assign(Error(/timed out|timeout/i.test(String(e?.message)) ? 'The model server request timed out.' : 'The model server request failed.'), { engineFailure: true });
    }
  };
}

function createFullAutotuner({ request: engineRequest, rawModels: engineRawModels, presets, maintenance, applyUnlocked, identityFor,
  contextFactory, samplingFor = null, stateFile, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  betweenModelsMs = 1000, idleTimeoutMs = 300000,
  readMemory = require('./llamacpp-calibration.cjs').readMemAvailableGib, memoryFloorGib = 2, onResult = async () => {},
  // #545: true when a router row is a preset whose model file is not in the models folder.
  fileMissing = () => false, servingChecks = defaultServingChecks(),
  // #1003: the planner (AUTOTUNE_PLAN_IMPL), the model's GGUF facts ({ meta, modelBytes, mmprojBytes }
  // or null) and the inference memory budget in GiB.
  planner = defaultPlanner(), planFacts = async () => null, budgetGib = () => 16, servicesReserveMib = SERVICES_RESERVE_MIB,
  loadAdvisor = defaultLoadAdvisor(),
  // #1062: another client of the router (one that skips noevia's maintenance gate) may load its own
  // model mid-tune. Auto-tune waits for it, at most foreignWaitMs per wait and FOREIGN_YIELDS waits
  // per model, and resumes the step; Rust's tune_contention (dav-parse.wasm) decides each look.
  foreignWaitMs = 15 * 60000, foreignQuietMs = 30000, foreignPollMs = 2000,
  contention = req => require('./dav-parse-wasm.cjs').tuneContention(req),
  // #1079: a Long tune's `<model>-long` section (long-profile.cjs, Rust's decisions) and the router
  // re-read after it is added (the manager's guarded reload; the plain router call by default).
  longProfiles = require('./long-profile.cjs').createLongProfiles(), reloadRouter: routerReload = null }) {
  const request = engineBoundary(engineRequest), rawModels = engineBoundary(engineRawModels);
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
  state.history ||= {};
  // #1057: per-model tune settings, kept with the history: { [model]: { allowQ5Kv } }.
  state.settings ||= {};
  let cancelled = false, child = null, completion = Promise.resolve(), starting = false, inflight = null, idleAbort = null;
  const save = () => { const tmp = stateFile + '.' + crypto.randomUUID(); fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, stateFile); };
  const check = () => { if (cancelled) throw cancelledError(); };
  const note = (j, text) => { (j.log ||= []).push({ at: now(), text }); if (j.log.length > 400) j.log.shift(); save(); };
  const phaseOf = (item, id) => item.phases.find(p => p.id === id);
  const settingsOf = model => ({ allowQ5Kv: state.settings[model]?.allowQ5Kv === true });
  // #1062: rows the router reports as running (server-models.h is_running) other than `model`.
  const LIVE = ['loaded', 'loading', 'sleeping'];
  const anotherClient = () => Object.assign(Error('Another client loaded a model during tuning.'), { fatal: true });
  // Requests in flight on a resident model (llamacpp:requests_processing), or null when unreadable.
  async function requestsProcessing(id) {
    try {
      const r = await request('/metrics?model=' + encodeURIComponent(id) + '&autoload=false', {}, 6000);
      if (!r?.ok || typeof r.body !== 'string') return null;
      const n = require('./llamacpp-metrics.cjs').parseMetrics(r.body).requests_processing;
      return Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff ? n : null;
    } catch { return null; }
  }
  // #1067: live rows other than `tuning` that only tune_contention may stop. Resident and known idle
  // may be stopped directly as before; so may a model this job already finished tuning (left loaded
  // by its own tune) unless it is busy. Loading, busy or unreadable goes to the decision.
  async function heldForeign(rows, tuning) {
    const done = new Set((state.job?.models || []).filter(m => m.status === 'passed').map(m => m.model));
    const held = [];
    for (const row of rows) {
      if (row.id === tuning || !LIVE.includes(row.status?.value)) continue;
      if (row.status.value === 'loading') { held.push(row.id); continue; }
      const busy = await requestsProcessing(row.id);
      if (busy > 0 || (busy === null && !done.has(row.id))) held.push(row.id);
    }
    return held;
  }
  const idList = ids => ids.slice(0, 4).map(id => String(id).slice(0, 120)).join(', ') + (ids.length > 4 ? ' and ' + (ids.length - 4) + ' more' : '');
  /**
   * #1062: another client has a model live while `j.model` is being tuned. Waits (cancellable)
   * until Rust's tune_contention says the router is clear, or that the other models are idle and
   * quiet, in which case it sends the router's own unload for them (the path every step already
   * takes) and returns; the caller then repeats its step. Never stops a model with requests in
   * flight or still loading. Past the limit it throws { fatal, foreignTimeout } and the job stops
   * as interrupted, resumable. When the decision cannot be had (module missing or refusing), it
   * fails closed by throwing `legacy`, the error this caller threw before #1062.
   */
  async function yieldToForeign(j, legacy, { restoring = false } = {}) {
    const tuning = j?.model;
    if (typeof tuning !== 'string' || !tuning) throw legacy;
    const item = j.models?.find(m => m.model === tuning);
    const startedAt = now();
    let prev = null, announced = false;
    for (;;) {
      if (!restoring) check();
      const listing = await rawModels();
      if (!listing.ok || !Array.isArray(listing.body?.data)) throw Error('The model server stopped responding.');
      const rows = [];
      for (const row of listing.body.data) {
        const status = typeof row?.status?.value === 'string' ? row.status.value : '';
        const resident = row?.id !== tuning && (status === 'loaded' || status === 'sleeping');
        rows.push({ id: row?.id, status, busy: resident ? await requestsProcessing(row.id) : null });
      }
      let d;
      try { d = contention({ tuning, rows, prev, startedAt, now: now(), maxWaitMs: foreignWaitMs, quietMs: foreignQuietMs }); }
      catch { throw legacy; }
      if (d.action === 'proceed') { if (announced) note(j, 'The other client is done; tuning continues.'); return; }
      if (!announced) {
        announced = true;
        // Only real waits count; one that finds the router already clear does not.
        const yields = item ? (item._foreignYields = (item._foreignYields || 0) + 1) : 1;
        if (yields > FOREIGN_YIELDS) throw Object.assign(Error('Another client kept loading ' + idList(d.foreign) + ' during tuning. Stop it, then resume auto-tune.'), { fatal: true, foreignTimeout: true });
        note(j, 'Another client is using ' + idList(d.foreign) + '. Tuning is paused until it is idle (at most ' + Math.round(foreignWaitMs / 60000) + ' min).');
      }
      if (d.action === 'give_up') throw Object.assign(Error('Another client kept using ' + idList(d.foreign) + ' for ' + Math.round(d.waitedMs / 60000) + ' min. Resume auto-tune when it is done.'), { fatal: true, foreignTimeout: true });
      if (d.action === 'unload') {
        let raced = false;
        for (const id of d.unload) {
          if (!restoring) check();
          // #1069: read the count again right before stopping it; a request that just arrived wins.
          const now2 = await requestsProcessing(id);
          if (now2 > 0 || (now2 === null && d.reason === 'idle')) { raced = true; break; }
          const u = await request('/models/unload', { method: 'POST', body: JSON.stringify({ model: id }) }, 60000);
          if (!u.ok) throw Error('Could not unload ' + id + ' before testing.');
        }
        if (!raced) {
          note(j, 'Unloaded ' + idList(d.unload) + ', idle after another client used it; tuning continues.');
          return;
        }
        prev = null; await sleep(foreignPollMs); continue;
      }
      prev = { fingerprint: d.fingerprint, since: d.since };
      await sleep(foreignPollMs);
    }
  }
  const candidatesFor = model => kvCandidates(settingsOf(model));
  // #1079: the router's rows and which of them pair as a model and its long profile.
  async function routerPairs() {
    const r = await rawModels();
    if (!r.ok || !Array.isArray(r.body?.data)) throw publicFail('The model server is not responding.');
    return { rows: r.body.data, pairs: longProfiles.pairsOf(r.body.data, presets) };
  }
  // The list a queued item tries: its own snapshot, or (a job from before #1057) today's.
  const itemKv = item => (Array.isArray(item?.kv) && item.kv.length ? item.kv : candidatesFor(item?.model));
  // kvCandidates: the list this server really tries for this model, so the panel never describes
  // another build's (or another model's); settings: the model's own tune settings (#1057).
  // #1079: longId and longHistory are the model's Long tune (its `<model>-long` section).
  const status = model => ({ ok: true, status: 200, body: { job: publicJob(state.job), history: model ? state.history[model] || [] : [], kvCandidates: candidatesFor(model), settings: settingsOf(model), planImpl: planner.mode(), loadAdvisor: loadAdvisor.enabled() ? 'on' : 'off',
    modes: MODES, ...(model ? { longId: model + LONG_SUFFIX, longHistory: state.history[model + LONG_SUFFIX] || [] } : {}) } });
  /** #1057: saves a model's tune settings; they apply from its next tune. */
  function setSettings(model, body) {
    if (typeof model !== 'string' || !model || model.length > 200) return { ok: false, status: 400, body: { error: 'Choose a model.' } };
    if (!body || typeof body !== 'object' || typeof body.allowQ5Kv !== 'boolean') return { ok: false, status: 400, body: { error: 'allowQ5Kv must be true or false.' } };
    if (isSystemModel(model)) return { ok: false, status: 400, body: { error: SYSTEM_MODEL_REASON } };
    if (!presets.get(model).exists) return { ok: false, status: 404, body: { error: 'Choose a configured chat model.' } };
    // #1060: a queued, running or resumable item keeps the list it started with; changing the
    // switch under it would make its result's signature disagree with what it measured.
    const j = state.job;
    if (j && Array.isArray(j.models) && (j.status === 'running' || ['cancelled', 'interrupted', 'failed'].includes(j.status))
        && j.models.some(m => (m.model === model || m.base === model) && m.status !== 'passed'))
      return { ok: false, status: 409, body: { error: 'This model is in an unfinished tune. Let it finish, or start a new tune, before changing this setting.' } };
    if (body.allowQ5Kv) state.settings[model] = { allowQ5Kv: true }; else delete state.settings[model];
    save();
    return status(model);
  }
  // #1003: one recovery copy of models.ini per tune run. The first write of a job keeps the
  // writer's usual copy (the profile as it was before tuning); every later write, restores
  // included, asks for none (the web writer skips it, Model Loader gets the hint).
  const writeOptions = j => (j._backedUp ? { backup: false } : {});
  const wrote = j => { if (!j._backedUp) { j._backedUp = true; save(); } };
  // kvs (#1060): the KV list the tune used (the item's snapshot) or, for the untuned scan, the one
  // the model's switch gives now; a q5 list differs from a default one either way round.
  async function signature(model, suppliedIdentity, kvs = candidatesFor(model)) {
    const identity = suppliedIdentity || await identityFor(model);
    if (!identity) throw publicFail('Model identity could not be read.');
    const profile = presets.get(model);
    // A default list adds nothing, so tunes from before #1057 stay current.
    return hash({ version: VERSION, identity, options: sorted({ ...profile.defaults, ...profile.options }), ...(kvs.some(k => k === 'q5_1' || k === 'q5_0') ? { kv: 'q5' } : {}) });
  }
  async function candidates() {
    const r = await rawModels();
    if (!r.ok || !Array.isArray(r.body?.data)) throw publicFail('The model server is not responding.');
    const models = [], skipped = [];
    // #1079: a long profile is tuned with Long mode from its model's page, never by a Fast scan.
    const longs = new Set(longProfiles.pairsOf(r.body.data, presets).map(p => p.long));
    for (const row of r.body.data) {
      if (longs.has(row.id)) { skipped.push({ model: row.id, reason: LONG_PROFILE_REASON }); continue; }
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
      // #1060: the newest tune is the one in models.ini; an older entry with another KV list is not.
      const latest = state.history[row.id]?.[0];
      if (latest?.version === VERSION && latest.signature === current) skipped.push({ model: row.id, reason: 'Current tune already applied' });
      else models.push(row.id);
    }
    return { models, skipped };
  }
  async function untuned() { try { return { ok: true, status: 200, body: await candidates() }; } catch (e) { return { ok: false, status: 502, body: { error: clientMessage(e, 'Could not list untuned models.') } }; } }
  async function unloadAll({ restoring = false } = {}) {
    for (;;) {
      const foreign = await unloadAllOnce({ restoring });
      if (!foreign) return;
      // #1062: a model other than the tuned one came back (or would not go) while unloading: another
      // client is using the router. Wait for it, then unload again.
      await yieldToForeign(state.job, Error(foreign), { restoring });
    }
  }
  async function unloadAllOnce({ restoring = false } = {}) {
    if (!restoring) check();
    const tuning = state.job?.model;
    const r = await rawModels();
    if (!r.ok || !Array.isArray(r.body?.data)) throw Error('The model server is not responding.');
    const asked = new Set(), gone = new Set();
    // #1067: a live model other than the one being tuned is another client's until tune_contention
    // says it is idle; yieldToForeign decides, and unloads it only then.
    if (tuning) {
      const held = await heldForeign(r.body.data, tuning);
      if (held.length) return 'Another client has ' + idList(held) + ' loaded.';
    }
    for (const row of r.body.data) if (['loaded', 'loading'].includes(row.status?.value)) {
      asked.add(row.id);
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
      for (const row of listing.body.data) if (row.status?.value === 'unloaded') gone.add(row.id);
      const pending = listing.body.data.filter(row => row.status?.value !== 'unloaded');
      if (!pending.length) return null;
      const message = 'Timed out waiting for router unload: ' + pending.map(row =>
        row.id + ' (' + (row.status?.value || 'unknown') + ')').join(', ') + '.';
      // Loading again after we asked it to stop, live again after it was gone, or live and never
      // asked: someone else wants it.
      const foreign = pending.filter(row => row.id !== tuning && LIVE.includes(row.status?.value));
      if (foreign.some(row => row.status?.value === 'loading' || gone.has(row.id) || !asked.has(row.id))) return message;
      if (poll === 119 || now() >= deadline) { if (foreign.length) return message; throw Error(message); }
      await sleep(500);
    }
  }
  async function write(j, options) {
    check();
    if (presets.snapshot().revision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
    await unloadAll();
    const r = await applyUnlocked({ model: j.model, baseRevision: j._revision, options }, writeOptions(j));
    if (r.ok) wrote(j);
    if (!r.ok) throw Object.assign(Error(r.body?.error || 'Could not save settings; the profile may have changed.'), { fatal: r.status === 409 });
    j._revision = presets.snapshot().revision; save();
  }
  async function chat(model, prompt, max, extra = null) {
    check();
    const rows = await rawModels();
    if (!rows.ok || !Array.isArray(rows.body?.data)) throw Error('The model server stopped responding.');
    if (rows.body.data.some(r => r.id !== model && ['loaded', 'loading'].includes(r.status?.value))) {
      const j = state.job;
      // #1062: wait for the other client, reload the profile under test and send this request then.
      if (j?.model !== model) throw Object.assign(Error('Another client loaded a model during tuning.'), { fatal: true });
      await yieldToForeign(j, anotherClient());
      await load(j);
      return chat(model, prompt, max, extra);
    }
    const controller = new AbortController(); inflight = controller;
    let lowMemory = false;
    const guard = () => { const free = readMemory(); if (free != null && free < memoryFloorGib) { lowMemory = true; controller.abort(); } };
    guard(); const timer = setInterval(guard, 500);
    let r;
    try { r = await request('/v1/chat/completions', { method: 'POST', signal: controller.signal, body: JSON.stringify({
      model, stream: false, temperature: 0, max_tokens: max, cache_prompt: false,
      ...(quirksOf(model).reasoningEffort ? { reasoning_effort: quirksOf(model).reasoningEffort } : {}),
      chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'user', content: prompt }], ...(extra || {}),
    }) }, 180000); }
    catch (e) {
      if (lowMemory) throw Error('Available memory fell below the safety floor.');
      if (!cancelled && !e?.cancelled && await evictedBy(model)) return retryAfterForeign(model, prompt, max, extra);
      throw e;
    }
    finally { clearInterval(timer); inflight = null; }
    check();
    if (lowMemory) throw Error('Available memory fell below the safety floor.');
    // #1069: a failed answer while another client has a model live is that client's doing, not
    // this candidate's: wait for it, reload the profile under test and ask again.
    const failed = extra ? !(Number(r?.status) >= 200 && Number(r?.status) < 300) && !r?.ok : !r?.ok || !r.body?.choices?.length;
    if (failed && await evictedBy(model)) return retryAfterForeign(model, prompt, max, extra);
    if (extra) return { status: Number.isInteger(r?.status) ? r.status : r?.ok ? 200 : 0, bodyText: typeof r?.body === 'string' ? r.body : JSON.stringify(r?.body ?? null) };
    if (!r.ok) return { failure: 'HTTP ' + (r.status || 'error') };
    if (!r.body?.choices?.length) return { failure: 'no response' };
    const t = r.body.timings || {};
    return { text: r.body.choices[0]?.message?.content || '', gen: Number(t.predicted_per_second),
      prompt: Number(t.prompt_per_second), drafted: Number(t.draft_n) || 0, accepted: Number(t.draft_n_accepted) || 0,
      finishReason: r.body.choices[0]?.finish_reason };
  }
  async function evictedBy(model) { return state.job?.model === model && (await othersLiveNow(model)) === true; }
  async function retryAfterForeign(model, prompt, max, extra) {
    await yieldToForeign(state.job, anotherClient());
    await load(state.job);
    return chat(model, prompt, max, extra);
  }
  async function load(j) {
    check();
    const ask = async () => {
      const response = await request('/models/load', { method: 'POST', body: JSON.stringify({ model: j.model }) }, 600000);
      if (!response.ok) throw Error('The test profile could not be loaded.');
    };
    await ask();
    for (let polls = 0; polls < 1200; polls++) {
      check();
      const free = readMemory(); if (free != null && free < memoryFloorGib) throw Error('Available memory fell below the safety floor.');
      const r = await rawModels();
      if (!r.ok) throw Error('The model server stopped responding.');
      if (r.body.data.some(m => m.id !== j.model && ['loaded', 'loading'].includes(m.status?.value))) {
        // #1062: the router evicted the profile under test for another client: wait, load it again.
        await yieldToForeign(j, anotherClient());
        await ask(); polls = 0; continue;
      }
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
  // The calibrator's writes: only over the revision this job last wrote, models unloaded first.
  const guardedApply = j => async body => {
    if (body.baseRevision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
    await unloadAll();
    const r = await applyUnlocked(body, writeOptions(j));
    if (r?.ok) wrote(j);
    return r;
  };
  async function contextStage(j, p, prefix = '') {
    check();
    if (presets.snapshot().revision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
    const offset = prefix ? p.steps.length : 0;
    // A wait for another client that gave up (or was cancelled) inside the calibrator stops the
    // tune as that, not as a context failure.
    let foreignStop = null;
    child = contextFactory({
      applyUnlocked: guardedApply(j),
      // #1062: the calibrator waits for another client the same way, then repeats its step.
      foreignHeld: rows => heldForeign(rows, j.model),
      foreignWait: async legacy => { try { await yieldToForeign(j, legacy); } catch (e) { if (e.foreignTimeout || e.cancelled) foreignStop = e; throw e; } },
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
      if (foreignStop && result.status !== 'passed') throw foreignStop;
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
  // sized (#1026, planned runs): { ctx, f16, kv } - the smallest rung, whether f16 fits there and
  // the most precise type that does; every baseline write then carries that ctx-size.
  async function ensureBaseline(j, original, { tryF16 = true, sized = null } = {}) {
    if (gate(j.model)) return;
    const restore = keysOf(original);
    if (sized) {
      tryF16 &&= sized.f16;
      original = { ...original, 'cache-type-k': sized.kv, 'cache-type-v': sized.kv };
    }
    const at = options => (sized ? { ...options, 'ctx-size': String(sized.ctx) } : options);
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
    let reference = 'f16', quality = tryF16 ? await attempt('f16', at(REFERENCE)) : null;
    if (!quality) { reference = 'current'; quality = await attempt('current', at({ ...keysOf(original), 'spec-type': 'none', 'spec-draft-n-max': '', 'spec-draft-p-min': '' })); }
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
    const item = j.models.find(m => m.model === j.model), kvs = itemKv(item);
    const before = { ...presets.get(j.model).options }, results = [];
    // #1057: sized once, every model unloaded, for the precision-first choice below.
    await unloadAll();
    const ceilings = await kvCeilings(j.model, kvs);
    // #1058: the order can grow by one, f16 right after a bf16 that failed to load.
    const order = [...kvs];
    let kvFallback = null;
    for (let i = 0; i < order.length; i++) {
      const kv = order[i];
      check(); note(j, 'Testing ' + kv + ' KV cache with drafting off.');
      await unloadAll();
      // With no baseline yet, an unquantized candidate (bf16, or f16) is a reference setting
      // itself: its probes become the baseline instead of loading a reference profile as well.
      const reuse = UNQUANTIZED.has(kv) && !gate(j.model);
      const measured = await measure(j, p, kv, { 'cache-type-k': kv, 'cache-type-v': kv,
        'spec-type': 'none', 'spec-draft-n-max': '', 'spec-draft-p-min': '' }, async () => {
        if (!reuse) return validate(j.model);
        const quality = await qualityCheck(j.model, chat);
        if (engineFailed(quality)) throw Error(qualityFailure(quality));
        const b = setBaseline(j, kv, quality);
        // Judged like any later candidate: on the probes its own run passed, the rest skipped.
        return validate(j.model, { passed: true, checks: quality.checks.filter(c => b.probes.includes(c.id)),
          ...(b.skipped.length ? { skipped: b.skipped.map(s => s.id) } : {}) });
      });
      if (measured) results.push({ kv, ...measured });
      // #1058: bf16 did not load (the engine refused it or died; this order sees no engine text):
      // f16 once in its place, before anything else, so it can still be the baseline.
      const failure = p.steps.find(s => s.id === kv)?.reason || '';
      // Not when the estimate says the profile's context does not fit bf16: that may be memory, and
      // f16 is the same size. Unsizeable models (no ceilings) still get the one retry.
      const profileCtx = Number({ ...presets.get(j.model).defaults, ...presets.get(j.model).options }['ctx-size']) || 0;
      const fitsBf16 = !ceilings || (ceilings.bf16 != null && (!profileCtx || ceilings.bf16 >= profileCtx));
      if (!measured && kv === 'bf16' && fitsBf16 && !order.includes('f16') && /failed to load|could not be loaded/i.test(failure)) {
        order.splice(i + 1, 0, 'f16');
        p.steps.splice(p.steps.findIndex(s => s.id === kv) + 1, 0, step('f16', 'f16 KV cache'));
        kvFallback = { from: 'bf16', to: 'f16' };
        if (ceilings) ceilings.f16 = ceilings.bf16;
        note(j, 'bf16 KV cache did not load; trying f16 (also unquantized) in its place.');
        save();
        continue;
      }
      // An unquantized candidate that could not be the baseline: measure one (f16 first, unless
      // f16 itself just failed), as before #1057.
      if (UNQUANTIZED.has(kv) && !gate(j.model)) await ensureBaseline(j, before, { tryF16: kv !== 'f16' });
    }
    // Precision first, not the fastest: a more compact type only when it fits twice the context.
    const chosen = preferKv(results.map(r => r.kv), ceilings);
    const best = results.find(r => r.kv === chosen);
    if (!best) throw Error('No KV cache type passed quality and throughput checks.');
    const restoreSpec = Object.fromEntries(['spec-type', 'spec-draft-n-max', 'spec-draft-p-min'].map(k => [k, before[k] || '']));
    await write(j, { 'cache-type-k': best.kv, 'cache-type-v': best.kv, ...restoreSpec });
    await load(j);
    const final = await validate(j.model);
    p.value = { kv: best.kv, ...(kvFallback && best.kv === 'f16' ? { kvFallback } : {}), generation: best.generation, quality: final.quality, candidates: results.map(r => ({ kv: r.kv, generation: r.generation, ...(ceilings ? { ceiling: ceilings[r.kv] ?? null } : {}) })) };
    note(j, 'Committed ' + best.kv + ' KV cache after quality checks' + (ceilings && best.kv !== results[0].kv
      ? ' (it fits ' + ceilings[best.kv] + ' tokens, at least twice what ' + results[0].kv + ' fits).' : '.'));
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
    // Planned runs (#1003) check the context once, after the last phase, instead of here.
    if (!planOf(j)) await verifyContext(j, p);
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
    if (!planOf(j)) await verifyContext(j, p);
    p.value = { ubatch: best.ub, batch: Math.max(2048, best.ub), promptPerSecond: best.promptPerSecond,
      generation: final.generation, acceptance: final.acceptance, quality: final.quality };
    note(j, 'Committed micro-batch ' + best.ub + '.');
  }
  const planOf = j => j.models?.find(m => m.model === j.model)?.plan || null;
  const phaseRuns = { sampling: runSampling, kv: runKv, context: runContext, drafting: runDrafting, batch: runBatch };
  async function restorePhase(j, p) {
    if (p._beforeText == null) return true;
    if (presets.snapshot().revision !== j._revision) { p.restored = false; return false; }
    try {
      // #1068: restoring the file needs only the tuned model stopped, never another client's; the
      // router's re-read waits while another client has a model live.
      await unloadOwn(j);
      await presets.commit({ baseRevision: j._revision, text: p._beforeText }, j._backedUp ? { backup: false } : undefined);
      j._revision = presets.snapshot().revision; save();
      await reloadRouter(j);
      p.restored = true;
      delete p._beforeText; save();
      return true;
    } catch { p.restored = false; save(); return false; }
  }
  async function unloadOwn(j) {
    // The tuned model is often gone already (evicted by another client): ask only when it runs, and
    // a refused unload is not a failure if the row goes (or is) unloaded anyway.
    const first = await rawModels();
    if (!first.ok || !Array.isArray(first.body?.data)) throw Error('The model server stopped responding while unloading.');
    const own = first.body.data.find(m => m.id === j.model);
    if (own && LIVE.includes(own.status?.value)) await request('/models/unload', { method: 'POST', body: JSON.stringify({ model: j.model }) }, 60000).catch(() => null);
    const deadline = now() + 60000;
    for (let poll = 0; poll < 120; poll++) {
      const listing = await rawModels();
      if (!listing.ok || !Array.isArray(listing.body?.data)) throw Error('The model server stopped responding while unloading.');
      const row = listing.body.data.find(m => m.id === j.model);
      if (!row || row.status?.value === 'unloaded') return;
      if (now() >= deadline) break;
      await sleep(500);
    }
    throw Error('Timed out waiting for router unload: ' + j.model + '.');
  }
  // The router re-reads models.ini now, or (#1068) once no other client has a model live.
  async function othersLiveNow(model) {
    try { const r = await rawModels(); return !r.ok || !Array.isArray(r.body?.data) ? null : r.body.data.some(row => row.id !== model && LIVE.includes(row.status?.value)); }
    catch { return null; }
  }
  async function reloadRouter(j) {
    if ((await othersLiveNow(j.model)) === false) {
      const reload = await request('/models?reload=1', {}, 120000);
      if (!reload.ok) throw Error('The router did not confirm restored settings.');
      j._reloadPending = false; save();
      return;
    }
    j._reloadPending = true;
    note(j, 'models.ini is restored; the model server re-reads it once the other client is done.');
    scheduleReload(j);
  }
  let reloadTimer = null;
  function scheduleReload(j, tries = 0) {
    clearTimeout(reloadTimer);
    if (!j._reloadPending) return;
    if (tries > 120) { note(j, 'The model server has not re-read the restored models.ini; it does so before this model next loads.'); return; }
    reloadTimer = setTimeout(async () => {
      if (!j._reloadPending) return;
      if ((await othersLiveNow(j.model)) === false) {
        try { const r = await request('/models?reload=1', {}, 120000); if (r.ok) { j._reloadPending = false; note(j, 'The model server re-read the restored models.ini.'); return; } } catch { /* retried below */ }
      }
      scheduleReload(j, tries + 1);
    }, Math.max(foreignPollMs * 15, 1));
    reloadTimer.unref?.();
  }
  /** #1068: before the tuned model loads again (chat or a new tune), the router re-reads the restored
   *  file even with another client live (its unchanged preset keeps it running), so it never serves
   *  the test profile. A no-op unless a re-read is pending (for `model`, when given). */
  async function flushReload(model = null) {
    const j = state.job;
    if (!j?._reloadPending || (model && model !== j.model)) return;
    clearTimeout(reloadTimer);
    const r = await request('/models?reload=1', {}, 120000);
    if (!r.ok) throw publicFail('The model server has not re-read the restored settings yet. Try again shortly.');
    j._reloadPending = false; note(j, 'The model server re-read the restored models.ini.');
  }
  async function runPhase(j, item, p) {
    check();
    if (presets.snapshot().revision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
    p._beforeText = presets.snapshot().text;
    p.status = 'running'; p.startedAt = now();
    p.steps = stepsFor(p.id, itemKv(item));
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
  async function servingCheck(j, model) {
    if (servingChecks.mode() !== 'wasm') return null;
    const props = await request('/props?model=' + encodeURIComponent(model) + '&autoload=false', {}, 8000).catch(() => null);
    const template = props?.ok && typeof props.body?.chat_template === 'string' ? props.body.chat_template : null;
    let sendTools = true;
    // Unknown (no template, or one the check refuses as too large): send tools, as chat does.
    if (template !== null) { try { sendTools = servingChecks.templateCaps(template).sendTools; } catch { sendTools = true; } }
    const ask = (tools) => chat(model, '', 64, { messages: SERVING_MESSAGES, ...(tools ? { tools: SERVING_TOOLS } : {}) });
    let r = await ask(sendTools);
    let verdict;
    // A module that cannot run means the switch is effectively off (as in chat): skip the check.
    try { verdict = servingChecks.verdict(r.status, r.bodyText); } catch { note(j, 'The realistic chat check was skipped: its checker is unavailable.'); return null; }
    let retried = false;
    if (!verdict.passed && sendTools && verdict.kind === 'template_or_tools_unsupported') {
      note(j, 'The engine refused tools for this chat template; checking again without tools, as chat would.');
      retried = true; sendTools = false;
      r = await ask(false);
      try { verdict = servingChecks.verdict(r.status, r.bodyText); } catch { return null; }
    }
    if (!verdict.passed) {
      throw publicFail('The saved profile cannot serve a realistic chat request' + (sendTools ? " with the app's tools" : '') + ': '
        + (verdict.reason || verdict.kind.replace(/_/g, ' ')) + '.');
    }
    return { passed: true, toolsSent: sendTools, templateKnown: template !== null, retriedWithoutTools: retried };
  }
  async function finishModel(j, item, final, planned = null) {
    const identity = await identityFor(item.model);
    if (!identity || hash({ ...identity, profile: undefined }) !== item._identity)
      throw Object.assign(Error('Model identity changed since tuning began.'), { fatal: true });
    const kv = planned || phaseOf(item, 'kv').value, ctx = planned ? { context: planned.ctx } : phaseOf(item, 'context').value,
      draft = phaseOf(item, 'drafting').value, batch = phaseOf(item, 'batch').value;
    const result = { kv: kv.kv, context: ctx.context, ...(planned ? { plan: 'wasm', probes: item.plan.results.filter(r => r.step === 'probe').length } : {}),
      ...(item.plan?.kvFallback || phaseOf(item, 'kv')?.value?.kvFallback ? { kvFallback: item.plan?.kvFallback || phaseOf(item, 'kv').value.kvFallback } : {}), spec: draft.spec, specLabel: draft.specLabel,
      generation: final.generation, acceptance: final.acceptance, ubatch: batch.ubatch,
      promptPerSecond: batch.promptPerSecond, quality: final.quality, extensions: [],
      sampling: phaseOf(item, 'sampling')?.value || null, ...(item.baseline ? { baseline: item.baseline } : {}),
      ...(final.serving ? { serving: final.serving } : {}),
      loaded: true, version: VERSION, signature: await signature(item.model, identity, itemKv(item)) };
    if (presets.snapshot().revision !== j._revision)
      throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
    item.result = result; item.status = 'passed';
    state.history[item.model] = [{ at: now(), ...result }, ...(state.history[item.model] || [])].slice(0, 10);
    save();
    try { await onResult({ model: item.model, result }); } catch { note(j, 'Settings saved, but qualification evidence could not be recorded.'); }
  }
  // ── #1003: the planned order (AUTOTUNE_PLAN_IMPL=wasm) ─────────────────────────────────────
  const uint = (v, max = 2 ** 40) => (Number.isSafeInteger(v) && v >= 0 && v <= max ? v : 0);
  const layerList = v => (Array.isArray(v)
    ? (v.length <= 4096 && v.every(x => typeof x === 'boolean' || uint(x, 1 << 20) === x) ? v : null)
    : (uint(v, 1 << 20) === v ? v : null));
  // The prompt cache every auto-tune write leaves (llamacpp-presets prepare): unset becomes the
  // cap, anything larger the hard maximum; -1 stays unbounded.
  function tuneCacheMib(eff) {
    const { cacheRamMibOf } = require('./llamacpp-autoconfig.cjs');
    const budgetLib = require('./inference-budget.cjs'), rawCache = String(eff['cache-ram'] ?? '').trim();
    return rawCache === '' ? budgetLib.cacheRamLimits().capMib
      : rawCache === '-1' ? Infinity : cacheRamMibOf(budgetLib.clampCacheRam(rawCache));
  }
  // #1057: the js order's KV phase, sized like the planner: per type, the largest ladder rung whose
  // estimate (llamacpp-autoconfig estimateFootprint) fits the budget, MemAvailable less the
  // services' reserve and the floor. Null when the model cannot be sized: precision alone decides.
  async function kvCeilings(model, kvs) {
    try {
      const read = await planFacts(model);
      if (!read?.meta) return null;
      const profile = presets.get(model), eff = { ...profile.defaults, ...profile.options };
      const cacheMib = tuneCacheMib(eff);
      if (!Number.isFinite(cacheMib)) return null;
      const { ladder } = require('./llamacpp-calibration.cjs');
      // noevia#1133: planning, not the gate: the JS estimate, so LLAMACPP_AUTOCONFIG_IMPL=wasm keeps the ceilings.
      const { estimateFootprintJs: estimateFootprint } = require('./llamacpp-autoconfig.cjs');
      const free = readMemory();
      const usableMib = Math.min(Number(budgetGib()) * 1024, free == null ? Infinity : free * 1024 - servicesReserveMib - memoryFloorGib * 1024);
      const rungs = ladder(uint(read.meta.contextLength, 1 << 24));
      const out = {};
      for (const kv of kvs) {
        const fit = rungs.filter(c => {
          const e = estimateFootprint({ meta: read.meta, modelBytes: read.modelBytes, mmprojBytes: read.mmprojBytes || 0, model,
            options: { ...eff, 'ctx-size': String(c), 'cache-type-k': kv, 'cache-type-v': kv, 'cache-ram': String(cacheMib), 'ubatch-size': String(Math.max(uint(Number(eff['ubatch-size']), 1 << 24), ...UBATCH)) } });
          return e.sizeable && e.totalGib != null && e.totalGib * 1024 <= usableMib;
        });
        out[kv] = fit.length ? fit.at(-1) : null;
      }
      return Object.values(out).some(v => v != null) ? out : null;
    } catch { return null; }
  }
  // The planner's request: the model's facts, the budget (MemAvailable read once, now, with every
  // model unloaded, so a resumed job plans from the same figures), the ladder and the KV types
  // (the item's list, #1057).
  async function planRequest(model, kv = candidatesFor(model)) {
    const read = await planFacts(model);
    if (!read?.meta) return { fallback: 'its model file could not be read' };
    const m = read.meta, profile = presets.get(model), eff = { ...profile.defaults, ...profile.options };
    const { ladder } = require('./llamacpp-calibration.cjs');
    const native = uint(m.contextLength, 1 << 24);
    const cacheMib = tuneCacheMib(eff);
    // #1029: an unbounded prompt cache (cache-ram -1) cannot be sized; the standard order runs.
    if (!Number.isFinite(cacheMib)) return { fallback: 'its prompt cache is unbounded (cache-ram -1)' };
    const free = readMemory();
    return {
      facts: { nCtxTrain: native, blockCount: uint(m.blockCount, 4096), headCount: uint(m.headCount, 1 << 20), headCountKv: layerList(m.headCountKv),
        embeddingLength: uint(m.embeddingLength, 1 << 20), keyLength: uint(m.keyLength, 1 << 20), valueLength: uint(m.valueLength, 1 << 20),
        keyLengthSwa: uint(m.keyLengthSwa, 1 << 20), valueLengthSwa: uint(m.valueLengthSwa, 1 << 20), slidingWindow: uint(m.slidingWindow, 1 << 24),
        slidingWindowPattern: layerList(m.slidingWindowPattern), sharedKvLayers: uint(m.sharedKvLayers, 4096),
        fullAttentionInterval: uint(m.fullAttentionInterval, 4096), nextnPredictLayers: uint(m.nextnPredictLayers, 4096),
        modelBytes: uint(read.modelBytes, 2 ** 50), mmprojBytes: uint(read.mmprojBytes, 2 ** 50),
        // #1027: sized for the largest micro-batch the batch phase tries, so its candidates and the
        // final check stay inside the estimate the context was chosen with.
        ubatch: Math.max(uint(Number(eff['ubatch-size']), 1 << 24), ...UBATCH), slots: Math.max(1, uint(Number(eff.parallel), 1024)) },
      memory: { budgetMib: uint(Math.floor(Number(budgetGib()) * 1024), 2 ** 30), memAvailableMib: free == null ? null : uint(Math.floor(free * 1024), 2 ** 30),
        reserveMib: uint(servicesReserveMib, 2 ** 30), floorMib: uint(Math.round(memoryFloorGib * 1024), 2 ** 30),
        cacheRamMib: uint(cacheMib, 2 ** 30) },
      ladder: ladder(native), kv,
    };
  }
  function fallBack(j, item, why) {
    item.plan = null; item.planFallback = why;
    item.phases = newModel(item.model, false, itemKv(item)).phases;
    note(j, 'Using the standard tuning order for ' + item.model + ': ' + why + '.');
    return false;
  }
  // Runs fn inside phase p: on a failure models.ini goes back to p's starting text (as runPhase).
  async function inStage(j, p, fn) {
    if (p.status !== 'running') { p._beforeText = presets.snapshot().text; p.status = 'running'; p.startedAt = now(); }
    j.phase = p.label; save();
    try { return await fn(); } catch (e) {
      const restored = await restorePhase(j, p);
      p.status = cancelled || e.cancelled ? 'interrupted' : 'failed'; p.reason = e.message;
      for (const s of p.steps) if (s.status === 'running') { s.status = 'interrupted'; s.reason = e.message; }
      p.finishedAt = now(); save();
      if (!restored) throw Object.assign(Error(e.message + ' Settings changed or restoration failed; inspect models.ini before resuming.'), { unsafe: true });
      throw e;
    }
  }
  function closeStage(j, p, value) {
    p.status = 'passed'; p.finishedAt = now(); p.value = value; p._committedRevision = j._revision;
    delete p._beforeText; save();
  }
  // One fill-and-recall step through the calibrator, then (for a probe) the quality probes at the
  // same profile. Returns the planner's outcome name and the reason.
  async function fillCheck(j, step, base, withQuality) {
    check();
    if (presets.snapshot().revision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
    await unloadAll();
    const cal = contextFactory({ applyUnlocked: guardedApply(j), onWrite: revision => { j._revision = revision; save(); }, onUpdate: () => {} });
    child = { cancel: () => cal.cancelProbe() };
    let r;
    // #1057: a bf16 step keeps the engine's evidence too, to tell "this build has no bf16 cache".
    const bf16 = base['cache-type-k'] === 'bf16';
    try { r = await cal.probe(j.model, { ctx: step.ctx, fill: step.fill, base, baseRevision: j._revision, promptBudgetSeconds: j.promptBudgetSeconds, evidence: loadAdvisor.enabled() || bf16 }); }
    finally { child = null; }
    check();
    if (!r.passed) {
      const request = j.models.find(m => m.model === j.model)?.plan?.request;
      if (bf16 && request && !request.kv.includes('f16')) {
        if (bf16Unsupported(r.evidence?.text)) return { outcome: 'kv_unsupported', reason: BF16_FALLBACK };
        // #1058: a failed router row (no HTTP status, no text: the process exited) at the smallest
        // rung; tried with f16 once, the guard above keeping it once.
        const ev = r.evidence, silent = r.cause === 'load' && !!ev && !ev.text && ev.status == null;
        if (silent && step.ctx === request.ladder[0]) return { outcome: 'kv_unsupported', reason: BF16_CRASH_FALLBACK };
        if (silent) return { outcome: 'load_failed', reason: r.reason || 'The fill-and-recall test failed.', silent: true };
      }
      const own = { outcome: r.cause === 'timeout' ? 'timeout' : PLAN_CAUSE[r.cause] || 'load_failed', reason: r.reason || 'The fill-and-recall test failed.' };
      if (!loadAdvisor.enabled()) return own;
      // #1004: rules first, the decision service only on a tie; null keeps the calibrator's cause.
      const judged = await loadAdvisor.judge({ cause: r.cause, evidence: r.evidence || null });
      check();
      if (!judged || judged.classification.source === 'measured') return own;
      return { outcome: judged.outcome, reason: own.reason + ' ' + judged.reason, classification: judged.classification };
    }
    if (withQuality) {
      try {
        await load(j);
        const quality = await qualityCheck(j.model, chat, gate(j.model));
        if (!quality.passed) return { outcome: 'quality_failed', reason: qualityFailure(quality) };
      } catch (e) {
        if (e.fatal || e.cancelled || cancelled) throw e;
        return { outcome: /memory/i.test(e.message) ? 'oom' : /timed out/i.test(e.message) ? 'timeout' : 'load_failed', reason: e.message };
      }
    }
    return { outcome: 'passed', reason: null, promptSeconds: r.promptSeconds };
  }
  const SPEC_OFF = { 'spec-type': 'none', 'spec-draft-n-max': '', 'spec-draft-p-min': '' };
  // #1026: the baseline's size, by the planner's own estimate: the smallest rung, and the most
  // precise KV type that fits there (asked as a one-rung, one-type plan; a probe means it fits).
  function baselineSize(plan) {
    const ctx = plan.request.ladder[0];
    const fits = kv => { try { return planner.plan({ ...plan.request, ladder: [ctx], kv: [kv], results: [] }).step === 'probe'; } catch { return false; } };
    const kv = plan.request.kv.find(fits);
    if (!kv) throw publicFail('This model does not fit the inference memory budget even at the smallest context size.');
    // f16 and bf16 are the same size, so the f16 reference fits wherever bf16 does (#1057).
    return { ctx, kv, f16: UNQUANTIZED.has(kv) };
  }
  // #1029: a load that did not finish in time says nothing about memory. Tried once more; then the
  // run stops (resumable) instead of stepping the context or KV type down.
  const LOAD_TIMEOUT = 'The test profile did not finish loading in time twice, so auto-tune cannot judge this setting. Check the model server, then resume.';
  // #1004: no smaller context or more compact cache type fixes a chat template the engine rejects.
  const TEMPLATE_STOP = "The engine could not use this model's chat template, so auto-tune stopped instead of trying smaller settings. Check the model's chat template, then resume.";
  async function measureFill(j, item, p, step, kind) {
    const plan = item.plan;
    // Unique even after a bf16 fallback dropped results (#1058).
    let id = kind + '-' + plan.results.length;
    while (p.steps.some(r => r.id === id)) id += 'b';
    const row = { id, label: (kind === 'probe' ? 'Fill ' : 'Final fill ') + step.ctx.toLocaleString('en-US') + ' · ' + step.kv + ' KV cache',
      status: 'running', ctx: step.ctx, kv: step.kv, estimateMib: step.estimateMib, startedAt: now() };
    p.steps.push(row); save();
    note(j, (kind === 'probe' ? 'Filling ' : 'Final check: filling ') + step.ctx + ' tokens with ' + step.kv + ' KV cache (estimate ' + step.estimateMib + ' MiB).');
    const run = () => (kind === 'probe'
      ? fillCheck(j, step, { 'cache-type-k': step.kv, 'cache-type-v': step.kv, ...SPEC_OFF }, true)
      : fillCheck(j, step, {}, false));
    let r = await run();
    if (r.outcome === 'timeout') { note(j, 'Loading timed out; trying the same setting once more.'); r = await run(); }
    if (r.classification) {
      row.classification = r.classification;
      if (r.classification.advisor !== 'not_asked') note(j, 'Decision service advice for this failure: ' + r.classification.advisor + '.');
    }
    if (r.outcome === 'timeout') {
      Object.assign(row, { status: 'failed', reason: LOAD_TIMEOUT, finishedAt: now() });
      throw publicFail(LOAD_TIMEOUT);
    }
    if (r.outcome === 'template') {
      Object.assign(row, { status: 'failed', reason: TEMPLATE_STOP, finishedAt: now() });
      throw publicFail(TEMPLATE_STOP);
    }
    if (r.outcome === 'kv_unsupported') {
      // #1057: f16 takes bf16's place in the list, recorded on
      // the plan and noted on the job. Nothing is recorded for this step: the planner asks for the
      // same context with f16 next, as the two are the same size.
      // The bf16 failures before it are dropped, not carried over: they may be the same refusal,
      // and as f16 results they would rule f16 out where it was never tried.
      Object.assign(row, { status: 'failed', reason: r.reason, finishedAt: now() });
      const swap = k => (k === 'bf16' ? 'f16' : k);
      plan.request.kv = plan.request.kv.map(swap);
      plan.results = plan.results.filter(e => !(e.step === 'probe' && e.kv === 'bf16' && e.outcome !== 'passed'))
        .map(e => (e.kv ? { ...e, kv: swap(e.kv) } : e));
      item.kv = itemKv(item).map(swap);
      plan.kvFallback = { from: 'bf16', to: 'f16', at: step.ctx };
      note(j, r.reason); save();
      return;
    }
    // #1058: whether every bf16 failure so far was the engine dying without a word.
    if (kind === 'probe' && step.kv === 'bf16') plan.bf16Silent = (plan.bf16Silent ?? true) && r.silent === true;
    Object.assign(row, { status: r.outcome === 'passed' ? 'passed' : 'failed', ...(r.reason ? { reason: r.reason } : {}),
      ...(r.promptSeconds != null ? { promptSeconds: r.promptSeconds } : {}), finishedAt: now() });
    plan.results.push({ step: kind, ctx: step.ctx, kv: step.kv, outcome: r.outcome }); save();
  }
  // Drives one model through the planner. True when the model finished; false when it fell back
  // to the standard order (nothing measured yet). Each planner reply is one step; its result is
  // kept on the item, so a resumed job continues where it stopped.
  async function runPlanned(j, item, release) {
    const plan = item.plan;
    if (!plan.request) {
      await unloadAll();
      const request = await planRequest(item.model, itemKv(item)).catch(() => ({ fallback: 'its model file could not be read' }));
      if (request.fallback) return fallBack(j, item, request.fallback);
      plan.request = request; save();
    }
    try { return await planSteps(j, item, release); } catch (e) {
      // A stop between steps (the planner's verdict, its failure) still puts back what an open
      // stage changed; stages that failed inside inStage have already restored themselves.
      let restored = true;
      for (const p of item.phases) if (p._beforeText != null) {
        restored = await restorePhase(j, p) && restored;
        p.status = cancelled || e.cancelled ? 'interrupted' : 'failed'; p.reason = e.message; p.finishedAt = now();
      }
      save();
      if (!restored && !e.unsafe) throw Object.assign(Error(e.message + ' Settings changed or restoration failed; inspect models.ini before resuming.'), { unsafe: true });
      throw e;
    }
  }
  async function planSteps(j, item, release) {
    const plan = item.plan;
    let final = null;
    for (let n = 0; n < PLAN_STEP_LIMIT; n++) {
      check();
      let step;
      try { step = planner.plan({ ...plan.request, results: plan.results }); }
      catch {
        if (!plan.results.length) return fallBack(j, item, 'the planner is unavailable');
        throw Object.assign(publicFail('The auto-tune planner is unavailable.'), { fatal: true });
      }
      // #1058: about to leave bf16 after it only ever died silently, never at the smallest rung:
      // one bf16 probe there first, where memory is no excuse; dying there brings in f16.
      const kvs = plan.request.kv, smallest = plan.request.ladder[0];
      if ((step.step === 'probe' || step.step === 'fail') && step.kv !== 'bf16' && kvs.includes('bf16') && !kvs.includes('f16') && plan.bf16Silent === true
          && !plan.results.some(r => r.step === 'probe' && r.kv === 'bf16' && (r.ctx === smallest || r.outcome === 'passed'))) {
        try {
          const probeAt = planner.plan({ ...plan.request, ladder: [smallest], kv: ['bf16'], results: [] });
          if (probeAt.step === 'probe' && probeAt.kv === 'bf16' && probeAt.ctx === smallest) step = probeAt;
        } catch { /* the planner's own step stands */ }
      }
      if (step.step === 'fail') {
        if (step.code === 'unsizeable' && !plan.results.length) return fallBack(j, item, "its KV cache cannot be sized from the model's metadata");
        throw publicFail(step.message);
      }
      const context = phaseOf(item, 'context');
      if (step.step === 'probe') {
        release.setReason('Chat is paused while noevia tunes ' + item.model + ': context and KV cache.');
        await inStage(j, context, async () => {
          if (!plan.before) { plan.before = keysOf(presets.get(j.model).options); save(); }
          await ensureBaseline(j, presets.get(j.model).options, { sized: baselineSize(plan) });
          await measureFill(j, item, context, step, 'probe');
        });
        continue;
      }
      if (context.status !== 'passed') {
        // The search is over: write the chosen context and KV cache type, drafting as it was.
        await inStage(j, context, async () => {
          const spec = Object.fromEntries(Object.keys(SPEC_OFF).map(k => [k, plan.before?.[k] || '']));
          await write(j, { 'ctx-size': String(step.ctx), 'cache-type-k': step.kv, 'cache-type-v': step.kv, ...spec });
        });
        closeStage(j, context, { context: step.ctx, kv: step.kv, probes: plan.results.filter(r => r.step === 'probe').length });
        note(j, 'Chose context ' + step.ctx + ' with ' + step.kv + ' KV cache after the fill-and-recall test.');
      }
      if (step.step === 'phase') {
        const p = phaseOf(item, step.id);
        release.setReason('Chat is paused while noevia tunes ' + item.model + ': ' + p.label.toLowerCase() + '.');
        await runPhase(j, item, p);
        plan.results.push({ step: 'phase', id: step.id, outcome: p.value?.failed ? 'failed' : p.value?.skipped ? 'skipped' : 'passed' }); save();
        continue;
      }
      const verify = phaseOf(item, 'verify');
      if (step.step === 'verify') {
        release.setReason('Chat is paused while noevia tunes ' + item.model + ': final fill check.');
        await inStage(j, verify, () => measureFill(j, item, verify, step, 'verify'));
        continue;
      }
      if (verify.status !== 'passed') closeStage(j, verify, { context: step.ctx });
      if (presets.snapshot().revision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
      if (!final) {
        j.phase = 'Verifying saved profile'; save();
        await unloadAll(); await load(j);
        final = await validate(item.model);
        check();
      }
      if (step.step === 'serving') {
        j.phase = 'Checking a realistic chat request'; save();
        plan.serving = await servingCheck(j, item.model);
        plan.results.push({ step: 'serving', outcome: plan.serving ? 'passed' : 'skipped' }); save();
        continue;
      }
      final.serving = plan.serving || null;
      await finishModel(j, item, final, { kv: step.kv, ctx: step.ctx });
      return true;
    }
    throw publicFail('Auto-tune did not finish within its step limit.');
  }
  /** #1079: makes sure `item.model` (`<base>-long`) is a section the router serves for the same
   *  file as `item.base`, adding it once from the base section (Rust's long-profile decides the
   *  text) through the usual writer and backup rules, then the router re-reads models.ini. A file
   *  changed outside auto-tune, a refusal or a router that does not pick it up stops the job; a
   *  section added here that the router did not pick up is taken out again. */
  async function ensureLongSection(j, item) {
    check();
    if (presets.snapshot().revision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
    const before = await routerPairs();
    if (presets.get(item.model).exists) {
      if (!before.pairs.some(p => p.base === item.base && p.long === item.model)) throw Object.assign(publicFail(longClash(item)), { fatal: true });
      return;
    }
    const row = before.rows.find(r => r.id === item.base);
    if (!row) throw Object.assign(publicFail('A queued model is no longer configured.'), { fatal: true });
    await unloadAll();
    const snap = presets.snapshot();
    if (snap.revision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
    const made = longProfiles.sectionFor(snap.text, row, presets);
    if (!made.ok) throw Object.assign(publicFail(longRefusal(made.reason)), { fatal: true });
    if (made.id !== item.model) throw Object.assign(publicFail(longRefusal('unavailable')), { fatal: true });
    await presets.commit({ baseRevision: snap.revision, text: made.text }, writeOptions(j));
    wrote(j);
    j._revision = presets.snapshot().revision; item.sectionCreated = true; save();
    let served = false;
    try {
      const r = await (routerReload ? routerReload() : request('/models?reload=1', {}, 120000));
      served = !!r?.ok && (await routerPairs()).pairs.some(p => p.base === item.base && p.long === item.model);
    } catch { served = false; }
    if (!served) {
      // Put the file back as it was, unless it moved on since (then it is left for the operator).
      try {
        if (presets.snapshot().revision === j._revision) {
          await presets.commit({ baseRevision: j._revision, text: snap.text }, { backup: false });
          j._revision = presets.snapshot().revision; item.sectionCreated = false; save();
          await (routerReload ? routerReload() : request('/models?reload=1', {}, 120000)).catch(() => null);
        }
      } catch { /* reported below */ }
      throw Object.assign(publicFail('The model server did not pick up the long-context profile ' + item.model + '. models.ini was put back; check the model server, then try again.'), { fatal: true });
    }
    note(j, 'Added the long-context profile ' + item.model + ' to models.ini, copied from ' + item.base + "'s settings. This tune changes only that profile.");
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
          // #1079: a Long tune's `<model>-long` section is added now, with chat paused and every
          // model unloaded; every later write of this item goes to that section only.
          if (item.mode === 'long') await ensureLongSection(j, item);
          const identity = await identityFor(item.model);
          if (!identity) throw Object.assign(Error('Model identity could not be read.'), { fatal: true });
          const stableIdentity = hash({ ...identity, profile: undefined });
          if (item._identity && item._identity !== stableIdentity) throw Object.assign(Error('Model identity changed since tuning began.'), { fatal: true });
          item._identity = stableIdentity;
          if (presets.snapshot().revision !== j._revision) throw Object.assign(Error('Settings changed outside auto-tune.'), { fatal: true });
          // #1003: a planned item runs Rust's order; it falls back here when it cannot be planned.
          if (!(item.plan && await runPlanned(j, item, release))) {
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
            j.phase = 'Checking a realistic chat request'; save();
            final.serving = await servingCheck(j, item.model);
            check();
            await finishModel(j, item, final);
          }
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
      j.status = cancelled || e.cancelled ? 'cancelled' : e.idleTimeout || e.foreignTimeout ? 'interrupted' : 'failed';
      j.phase = j.status === 'cancelled' ? 'Cancelled' : j.status === 'interrupted' ? 'Waiting timed out' : 'Failed';
      j.error = e.message;
      if (e.unsafe) j._unsafe = true;
      const item = j.models?.find(m => m.model === j.model && m.status === 'running');
      if (item) { item.status = j.status === 'cancelled' ? 'interrupted' : 'failed'; item.error = e.message; }
    } finally {
      j.finishedAt = now(); j.waiting = false; child = null; idleAbort = null; save();
    }
  }
  async function start(model, { confirmPause, promptBudgetSeconds, untuned: bulk = false, mode = 'fast' } = {}) {
    if (confirmPause !== true) return { ok: false, status: 400, body: { error: 'Confirm that chat can pause and other model-server clients are stopped.' } };
    // #1079: Fast (the model's own section, today's limit) or Long (its `<model>-long` section).
    if (typeof mode !== 'string' || !Object.hasOwn(MODES, mode)) return { ok: false, status: 400, body: { error: 'Choose Fast or Long.' } };
    if (mode === 'long' && bulk) return { ok: false, status: 400, body: { error: 'A Long tune runs for one model at a time. Choose a model.' } };
    promptBudgetSeconds = Number(promptBudgetSeconds ?? MODES[mode].defaultSeconds);
    if (!Number.isInteger(promptBudgetSeconds) || promptBudgetSeconds < 15 || promptBudgetSeconds > 1800)
      return { ok: false, status: 400, body: { error: 'Choose a prompt time limit between 15 and 1800 seconds.' } };
    if (starting || state.job?.status === 'running') return { ok: false, status: 409, body: { error: 'Auto-tune is already running.' } };
    if (!bulk && isSystemModel(model)) return { ok: false, status: 400, body: { error: SYSTEM_MODEL_REASON } };
    starting = true;
    try {
      await flushReload();
      const scan = await candidates();
      // #1079: a long profile is never tuned on its own; its model is, in Long mode.
      const asLong = !bulk && scan.skipped.find(s => s.model === model && s.reason === LONG_PROFILE_REASON);
      if (asLong) return { ok: false, status: 400, body: { error: 'This is a long-context profile. Open its model and run a Long tune there.' } };
      const models = bulk ? scan.models : [model];
      if (!bulk && ![...scan.models, ...scan.skipped.filter(s => s.reason === 'Current tune already applied').map(s => s.model)].includes(model))
        return { ok: false, status: 400, body: { error: 'Choose a configured chat model.' } };
      if (!models.length) return { ok: false, status: 409, body: { error: 'All configured chat models already have current tunes.' } };
      let items = models.map(m => newModel(m, planner.mode() === 'wasm', candidatesFor(m)));
      if (mode === 'long') {
        // The model's own KV switch applies to its long profile; the section is added in run().
        const longId = model + LONG_SUFFIX, { pairs } = await routerPairs();
        if (presets.get(longId).exists && !pairs.some(p => p.base === model && p.long === longId))
          return { ok: false, status: 409, body: { error: longClash({ model: longId }) } };
        if (!presets.get(longId).exists) {
          const row = (await rawModels()).body?.data?.find(r => r.id === model);
          const dry = row ? longProfiles.sectionFor(presets.snapshot().text, row, presets) : { ok: false, reason: 'no_base' };
          if (!dry.ok) return { ok: false, status: 409, body: { error: longRefusal(dry.reason) } };
        }
        items = [{ ...newModel(longId, planner.mode() === 'wasm', candidatesFor(model)), base: model, mode: 'long' }];
      }
      cancelled = false;
      const j = { id: crypto.randomUUID(), model: items[0].model, bulk, mode, promptBudgetSeconds, status: 'running',
        phase: 'Preparing', startedAt: now(), log: [], models: items, _revision: presets.snapshot().revision,
        queueProgress: { done: 0, total: items.length } };
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
    if (j?._reloadPending) scheduleReload(j);
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
      await flushReload();
      for (const item of j.models.filter(m => m.status !== 'passed')) {
        // #1079: a Long item stopped before its section was added is checked by its model.
        const id = item.mode === 'long' && !presets.get(item.model).exists ? item.base : item.model;
        if (!id || !rows.body.data.some(row => row.id === id) || !presets.get(id).exists) throw publicFail('A queued model is no longer configured.');
        const identity = await identityFor(id);
        if (!identity) throw publicFail('A queued model identity could not be read.');
        if (item._identity && item._identity !== hash({ ...identity, profile: undefined })) throw publicFail('A queued model changed since tuning began.');
      }
      cancelled = false; j.status = 'running'; j.error = undefined; j.finishedAt = undefined;
      for (const item of j.models) if (item.status !== 'passed') {
        item.status = 'pending'; delete item.error; delete item._foreignYields;
        for (const p of item.phases) if (p.status !== 'passed') {
          p.status = 'pending'; delete p.reason; delete p.restored;
          // Planned stages (#1003) keep the rows the planner has results for; the rest re-run.
          p.steps = item.plan && ['context', 'verify'].includes(p.id) ? p.steps.filter(s => ['passed', 'failed'].includes(s.status))
            : p.steps.map(s => ({ ...s, status: 'pending', reason: undefined }));
        }
      }
      save(); completion = run(j); completion.catch(() => {});
      return { ok: true, status: 202, body: publicJob(j) };
    } catch (e) { return { ok: false, status: 409, body: { error: clientMessage(e, 'Auto-tune could not resume.') } }; }
    finally { starting = false; }
  }
  return { start, resume, cancel, status, setSettings, untuned, recover, flushReload, completion: () => completion };
}
module.exports = { createFullAutotuner, qualityCheck, qualityFailure, QUALITY, VERSION, newModel, hasHarmonyReasoning, kvCandidates, preferKv, bf16Unsupported, MODES, LONG_PROFILE_REASON };
