'use strict';
// #1004 LAYA_LOAD_ADVISOR=on (default off): the decision service (Laya) as an advisor inside
// auto-tune's script, never its driver. When a fill-and-recall step fails for a reason the
// calibrator only guessed (a refused load, a failed router row, a stream error, an engine that
// went away), Rust's load-verdict (dav-parse.wasm load_verdict) names the outcome from the
// engine's evidence with fixed rules. Only when no rule matches and there is engine text does
// this ask the decision service which of the planner's outcomes the text describes; the verdict
// uses that label only at a confidence of at least 0.6, and records the rule, the advice and who
// decided either way. The planner (autotune-plan) still picks every step from the outcome.
//
// The decision service is the private one already configured for chat (COWORK_DECISION_URL,
// decision-endpoint.cjs). Its options never include a time out (#1046): that outcome re-runs the
// same setting, so only a rule may name it. One question at a time (Laya runs with LAYA_MAX_CONCURRENCY=1; a
// second question while one is open is not asked), within ADVICE_BUDGET_MS. A timeout, an error,
// an unconfigured service or an unusable module all mean "no advice": the calibrator's own cause
// stands, which is what auto-tune did before. Nothing here loads, unloads or runs a model.
const FLAG = 'LAYA_LOAD_ADVISOR';
const ADVICE_BUDGET_MS = 2000;
// The engine's text goes to the decision service and the verdict as a short excerpt.
const EXCERPT_UNITS = 2048;
const CAUSES = new Set(['oom', 'load', 'timeout', 'time', 'recall']);
const QUESTION = 'A local model server failed while loading or serving a model during automatic tuning. Which of these does its error text describe?';
const OPTIONS = [
  { id: 'oom', label: 'Out of memory: memory for the model, its cache or its buffers could not be allocated' },
  { id: 'load_failed', label: 'The model file or its format could not be loaded' },
  { id: 'recall_failed', label: 'The prompt did not fit the context size the model was started with' },
  { id: 'template', label: "The model's chat template could not be parsed or applied" },
  { id: 'unknown', label: 'None of these, or the text does not say' },
];

const enabled = (env = process.env) => String(env[FLAG] ?? '').trim().toLowerCase() === 'on';

// Printable, bounded and well-formed: control characters (other than line breaks and tabs) become
// spaces, then the first EXCERPT_UNITS UTF-16 units are kept.
function excerpt(text) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ').slice(0, EXCERPT_UNITS);
  return flat.isWellFormed() ? flat : flat.toWellFormed();
}

const int = (v, min, max) => (Number.isSafeInteger(v) && v >= min && v <= max ? v : null);
function evidenceOf(e) {
  if (!e || typeof e !== 'object') return null;
  return { status: int(e.status, 0, 999), exitCode: int(e.exitCode, -1024, 1024), text: excerpt(e.text), crash: e.crash === true };
}

function defaultEndpoint(env) {
  try { return require('./decision-endpoint.cjs').createDecisionEndpoint({ env }); } catch { return null; }
}

function createLoadAdvisor({ env = process.env, endpoint = undefined, verdict = request => require('./dav-parse-wasm.cjs').loadVerdict(request),
  budgetMs = ADVICE_BUDGET_MS, log = (...a) => console.warn('[autotune]', ...a) } = {}) {
  let open = false;
  const service = () => (endpoint === undefined ? defaultEndpoint(env) : endpoint);
  // The decision service's label and confidence, or why there is none.
  async function ask(text) {
    const svc = service();
    if (!svc) return { status: 'unavailable' };
    if (open) return { status: 'busy' };
    open = true;
    const controller = new AbortController();
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: 'timeout' }); }, budgetMs); });
    try {
      // A synchronous throw from the client is an error too, never an escape from judge (#1048).
      const answer = Promise.resolve().then(() => svc.choice({ state: JSON.stringify({ engineError: text }), question: QUESTION, options: OPTIONS }, { signal: controller.signal }))
        .then(r => (OPTIONS.some(o => o.id === r?.selected) && Number.isFinite(r.scores?.[r.selected])
          ? { status: 'answered', advice: { label: r.selected, confidence: Math.min(1, Math.max(0, r.scores[r.selected])) } }
          : { status: 'error' }))
        .catch(e => ({ status: controller.signal.aborted ? 'timeout' : 'error', cause: e?.reason }));
      return await Promise.race([answer, deadline]);
    } finally { clearTimeout(timer); open = false; }
  }
  return {
    enabled: () => enabled(env),
    /** The outcome for a failed step, and what decided it; null when the verdict is unavailable
     *  (the caller keeps its own outcome). Never throws. */
    async judge({ cause, evidence }) {
      const request = { cause: CAUSES.has(cause) ? cause : 'load', evidence: evidenceOf(evidence) };
      let v;
      try { v = verdict(request); } catch (e) { log('load verdict unavailable:', e?.reason || 'unexpected'); return null; }
      let advisor = 'not_asked';
      if (v.ask) {
        const a = await ask(request.evidence.text);
        advisor = a.status;
        if (a.advice) {
          try { v = verdict({ ...request, advice: a.advice }); advisor = v.adviceUsed ? 'used' : 'ignored'; }
          catch (e) { log('load verdict unavailable:', e?.reason || 'unexpected'); advisor = 'error'; }
        }
      }
      return { outcome: v.outcome, reason: v.reason,
        classification: { source: v.source, rule: v.rule, ruleId: v.ruleId, advice: v.advice, adviceUsed: v.adviceUsed, advisor } };
    },
  };
}

module.exports = { createLoadAdvisor, enabled, excerpt, FLAG, ADVICE_BUDGET_MS, EXCERPT_UNITS, OPTIONS, QUESTION };
