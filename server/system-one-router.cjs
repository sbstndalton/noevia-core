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
    return decisions;
  }
  return {
    async classify(message) {
      if (!enabled()) return fallback(message);
      const decisions=currentDecisions();
      if (!decisions) return fallback(message);
      const active = roles();
      if (!active?.fast || !active?.smart) return fallback(message);
      // Labels measured on Laya 2026-09-22 (docs/research/system-one/19-routing-labels.md): the
      // earlier abstract wording sent most reasoning and code messages to Fast (23/40 held out);
      // concrete examples of each role scored 36/40.
      const options = [{ id: 'fast', label: 'Greetings, thanks, or a one-line factual answer' },
        { id: 'smart', label: 'Explaining, comparing, planning, reasoning or writing more than a sentence' }];
      if (active.code) options.push({ id: 'code', label: 'Anything involving programming code, regex, errors or software' });
      const result = await decisions.decide({ kind: 'choice', purpose: 'model.route',
        question: 'Which configured model role should answer this user message?',
        context: { cloud: 'forbidden', stateText: String(message).slice(0, 1000) }, options,
        constraints: { deadlineMs: getDeadlineMs ? getDeadlineMs() : deadlineMs }, fallback: { selected: null, scores: {} } });
      // No async legacy call inside decide's synchronous fallback contract. Preserve the
      // existing classifier exactly, including its heuristics, on every rejected readout.
      const accepted = result.source !== 'fallback' && options.some(o => o.id === result.selected);
      // One text-free line per decision, so live margins and fallback rates can be read from the
      // web log before anything else is tuned. Never the message, never scores of other tenants.
      const scores = Object.values(result.scores || {}).sort((a, b) => b - a);
      log({ selected: accepted ? result.selected : 'legacy', options: options.length,
        margin: scores.length > 1 ? Math.round((scores[0] - scores[1]) * 1000) / 1000 : null,
        ms: result.metadata?.latencyMs ?? null, fellBack: accepted ? null : (result.metadata?.fellBack || 'rejected') });
      return accepted ? result.selected : fallback(message);
    },
  };
}
module.exports = { configuration, createSystemOneRouter };
