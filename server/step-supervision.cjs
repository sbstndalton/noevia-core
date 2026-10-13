'use strict';
const { causeOf } = require('./decision/index.cjs');
// Application checkpoint policy, not access to model reasoning. Providers are injected only.
const VERIFY = 'Check the preceding tool results against the user request before continuing. Identify missing evidence and uncertainty. Do not assume a failed tool succeeded.';
const CHOICES = ['continue', 'verify', 'escalate'];
// #1456: 'escalate' stops the reply. A round that wrote (a write tool was about to run) honours it as
// before. A read-only round honours it only when the classifier is confident: at least ESCALATE_MIN_SCORE,
// and ESCALATE_MARGIN clear of the runner-up. The score bar is the one tool-gate.cjs uses
// (DEFAULT_MIN_CONFIDENCE). The margin is 0.3, not 0.2: with three options summing to 1, a 0.6 score
// leaves at most 0.4 for the others, so a 0.2 margin would never bind; 0.3 makes a 0.6-vs-0.4 split weak.
// First guesses, not calibrated: tune them from the supervise rows of the decision log, not from one chat.
const ESCALATE_MIN_SCORE = 0.6;
const ESCALATE_MARGIN = 0.3;
// A small epsilon: 0.6 - 0.4 is 0.19999999999999996 in floating point, and a boundary score must pass.
const EPSILON = 1e-9;
function confidentEscalation(scores) {
  if (!scores || typeof scores !== 'object' || !CHOICES.every((id) => Number.isFinite(scores[id]))) return false;
  const runnerUp = Math.max(...CHOICES.filter((id) => id !== 'escalate').map((id) => scores[id]));
  return scores.escalate >= ESCALATE_MIN_SCORE - EPSILON && scores.escalate - runnerUp >= ESCALATE_MARGIN - EPSILON;
}
function createStepSupervision({ enabled = () => false, provider = null, deadlineMs = 500, getDeadlineMs = null,
  log = (entry) => console.info('[system-one] supervise', JSON.stringify(entry)) } = {}) {
  if (!Number.isFinite(deadlineMs) || deadlineMs < 1 || deadlineMs > 2000) throw Error('Invalid supervision deadline');
  return {
    async decide({ round, messages, signal, goal: requested, wrote = false }) {
      const fallback = { action: 'continue', source: 'existing' };
      if (!enabled() || !provider || signal?.aborted || round >= 2) return fallback;
      // Explicit, bounded model-facing outputs only: no credentials, reasoning or approval grants.
      const outputs = messages.filter(m => m.role === 'tool' || m.role === 'assistant').slice(-8)
        .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 1500) : '' }));
      // An ambiguous tool failure must not be reinterpreted as a successful step.
      if (outputs.some(m => m.role === 'tool' && /^ERROR/i.test(m.content))) return fallback;
      const ms=getDeadlineMs ? getDeadlineMs() : deadlineMs;
      if(!Number.isInteger(ms) || ms<1 || ms>2000) return fallback;
      const controller = new AbortController();
      let timer, abort;
      try {
        const unavailable = new Promise(resolve => {
          abort = () => { controller.abort(); resolve(null); };
          timer = setTimeout(abort, ms);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
        const request = messages.findLast(m => m.role === 'user');
        // The caller's own words for the goal when it has them: the last user message can start with
        // attached file text (#1441), which is not the request.
        const goal = typeof requested === 'string' ? requested.slice(0, 1500) : typeof request?.content === 'string' ? request.content.slice(0, 1500) : '';
        const result = await Promise.race([
          Promise.resolve().then(() => controller.signal.aborted ? null : provider.decide({ round, goal, outputs, choices: CHOICES }, { signal: controller.signal })),
          unavailable,
        ]);
        // The answer is { action } and, from the decision service, its validated { scores } (#1456).
        if (signal?.aborted || !result || Object.keys(result).some((key) => key !== 'action' && key !== 'scores') || !CHOICES.includes(result.action)) {
          // #682: why there was no decision: the chat was stopped, the deadline passed, or the answer was malformed.
          log({ round, action: 'continue', fellBack: 'no-decision', cause: signal?.aborted ? 'aborted' : !result ? 'deadline' : 'invalid-result' });
          return fallback;
        }
        if (result.action === 'escalate' && !wrote && !confidentEscalation(result.scores)) {
          // #1456: a read-only round changed nothing, so a weak stop verdict only ends the reply. Carry on.
          log({ round, action: 'continue', fellBack: 'weak-escalate', cause: null });
          return fallback;
        }
        log({ round, action: result.action, fellBack: null });
        return { action: result.action, source: 'experimental' };
      } catch (error) {
        // A text-free code only (http-503, http-422, network, parse, ...), never the error message.
        log({ round, action: 'continue', fellBack: 'error', cause: signal?.aborted ? 'aborted' : causeOf(error) });
        return fallback;
      }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
    },
  };
}
async function superviseNextStep(supervisor, input) {
  if (!supervisor) return { messages: input.messages, pause: false };
  const decision = await supervisor.decide(input);
  return { messages: decision.action === 'verify' ? [...input.messages, {role:'user',content:VERIFY}] : input.messages,
    pause: decision.action === 'escalate', decision };
}
module.exports = { createStepSupervision, superviseNextStep };
