'use strict';
// #1475 / #1477: how long a local reply may think before it must answer.
//
// Thinking and the answer share one output budget (max_tokens). Left uncapped, a Standard reply to
// a counting prompt spent the whole 4,096 cap on reasoning and returned no answer (#1477), and a
// Low reply, sent only as a prompt hint on this route, thought for minutes (#1475). So on the local
// engine every effort level has a thinking cap, the output budget grows where the context allows,
// and the answer always keeps MIN_ANSWER_TOKENS of room. When a streamed reply passes its thinking
// cap before it has written any answer or tool call, the reasoning stream is cut and the same
// request is sent again, with a system note asking for the final answer (thinking switched off
// where the template has a native switch; see reasoning-effort.cjs forcedAnswerBody).
//
// Tokens are estimated at CHARS_PER_TOKEN characters. The cut lands before the SSE chunk that
// crosses the cap, so the cap is exact up to that estimate.

const THINKING_CAP_TOKENS = Object.freeze({ low: 512, default: 2048, high: 8192 });
const MIN_ANSWER_TOKENS = 1024;
const OUTPUT_CAP_MAX = 8192;
const OUTPUT_CONTEXT_SHARE = 0.25;
const CHARS_PER_TOKEN = 4;
const FORCED_ANSWER = 'Your thinking budget for this reply is used up. Write the final answer now, concisely and completely, without further reasoning. Do not call tools.';

/** Output budget (max_tokens) for a context of `limit` tokens: a quarter of it, at most 8,192. */
function outputBudget(limit) {
  return Math.min(OUTPUT_CAP_MAX, Math.floor(limit * OUTPUT_CONTEXT_SHARE));
}

/** Thinking tokens allowed at `effort` in a reply with this output budget. The rest is the answer's. */
function thinkingCap(effort, budget) {
  const cap = Object.prototype.hasOwnProperty.call(THINKING_CAP_TOKENS, effort) ? THINKING_CAP_TOKENS[effort] : THINKING_CAP_TOKENS.default;
  return Math.max(0, Math.min(cap, budget - MIN_ANSWER_TOKENS));
}

// A reader over a fetch body, or over any async-iterable body (the chat tests and some hosted
// clients hand one over): read() resolves { done, value }, cancel() ends the source.
function readerOf(body) {
  if (typeof body.getReader === 'function') return body.getReader();
  const iterator = body[Symbol.asyncIterator]();
  return { read: () => iterator.next(), cancel: async (reason) => { await iterator.return?.(reason); } };
}

/**
 * Wraps a streamed chat response. It passes through until the reasoning in it passes `cap` tokens
 * while it has no answer or tool text yet; then the upstream is cancelled, `onCut` runs, `retry()`
 * (a Promise<Response> for the forced-answer request) is streamed in its place, and a failed retry
 * errors the stream rather than ending it quietly.
 */
function capReasoning(response, { cap, retry, onCut = () => {} }) {
  const limitChars = cap * CHARS_PER_TOKEN;
  const decoder = new TextDecoder();
  let reader = readerOf(response.body);
  let buffer = '', reasoningChars = 0, answered = false, forced = false;

  // Reads the complete SSE lines in `value`; true when this chunk takes the reasoning past the cap.
  function overCap(value) {
    buffer += decoder.decode(value, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line.startsWith('data:')) continue;
      let delta;
      try { delta = JSON.parse(line.slice(5).trim())?.choices?.[0]?.delta; } catch { continue; }
      if (!delta) continue;
      if (delta.content || (Array.isArray(delta.tool_calls) && delta.tool_calls.length)) answered = true;
      const thought = delta.reasoning_content || delta.reasoning;
      if (typeof thought === 'string') reasoningChars += thought.length;
    }
    return !answered && reasoningChars > limitChars;
  }

  const body = new ReadableStream({
    async pull(controller) {
      for (;;) {
        let read;
        try { read = await reader.read(); } catch (error) { controller.error(error); return; }
        if (read.done) { controller.close(); return; }
        if (forced || !overCap(read.value)) { controller.enqueue(read.value); return; }
        forced = true;
        await reader.cancel().catch(() => {});
        onCut();
        let next;
        try {
          next = await retry();
          if (!next.ok || !next.body) throw Error(`The forced answer request failed (HTTP ${next.status}). Try again.`);
        } catch (error) { controller.error(error); return; }
        reader = readerOf(next.body);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

module.exports = { THINKING_CAP_TOKENS, MIN_ANSWER_TOKENS, OUTPUT_CAP_MAX, OUTPUT_CONTEXT_SHARE, CHARS_PER_TOKEN, FORCED_ANSWER, outputBudget, thinkingCap, capReasoning };
