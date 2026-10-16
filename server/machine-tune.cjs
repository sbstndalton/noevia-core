'use strict';
// #1880: an administrator-started measurement of a chat role's model on an Inference machine (follow-up to #1854).
//
// noevia cannot relaunch a llama-server on another machine with new flags, so "tune" there means MEASURING what the
// machine's current configuration gives and recommending a configuration the owner applies on that machine. Nothing
// on this machine changes: no load, no unload, no inference memory budget, no models.ini, no local evidence.
//
// The same safety rules as the local auto-tune (llamacpp-full-autotune.cjs), applied to a server noevia does not run:
//  - scripted, step by step, in a fixed order (STEPS below); never an AI choosing what to try;
//  - fixed, small, synthetic prompts (the local tune's WORKLOADS and its filler sentence), each with a hard time cap
//    (STEP_TIMEOUT_MS) and the whole run with one (RUN_TIMEOUT_MS);
//  - administrator-started only (routes/inference-machines.cjs: admin, `confirm: true`), never automatic;
//  - one run at a time across all machines, and never while that machine serves a chat turn: it does not start when
//    chatMachines.busy(machine) and stops (state 'interrupted') the moment a turn starts there (chatMachines.onTurn);
//  - an abort that stops the request in flight;
//  - every request through the role's on-this-network fetch (chatMachines.fetch: serviceFetch, link-local refused,
//    redirects never followed) with no Authorization header: no local key reaches another host.
//
// What is measured, all from the running server:
//  - `props`: the context it runs the model with (/props n_ctx);
//  - `decode:<workload>`: generation speed on the three local-tune workloads (llama-server `timings.predicted_per_second`,
//    else completion tokens over wall time), and speculative-decoding acceptance where the server drafts
//    (`timings.draft_n` / `draft_n_accepted`; a server without a draft model reports none, and nothing is guessed);
//  - `prefill:<tokens>`: prompt reading speed at a few context sizes up to 3/4 of its context (max_tokens 1, the prompt
//    cache off, a per-run marker so no earlier prompt is reused).
// The result is kept per machine id + model as served (the #1854 keys, never a file name) in the settings store, and
// shown on that role's measured line in Settings → Inference machines, apart from this machine's numbers.
//
// Recommendations are rules, not guesses: the context is suggested smaller only when filling it would take longer than
// the local tune's prompt time limit (120 s) at the measured rate; drafting is suggested off only when fewer than half
// of the drafted tokens were accepted. The owner applies them on the machine (llama-server flags), noevia does not.

const crypto = require('node:crypto');
const { WORKLOADS, geomean } = require('./llamacpp-tune-spec.cjs');

const STORE_KEY = 'inference:machineTune';
const MAX_RESULTS = 64;
const STEP_TIMEOUT_MS = 60000;
const RUN_TIMEOUT_MS = 8 * 60000;
const BODY_CAP = 256 * 1024;
const PREFILL_SIZES = Object.freeze([1024, 4096, 16384]);
const FILL_LIMIT_SECONDS = 120; // llamacpp-full-autotune.cjs MODES.fast.defaultSeconds
const ACCEPTANCE_FLOOR = 0.5;
// The local tune's filler sentence; about 16 tokens on the common tokenizers.
const PAD = 'The garden committee reviewed irrigation, seed orders, volunteer rotas and pump maintenance. ';
const PAD_TOKENS = 16;
const CHAT_SERVICES = Object.freeze({ chatFast: 'fast', chatSmart: 'smart', chatCode: 'code', chatCreative: 'creative', vision: 'vision' });

const fail = (status, code, message) => Object.assign(Error(message), { status, code });

async function readCapped(response, cap) {
  const reader = response.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch { /* closed */ } throw fail(502, 'tooLarge', 'The machine’s answer was too large.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const round = (v, d = 1) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** The deterministic recommendations for a finished measurement. */
function recommend({ contextTokens, prefill, speculative }) {
  const out = [];
  const largest = [...prefill].reverse().find((p) => p.tokensPerSecond > 0);
  if (contextTokens && largest) {
    const fillSeconds = contextTokens / largest.tokensPerSecond;
    if (fillSeconds > FILL_LIMIT_SECONDS) {
      const value = Math.max(2048, Math.floor((largest.tokensPerSecond * FILL_LIMIT_SECONDS) / 1024) * 1024);
      if (value < contextTokens) out.push({ key: 'contextTokens', value, flag: `--ctx-size ${value}`, reason: 'slowFill', fillSeconds: Math.round(fillSeconds) });
    }
  }
  if (speculative.measured && speculative.acceptance !== null && speculative.acceptance < ACCEPTANCE_FLOOR) {
    out.push({ key: 'speculative', value: 'off', flag: '--spec-type none', reason: 'lowAcceptance', acceptance: speculative.acceptance });
  }
  return out;
}

/**
 * @param {object} o
 * @param {object} o.machines      inference-machines.cjs (chatTarget, machine)
 * @param {object} o.chatMachines  chat-machines.cjs (ready, fetch, busy, onTurn)
 * @param {{get:(k:string)=>any, set:(k:string,v:any)=>any}} o.store  the settings store
 * @param {(action:string, actor:string, detail:object)=>void} [o.audit]
 */
function createMachineTune({ machines, chatMachines, store, audit = () => {}, now = () => Date.now(), stepTimeoutMs = STEP_TIMEOUT_MS, runTimeoutMs = RUN_TIMEOUT_MS, log = console.log } = {}) {
  let run = null; // the run in progress or the last one: its public status plus private controls
  const keyOf = (machineId, model) => `${machineId}\u0000${model}`;

  function readAll() {
    let v = null;
    try { v = store.get(STORE_KEY); } catch { v = null; }
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
    return Array.isArray(v?.results) ? v.results.filter((r) => r && typeof r.machineId === 'string' && typeof r.model === 'string') : [];
  }
  function save(result) {
    const rest = readAll().filter((r) => keyOf(r.machineId, r.model) !== keyOf(result.machineId, result.model));
    store.set(STORE_KEY, JSON.stringify({ results: [...rest, result].slice(-MAX_RESULTS) })); // the settings table holds text
  }
  /** The last finished measurement for a model as served on a machine, or null. Removed machines' results are not shown. */
  function resultFor(machineId, model) {
    if (!machines?.machine?.(machineId)) return null;
    return readAll().find((r) => r.machineId === machineId && r.model === model) || null;
  }

  const publicStatus = () => (run ? { id: run.id, service: run.service, machine: run.machine, model: run.model, state: run.state, step: run.step,
    stepIndex: run.stepIndex, steps: run.steps.length, startedAt: run.startedAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}), ...(run.code ? { code: run.code } : {}) } : null);
  const status = () => publicStatus();

  function stop(state, code) {
    if (!run || run.state !== 'running') return;
    run.state = state;
    run.code = code;
    run.controller.abort(Object.assign(Error(code), { code }));
  }

  /** Abort the run in progress (any machine). Returns the status; nothing running: the last one, unchanged. */
  function abort(actor) {
    if (run?.state === 'running') { stop('aborted', 'aborted'); try { audit('machines.tune.abort', actor, { machine: run.machine.id, model: run.model }); } catch { /* audit is best effort */ } }
    return publicStatus();
  }

  async function request(t, signal, body) {
    const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(stepTimeoutMs)]);
    const started = now();
    const r = await chatMachines.fetch(`${t.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: stepSignal });
    if (!r.ok) { try { await r.body?.cancel?.(); } catch { /* nothing */ } throw fail(502, 'machineAnswer', `HTTP ${r.status}`); }
    const json = JSON.parse(await readCapped(r, BODY_CAP));
    return { json, ms: Math.max(1, now() - started) };
  }

  async function propsOf(t, signal) {
    const r = await chatMachines.fetch(`${t.baseUrl}/props?model=${encodeURIComponent(t.model)}`, { method: 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(stepTimeoutMs)]) });
    if (!r.ok) { try { await r.body?.cancel?.(); } catch { /* nothing */ } return null; }
    const n = Number(JSON.parse(await readCapped(r, 1024 * 1024))?.default_generation_settings?.n_ctx);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  function planSteps(contextTokens) {
    const sizes = PREFILL_SIZES.filter((n) => !contextTokens || n <= Math.floor(contextTokens * 0.75));
    return ['props', ...WORKLOADS.map((w) => `decode:${w.id}`), ...(sizes.length ? sizes : [PREFILL_SIZES[0]]).map((n) => `prefill:${n}`)];
  }

  async function script(r) {
    const { target: t, controller } = r;
    const signal = controller.signal;
    const decode = [], prefill = [];
    let drafted = 0, accepted = 0;
    const enter = (name) => {
      if (signal.aborted) throw signal.reason || Error('aborted');
      // A turn that started between steps (and was not seen by onTurn) stops the run here too.
      if (chatMachines.busy(t.machine.id)) { stop('interrupted', 'chatTurn'); throw signal.reason; }
      r.step = name; r.stepIndex = r.steps.indexOf(name) + 1;
    };
    enter('props');
    const contextTokens = await propsOf(t, signal);
    r.steps = planSteps(contextTokens);
    for (const w of WORKLOADS) {
      enter(`decode:${w.id}`);
      const { json, ms } = await request(t, signal, { model: t.model, messages: [{ role: 'user', content: w.prompt }], max_tokens: w.max, temperature: 0, stream: false, cache_prompt: false });
      const tm = json?.timings || {};
      const server = num(tm.predicted_per_second);
      const n = num(json?.usage?.completion_tokens) ?? num(tm.predicted_n);
      const tps = server ?? (n ? (n * 1000) / ms : null);
      decode.push({ id: w.id, tokensPerSecond: round(tps), source: server !== null ? 'server' : 'wall' });
      if (num(tm.draft_n) && tm.draft_n > 0) { drafted += tm.draft_n; accepted += num(tm.draft_n_accepted) || 0; }
    }
    for (const step of r.steps.filter((s) => s.startsWith('prefill:'))) {
      enter(step);
      const size = Number(step.slice(8));
      const content = `Measurement ${r.id}. ${PAD.repeat(Math.ceil(size / PAD_TOKENS))}\nReply with OK.`;
      const { json, ms } = await request(t, signal, { model: t.model, messages: [{ role: 'user', content }], max_tokens: 1, temperature: 0, stream: false, cache_prompt: false });
      const tm = json?.timings || {};
      const server = num(tm.prompt_per_second);
      const tokens = num(tm.prompt_n) ?? num(json?.usage?.prompt_tokens);
      const tps = server ?? (tokens ? (tokens * 1000) / ms : null);
      prefill.push({ tokens: tokens ?? size, tokensPerSecond: round(tps), source: server !== null ? 'server' : 'wall' });
    }
    const speculative = drafted > 0 ? { measured: true, drafted, accepted, acceptance: round(accepted / drafted, 3) } : { measured: false, drafted: 0, accepted: 0, acceptance: null };
    const values = decode.map((d) => d.tokensPerSecond).filter((v) => v > 0);
    const result = {
      machineId: t.machine.id, model: t.model, measuredAt: new Date(now()).toISOString(), contextTokens,
      decode: { tokensPerSecond: values.length ? round(geomean(values)) : null, workloads: decode },
      prefill, speculative,
    };
    result.recommendations = recommend(result);
    return result;
  }

  /**
   * Start a measurement of `service`'s model on its machine. Resolves the status at once; the run continues in the
   * background. Throws a status error: 400 invalidService/confirmRequired, 404 notOnMachine, 409 tuneRunning/machineBusy,
   * 503 machineUnreachable/machineWrongModel.
   */
  async function start({ service, confirm, actor }) {
    const role = CHAT_SERVICES[String(service || '')];
    if (!role) throw fail(400, 'invalidService', 'Only a chat role or Vision on an Inference machine can be measured.');
    if (confirm !== true) throw fail(400, 'confirmRequired', 'Confirm the measurement: it sends a few short requests to that machine.');
    const t = machines?.chatTarget?.(role) || null;
    if (!t) throw fail(404, 'notOnMachine', 'That role runs on this machine; only a role on an Inference machine is measured here.');
    if (run?.state === 'running') throw fail(409, 'tuneRunning', 'A measurement is already running. Wait for it or stop it first.');
    if (chatMachines.busy(t.machine.id)) throw fail(409, 'machineBusy', `${t.machine.name} is answering a chat now. Try again when it is done.`);
    const ready = await chatMachines.ready(t);
    if (!ready.ok) throw fail(503, ready.code || 'machineUnreachable', ready.error);
    if (run?.state === 'running') throw fail(409, 'tuneRunning', 'A measurement is already running. Wait for it or stop it first.');
    if (chatMachines.busy(t.machine.id)) throw fail(409, 'machineBusy', `${t.machine.name} is answering a chat now. Try again when it is done.`);

    const controller = new AbortController();
    const r = { id: crypto.randomUUID(), service, machine: { id: t.machine.id, name: t.machine.name }, model: t.model, target: t, controller,
      state: 'running', step: null, stepIndex: 0, steps: planSteps(null), startedAt: new Date(now()).toISOString() };
    run = r;
    const unsubscribe = chatMachines.onTurn((id) => { if (run === r && id === t.machine.id) stop('interrupted', 'chatTurn'); });
    const cap = setTimeout(() => { if (run === r) stop('failed', 'runTimeout'); }, runTimeoutMs);
    cap.unref?.();
    try { audit('machines.tune.start', actor, { machine: t.machine.id, model: t.model }); } catch { /* best effort */ }
    log(`[machines] measuring ${t.model} on ${t.machine.name} (administrator-started)`);
    void script(r).then((result) => {
      if (r.state !== 'running') return;
      save(result);
      r.state = 'done';
    }, (err) => {
      if (r.state === 'running') {
        r.state = 'failed';
        r.code = err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError' ? 'stepTimeout'
          : err?.code === 'EPUBLICADDR' ? 'publicAddress' : err?.code === 'machineAnswer' ? 'machineAnswer' : 'machineUnreachable';
      }
    }).finally(() => {
      clearTimeout(cap);
      unsubscribe();
      r.finishedAt = new Date(now()).toISOString();
      r.done = true;
      log(`[machines] measurement of ${t.model} on ${t.machine.name}: ${r.state}${r.code ? ` (${r.code})` : ''}`);
    });
    return publicStatus();
  }

  /** Resolves when the current run (if any) has finished (tests). */
  async function settled(deadlineMs = 30000) {
    const until = Date.now() + deadlineMs;
    while (run && !run.done && Date.now() < until) await new Promise((res) => setTimeout(res, 10));
    return publicStatus();
  }

  return { start, abort, status, resultFor, settled };
}

module.exports = { createMachineTune, recommend, STORE_KEY, STEP_TIMEOUT_MS, RUN_TIMEOUT_MS, PREFILL_SIZES, CHAT_SERVICES };
