'use strict';
// Application checkpoint policy, not access to model reasoning. Providers are injected only.
const VERIFY = 'Check the preceding tool results against the user request before continuing. Identify missing evidence and uncertainty. Do not assume a failed tool succeeded.';
function createStepSupervision({ enabled = () => false, provider = null, deadlineMs = 500, getDeadlineMs = null } = {}) {
  if (!Number.isFinite(deadlineMs) || deadlineMs < 1 || deadlineMs > 1500) throw Error('Invalid supervision deadline');
  return {
    async decide({ round, messages, signal }) {
      const fallback = { action: 'continue', source: 'existing' };
      if (!enabled() || !provider || signal?.aborted || round >= 2) return fallback;
      // Explicit, bounded model-facing outputs only: no credentials, reasoning or approval grants.
      const outputs = messages.filter(m => m.role === 'tool' || m.role === 'assistant').slice(-8)
        .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 1500) : '' }));
      // An ambiguous tool failure must not be reinterpreted as a successful step.
      if (outputs.some(m => m.role === 'tool' && /^ERROR/i.test(m.content))) return fallback;
      const ms=getDeadlineMs ? getDeadlineMs() : deadlineMs;
      if(!Number.isInteger(ms) || ms<1 || ms>1500) return fallback;
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
        const goal = typeof request?.content === 'string' ? request.content.slice(0, 1500) : '';
        const result = await Promise.race([
          Promise.resolve().then(() => controller.signal.aborted ? null : provider.decide({ round, goal, outputs, choices: ['continue', 'verify', 'escalate'] }, { signal: controller.signal })),
          unavailable,
        ]);
        if (signal?.aborted || !result || Object.keys(result).length !== 1 || !['continue','verify','escalate'].includes(result.action)) return fallback;
        return { action: result.action, source: 'experimental' };
      } catch { return fallback; }
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
