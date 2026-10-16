'use strict';
// #1896: why POST /api/chat answers 503, and what is done about it.
//
// The 503s of /api/chat in this process, each with a text-free reason code:
//   maintenance          the inference maintenance gate is held (a preset apply, a calibration, or an auto-tune that took
//                        the gate the moment the previous reply ended): inference-maintenance.cjs
//   machine-unreachable  / machine-wrong-model   the Inference machine serving the turn's role is not ready (chat.cjs)
//   internal             any other handler error carrying status 503
// Stop never causes a 503 by itself: the upstream generation is aborted when the response closes (chat.cjs chatSignal)
// and the gate counts requests, it does not refuse a new turn while an old one finishes. A tune/calibration that was
// waiting for chat to be idle does take the gate right then, which is the "Stop, then 503" the QA saw: so the gate is
// waited for briefly (CHAT_GATE_WAIT_MS) before answering, and the answer is a retryable one the client retries once.

const CHAT_GATE_WAIT_MS = 3000;

/** One content-free line per 503: the route and a reason code, never a message, prompt or id. */
function log503(reason, { log = console.warn, route = '/api/chat' } = {}) {
  const code = /^[a-z0-9-]{1,40}$/.test(String(reason)) ? String(reason) : 'unknown'; // a code, never free text
  try { log(`[chat] 503 route=${route} reason=${code}`); } catch { /* logging must not change the answer */ }
}

/** Enter the inference gate for a chat turn. Resolves the leave function (or a no-op without a gate); throws the 503. */
async function enterChatInference(manager, { waitMs = CHAT_GATE_WAIT_MS, signal } = {}) {
  if (typeof manager?.enterInferenceWithin === 'function') return manager.enterInferenceWithin(waitMs, signal);
  if (typeof manager?.enterInference === 'function') return manager.enterInference();
  return undefined;
}

/** The JSON body of a gate refusal: the gate's own message, a stable code and the retry hint. */
function refusalBody(err) {
  return { error: err.message, code: err.code || 'inferenceMaintenance', retryable: true, retryAfter: 3 };
}

module.exports = { CHAT_GATE_WAIT_MS, log503, enterChatInference, refusalBody };
