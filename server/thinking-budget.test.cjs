'use strict';
// #1475 / #1477: per-effort thinking caps on the local engine, and the forced answer after a cut.
// Synthetic SSE streams and a fake fetcher only; no engine, no model.
const test = require('node:test'), assert = require('node:assert/strict');
const tb = require('./thinking-budget.cjs');
const reasoningEffort = require('./reasoning-effort.cjs');

const enc = new TextEncoder();
const sse = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const thought = (text) => sse({ reasoning_content: text });
const words = (n, word = 'hm') => Array.from({ length: n }, () => word).join(' ');

// A streamed response whose chunks are `lines` (one SSE event per chunk), tracking cancellation.
function upstream(lines, track = {}) {
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i >= lines.length) { controller.close(); return; }
      controller.enqueue(enc.encode(lines[i++]));
    },
    cancel() { track.cancelled = true; },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
async function drain(response) {
  let out = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) out += decoder.decode(chunk, { stream: true });
  return out;
}

test('the output budget is a quarter of the context, at most 8,192', () => {
  assert.equal(tb.outputBudget(8192), 2048);
  assert.equal(tb.outputBudget(24600), 6150, 'the #1477 route: raised from the old 4,096 cap');
  assert.equal(tb.outputBudget(32768), 8192);
  assert.equal(tb.outputBudget(262144), 8192);
});

test('each effort has a thinking cap, and the answer always keeps its room', () => {
  assert.equal(tb.thinkingCap('low', 6150), 512);
  assert.equal(tb.thinkingCap('default', 6150), 2048);
  assert.equal(tb.thinkingCap('high', 8192), 7168, 'high is capped by the answer room, not by its own 8,192');
  assert.equal(tb.thinkingCap('default', 2048), 1024, 'a small window still leaves 1,024 for the answer');
  assert.equal(tb.thinkingCap('default', 1000), 0, 'a tiny budget never goes negative');
  assert.equal(tb.thinkingCap('unknown-level', 6150), 2048, 'an unknown effort gets the Standard cap');
  for (const effort of ['low', 'default', 'high']) {
    for (const budget of [1024, 2048, 4096, 6150, 8192]) {
      assert.ok(tb.thinkingCap(effort, budget) + tb.MIN_ANSWER_TOKENS <= Math.max(budget, tb.MIN_ANSWER_TOKENS), `${effort}/${budget}`);
    }
  }
});

test('a reply under its thinking cap passes through unchanged', async () => {
  const track = {};
  const response = tb.capReasoning(upstream([thought('short'), sse({ content: 'Answer.' }), 'data: [DONE]\n\n'], track), { cap: 512, retry: async () => assert.fail('no retry under the cap') });
  const text = await drain(response);
  assert.equal(text, 'data: {"choices":[{"delta":{"reasoning_content":"short"}}]}\n\n' + sse({ content: 'Answer.' }) + 'data: [DONE]\n\n');
  assert.equal(track.cancelled, undefined);
});

test('reasoning past the cap with no answer is cut, and the forced answer is streamed in its place', async () => {
  const track = {};
  const cuts = [];
  const lines = [thought(words(100)), thought(words(400)), thought(words(400)), sse({ content: 'never sent' })];
  const response = tb.capReasoning(upstream(lines, track), {
    cap: 100,
    retry: async () => upstream([sse({ content: 'The answer is 4.' }), 'data: [DONE]\n\n']),
    onCut: () => cuts.push(true),
  });
  const text = await drain(response);
  assert.deepEqual(cuts, [true]);
  assert.equal(track.cancelled, true, 'the reasoning stream is cancelled at the cut');
  assert.ok(!text.includes('never sent'), 'the stream after the cut is not the old one');
  assert.match(text, /The answer is 4\./);
  assert.ok(text.indexOf('The answer is 4.') > text.indexOf(words(100).slice(0, 20)));
});

test('once the answer has started, reasoning is never cut', async () => {
  const cuts = [];
  const lines = [sse({ content: 'Starting. ' }), thought(words(2000)), sse({ content: 'Done.' })];
  const response = tb.capReasoning(upstream(lines), { cap: 10, retry: async () => assert.fail('an answer in progress is not cut'), onCut: () => cuts.push(1) });
  const text = await drain(response);
  assert.deepEqual(cuts, []);
  assert.match(text, /Starting\. [\s\S]*Done\./);
});

test('a tool call in progress is never cut', async () => {
  const lines = [sse({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'search', arguments: '{}' } }] }), thought(words(2000))];
  const response = tb.capReasoning(upstream(lines), { cap: 10, retry: async () => assert.fail('a tool call is not cut') });
  assert.match(await drain(response), /search/);
});

test('a failed forced-answer request errors the stream instead of ending it quietly', async () => {
  const response = tb.capReasoning(upstream([thought(words(500))]), {
    cap: 10,
    retry: async () => new Response('busy', { status: 503 }),
  });
  await assert.rejects(drain(response), /forced answer request failed \(HTTP 503\)/);
});

test('a thrown retry errors the stream with that error', async () => {
  const response = tb.capReasoning(upstream([thought(words(500))]), {
    cap: 10,
    retry: async () => { throw Error('network down'); },
  });
  await assert.rejects(drain(response), /network down/);
});

// --- reasoning-effort.cjs: the request that is cut, and the forced request ---------------------

const LOCAL = { id: 'local', baseUrl: 'http://engine.test/v1', apiKey: 'local' };
const baseBody = (extra = {}) => ({ model: 'plain-model', stream: true, max_tokens: 6150, messages: [{ role: 'system', content: 'You are a helper.' }, { role: 'user', content: 'Count to 3.' }], tools: [{ type: 'function', function: { name: 'search' } }], tool_choice: 'auto', ...extra });

test('requestWithEffort cuts a long thought and asks again with the forced answer, no tools, thinking hint kept', async () => {
  const sent = [];
  const fetcher = async (url, options) => {
    sent.push(JSON.parse(options.body));
    return sent.length === 1 ? upstream([thought(words(300))]) : upstream([sse({ content: '1 2 3' }), 'data: [DONE]\n\n']);
  };
  const reports = [];
  const response = await reasoningEffort.requestWithEffort(fetcher, `${LOCAL.baseUrl}/chat/completions`, { method: 'POST', headers: {} }, baseBody(), LOCAL, 'plain-model', 'low', (r) => reports.push(r), 64);
  const text = await drain(response);
  assert.match(text, /1 2 3/);
  assert.equal(sent.length, 2, 'one forced request after the cut');
  const forced = sent[1];
  assert.equal(forced.messages[0].role, 'system');
  assert.equal(forced.messages[0].content, tb.FORCED_ANSWER);
  assert.equal(forced.tools, undefined, 'tools are dropped for the answer');
  assert.equal(forced.tool_choice, undefined);
  assert.equal(forced.stream, true);
  assert.equal(forced.max_tokens, 6150, 'the answer keeps the output budget');
  assert.equal(forced.chat_template_kwargs, undefined, 'no native switch here, so none is sent');
  assert.ok(reports.some((r) => r.type === 'warning' && /without further reasoning/.test(r.text)));
  const meta = reports.find((r) => r.type === 'meta');
  assert.equal(meta.thinkingCap, 64);
});

test('a Qwen3 template on the configured local engine is told to stop thinking', async () => {
  const saved = { kind: process.env.MODEL_MANAGER_KIND, base: process.env.INFERENCE_BASE_URL };
  process.env.MODEL_MANAGER_KIND = 'llamacpp';
  process.env.INFERENCE_BASE_URL = LOCAL.baseUrl;
  try {
    const sent = [];
    const fetcher = async (url, options) => {
      sent.push(JSON.parse(options.body));
      return sent.length === 1 ? upstream([thought(words(300))]) : upstream([sse({ content: 'ok' }), 'data: [DONE]\n\n']);
    };
    const response = await reasoningEffort.requestWithEffort(fetcher, `${LOCAL.baseUrl}/chat/completions`, { method: 'POST', headers: {} }, baseBody({ model: 'qwen3-8b' }), LOCAL, 'qwen3-8b', 'default', () => {}, 32);
    await drain(response);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].chat_template_kwargs.enable_thinking, false);
  } finally {
    if (saved.kind === undefined) delete process.env.MODEL_MANAGER_KIND; else process.env.MODEL_MANAGER_KIND = saved.kind;
    if (saved.base === undefined) delete process.env.INFERENCE_BASE_URL; else process.env.INFERENCE_BASE_URL = saved.base;
  }
});

test('without a thinking cap, or for a non-streamed reply, the engine reply is returned untouched', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return upstream([thought(words(900))]); };
  const uncapped = await reasoningEffort.requestWithEffort(fetcher, 'http://engine.test/v1/chat/completions', { method: 'POST', headers: {} }, baseBody(), LOCAL, 'plain-model', 'default', () => {});
  await drain(uncapped);
  const nonStream = await reasoningEffort.requestWithEffort(fetcher, 'http://engine.test/v1/chat/completions', { method: 'POST', headers: {} }, baseBody({ stream: false }), LOCAL, 'plain-model', 'default', () => {}, 16);
  assert.equal(calls, 2, 'one request each and no forced retry for either');
});

test('forcedAnswerBody keeps the conversation and drops tools for every request shape', () => {
  const forced = reasoningEffort.forcedAnswerBody(baseBody({ chat_template_kwargs: { keep: 1 } }), LOCAL, 'plain-model');
  assert.equal(forced.messages.length, 3);
  assert.equal(forced.messages[1].content, 'You are a helper.');
  assert.deepEqual(forced.chat_template_kwargs, { keep: 1 });
  assert.equal(forced.tools, undefined);
});
