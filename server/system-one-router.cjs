'use strict';
const { isIP } = require('node:net');
const { createDecisions } = require('./decision/index.cjs');
const { llamaLogitBackend } = require('./decision/backends.cjs');

// Operator configuration only. No browser-supplied endpoint, model loading or downloads.
// A dedicated private endpoint avoids silently changing the loaded answering model.
function configuration(env = process.env) {
  const reason = 'Not configured. Set COWORK_SYSTEM_ONE_URL to a dedicated local llama.cpp decision-model endpoint, then restart the app.';
  try {
    const url = new URL(env.COWORK_SYSTEM_ONE_URL);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const privateHost = host === 'localhost' || host === '::1' || (isIP(host) === 4 &&
      (/^(127|10)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)));
    if (!privateHost || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['/', '/v1', '/v1/'].includes(url.pathname)) return { reason };
    return { baseUrl: url.origin, reason: null };
  } catch { return { reason }; }
}

function createSystemOneRouter({ enabled, roles, fallback, env = process.env, backend, getBackend = null, getDeadlineMs = null, deadlineMs = 1500,
  log = (entry) => console.info('[system-one] route', JSON.stringify(entry)) }) {
  const config = configuration(env);
  const candidate = backend || (config.baseUrl ? llamaLogitBackend({ baseUrl: config.baseUrl,
    fetchImpl: (url, init) => fetch(url, { ...init, redirect: 'error' }) }) : null);
  let lastCandidate, decisions;
  function currentDecisions() {
    const current=getBackend ? (getBackend() || candidate) : candidate;
    if(!current) return null;
    if(current!==lastCandidate) { lastCandidate=current; decisions=createDecisions({backends:{configured:current},chains:{'model.route':['configured']}}); }
    return { decisions, backend: current };
  }
  async function classifyWithDetails(message) {
    const active = roles();
    const options = [{ id: 'fast', label: 'Greetings, thanks, or a one-line factual answer' },
      { id: 'smart', label: 'Explaining, comparing, planning, reasoning or writing more than a sentence' }];
    if (active?.code) options.push({ id: 'code', label: 'Anything involving programming code, regex, errors or software' });
    const offered = active?.fast && active?.smart ? options : [];
    const routing = enabled() ? currentDecisions() : null;
    if (!routing || !offered.length) {
      const role = await fallback(message);
      return { role, routingDecision: { offered, scores: {}, selectedRole: null, effectiveRole: role,
        backend: 'legacy', model: null, calibrated: false, latencyMs: null, status: 'fallback',
        fallbackReason: !enabled() ? 'disabled' : !routing ? 'no-backend' : 'missing-roles' } };
    }
    const result = await routing.decisions.decide({ kind: 'choice', purpose: 'model.route',
      question: 'Which configured model role should answer this user message?',
      context: { cloud: 'forbidden', stateText: String(message).slice(0, 1000) }, options,
      constraints: { deadlineMs: getDeadlineMs ? getDeadlineMs() : deadlineMs }, fallback: { selected: null, scores: {} } });
    const accepted = result.source !== 'fallback' && options.some(o => o.id === result.selected);
    const scores = accepted ? Object.fromEntries(options.filter(o => Number.isFinite(result.scores?.[o.id]))
      .map(o => [o.id, result.scores[o.id]])) : {};
    const ranked = Object.values(scores).sort((a, b) => b - a);
    log({ selected: accepted ? result.selected : 'legacy', options: options.length,
      margin: ranked.length > 1 ? Math.round((ranked[0] - ranked[1]) * 1000) / 1000 : null,
      ms: result.metadata?.latencyMs ?? null, fellBack: accepted ? null : (result.metadata?.fellBack || 'rejected') });
    const role = accepted ? result.selected : await fallback(message);
    const fallbackReason = accepted ? null : (['deadline', 'no-backend-answered', 'low-confidence'].includes(result.metadata?.fellBack)
      ? result.metadata.fellBack : 'rejected');
    return { role, routingDecision: { offered, scores, selectedRole: accepted ? result.selected : null,
      effectiveRole: role, backend: accepted ? (routing.backend.id === 'llama-logit' ? 'llama-logit' : 'decision-service') : 'legacy',
      model: accepted && result.metadata?.model === 'convaiinnovations/laya' ? 'convaiinnovations/laya' : null,
      calibrated: false, latencyMs: Number.isFinite(result.metadata?.latencyMs) ? result.metadata.latencyMs : null,
      status: accepted ? 'accepted' : 'fallback', fallbackReason } };
  }
  return {
    classifyWithDetails,
    async classify(message) { return (await classifyWithDetails(message)).role; },
  };
}
module.exports = { configuration, createSystemOneRouter };
