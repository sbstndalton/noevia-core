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

function createSystemOneRouter({ enabled, roles, fallback, env = process.env, backend, getBackend = null, getDeadlineMs = null, deadlineMs = 1500 }) {
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
      const options = [{ id: 'fast', label: 'Short simple questions and small talk' },
        { id: 'smart', label: 'Complex reasoning, analysis and multi-step work' }];
      if (active.code) options.push({ id: 'code', label: 'Writing, reading, debugging or explaining source code' });
      const result = await decisions.decide({ kind: 'choice', purpose: 'model.route',
        question: 'Which configured model role should answer this user message?',
        context: { cloud: 'forbidden', stateText: String(message).slice(0, 1000) }, options,
        constraints: { deadlineMs: getDeadlineMs ? getDeadlineMs() : deadlineMs }, fallback: { selected: null, scores: {} } });
      // No async legacy call inside decide's synchronous fallback contract. Preserve the
      // existing classifier exactly, including its heuristics, on every rejected readout.
      return result.source !== 'fallback' && options.some(o => o.id === result.selected)
        ? result.selected : fallback(message);
    },
  };
}
module.exports = { configuration, createSystemOneRouter };
