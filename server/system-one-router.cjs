'use strict';
const { parseServiceUrl, serviceFetch } = require('./service-endpoint.cjs');
const { createDecisions, CAUSE_RE } = require('./decision/index.cjs');
const { llamaLogitBackend } = require('./decision/backends.cjs');
const { DECISION_SERVICE_REPORTED_MODEL } = require('./decision-models.cjs');
const { STANDARD, TUNED, normalizeWording } = require('./decision-wording.cjs');

// Operator configuration only. No browser-supplied endpoint, model loading or downloads.
// A dedicated private endpoint avoids silently changing the loaded answering model.
function configuration(env = process.env) {
  const reason = 'Not configured. The operator needs to point it at a dedicated local decision-model endpoint, then restart noevia.';
  // #1755: the shared on-this-network rule (service-endpoint.cjs); names are checked when the request connects.
  const parsed = parseServiceUrl(env.COWORK_SYSTEM_ONE_URL, { paths: ['/', '/v1', '/v1/'] });
  return parsed.reason ? { reason } : { baseUrl: parsed.baseUrl, reason: null };
}

// #1639 soak / #1873: route labels per decision-model wording (decision-models.cjs). The standard wording keeps the labels it was
// measured with (docs/research/system-one/19-routing-labels.md). With them, the tuned model sent short creative asks (a 4-line poem,
// a limerick, a short story) to Smart, because "writing more than a sentence" names them, and Smart then ran at the
// account-default High effort. The tuned labels name simple short tasks as Fast (synthetic set, 2026-10-16: simple 12/16 ->
// 14/16 Fast, reasoning 7/8 -> 8/8 Smart).
const ROUTE_LABELS = Object.freeze({
  [STANDARD]: Object.freeze({ fast: 'Greetings, thanks, or a one-line factual answer',
    smart: 'Explaining, comparing, planning, reasoning or writing more than a sentence' }),
  [TUNED]: Object.freeze({ fast: 'Small talk, a quick fact, or a simple short task: counting, lists, a joke, a short poem or a short story',
    smart: 'Explaining, comparing, planning, multi-step reasoning or maths, or long careful writing' }),
});
// A cheap pre-check before the decision call: a short single-line ask for a plainly simple task (count, list, spell,
// a joke, a haiku/limerick/short poem, a short story of at most 400 words) goes Fast with no decision call at all.
// Conservative: anything that also asks to explain, compare, plan, reason or touch code is left to the model.
const SIMPLE_TASK_RE = /^\s*(please\s+)?(can you\s+|could you\s+)?(count\b|list\b|spell\b|tell me (a|another) (short )?joke\b|(write|give me|make|compose) (me )?(a|an|another)\s+(short\s+|quick\s+|funny\s+|little\s+|tiny\s+|\d{1,2}[- ]line\s+|\d{2,3}[- ]word\s+)*(poem|haiku|limerick|rhyme|joke|story|riddle)\b)/i;
const NOT_SIMPLE_RE = /\b(explain|why|how|compare|plan|analy[sz]e|reason|prove|derive|step[- ]by[- ]step|in detail|detailed|essay|code|function|script|program|regex|sql|debug|bug)\b|```/i;
function clearlySimple(message) {
  const m = String(message || '');
  if (!m.trim() || m.length > 160 || /\n/.test(m.trim()) || !SIMPLE_TASK_RE.test(m) || NOT_SIMPLE_RE.test(m)) return false;
  const words = m.match(/\b(\d{2,5})[- ]words?\b/i);
  return !words || Number(words[1]) <= 400;
}

function createSystemOneRouter({ enabled, roles, fallback, env = process.env, backend, getBackend = null, getDeadlineMs = null, deadlineMs = 1500, precheck = true,
  log = (entry) => console.info('[system-one] route', JSON.stringify(entry)) }) {
  const config = configuration(env);
  const candidate = backend || (config.baseUrl ? llamaLogitBackend({ baseUrl: config.baseUrl,
    fetchImpl: (url, init) => serviceFetch(url, { ...init, redirect: 'error' }) }) : null);
  let lastCandidate, decisions;
  function currentDecisions() {
    const current=getBackend ? (getBackend() || candidate) : candidate;
    if(!current) return null;
    if(current!==lastCandidate) { lastCandidate=current; decisions=createDecisions({backends:{configured:current},chains:{'model.route':['configured']}}); }
    return { decisions, backend: current };
  }
  async function classifyWithDetails(message) {
    const active = roles();
    const routing = enabled() ? currentDecisions() : null;
    // A backend that still says 'laya' or 'kev' gets the same labels as before (decision-wording.cjs).
    const labels = ROUTE_LABELS[normalizeWording(routing?.backend?.wording) || STANDARD];
    const options = [{ id: 'fast', label: labels.fast }, { id: 'smart', label: labels.smart }];
    if (active?.code) options.push({ id: 'code', label: 'Anything involving programming code, regex, errors or software' });
    const offered = active?.fast && active?.smart ? options : [];
    if (!routing || !offered.length) {
      const role = await fallback(message);
      return { role, routingDecision: { offered, scores: {}, selectedRole: null, effectiveRole: role,
        backend: 'legacy', model: null, calibrated: false, latencyMs: null, status: 'fallback',
        fallbackReason: !enabled() ? 'disabled' : !routing ? 'no-backend' : 'missing-roles', fallbackCause: null } };
    }
    if (precheck && clearlySimple(message)) {
      log({ selected: 'fast', options: options.length, margin: null, ms: 0, fellBack: null, cause: null, precheck: true });
      return { role: 'fast', routingDecision: { offered, scores: {}, selectedRole: 'fast', effectiveRole: 'fast',
        backend: 'legacy', model: null, calibrated: false, latencyMs: 0, status: 'accepted', fallbackReason: null, fallbackCause: null } };
    }
    const result = await routing.decisions.decide({ kind: 'choice', purpose: 'model.route',
      question: 'Which configured model role should answer this user message?',
      context: { cloud: 'forbidden', stateText: String(message).slice(0, 1000) }, options,
      constraints: { deadlineMs: getDeadlineMs ? getDeadlineMs() : deadlineMs }, fallback: { selected: null, scores: {} } });
    const accepted = result.source !== 'fallback' && options.some(o => o.id === result.selected);
    const scores = accepted ? Object.fromEntries(options.filter(o => Number.isFinite(result.scores?.[o.id]))
      .map(o => [o.id, result.scores[o.id]])) : {};
    const ranked = Object.values(scores).sort((a, b) => b - a);
    // #682/#1070: the text-free cause behind a fallback (deadline, http-503, invalid-result, ...).
    const cause = accepted ? null : (typeof result.metadata?.cause === 'string' && CAUSE_RE.test(result.metadata.cause) ? result.metadata.cause : null);
    log({ selected: accepted ? result.selected : 'legacy', options: options.length,
      margin: ranked.length > 1 ? Math.round((ranked[0] - ranked[1]) * 1000) / 1000 : null,
      ms: result.metadata?.latencyMs ?? null, fellBack: accepted ? null : (result.metadata?.fellBack || 'rejected'),
      cause });
    const role = accepted ? result.selected : await fallback(message);
    const fallbackReason = accepted ? null : (['deadline', 'no-backend-answered', 'low-confidence'].includes(result.metadata?.fellBack)
      ? result.metadata.fellBack : 'rejected');
    return { role, routingDecision: { offered, scores, selectedRole: accepted ? result.selected : null,
      effectiveRole: role, backend: accepted ? (routing.backend.id === 'llama-logit' ? 'llama-logit' : 'decision-service') : 'legacy',
      model: accepted && result.metadata?.model === DECISION_SERVICE_REPORTED_MODEL ? DECISION_SERVICE_REPORTED_MODEL : null,
      calibrated: false, latencyMs: Number.isFinite(result.metadata?.latencyMs) ? result.metadata.latencyMs : null,
      // The badge states the real reason (#1070): e.g. http-503 is Laya missing its own deadline.
      status: accepted ? 'accepted' : 'fallback', fallbackReason, fallbackCause: cause } };
  }
  return {
    classifyWithDetails,
    async classify(message) { return (await classifyWithDetails(message)).role; },
  };
}
module.exports = { configuration, createSystemOneRouter, clearlySimple, ROUTE_LABELS };
