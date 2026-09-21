'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
// Each test file gets its own data dir so parallel runs never race on the
// default server/ui-data/secrets.key (EEXIST).
process.env.UI_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'cowork-autorouter-test-'));
// The classifier is its own module now; it needs no server, so the test builds one directly
// instead of booting index.cjs for a pure function.
const { createAutoRouter, CLASSIFIER_MAX_TOKENS } = require('./auto-router.cjs');
const quiet = { warn: () => {}, log: () => {} };
const { classifierVerdict, heuristicWantsSmart, heuristicWantsCode, classify } = createAutoRouter({
  roles: () => null, provider: () => ({ baseUrl: 'http://engine.test' }), headers: () => ({}),
  fetchJson: async () => ({ ok: false, status: 500 }), log: quiet,
});

// Regression for: auto routing always chose the fast role. Two independent
// causes, both reproduced against the live local roster on 2026-09-07.
test('classifier verdict prefers content over the reasoning channel', () => {
  // The bug: a thinking model restates the system prompt's own "FAST ... SMART"
  // wording while deliberating, so scanning content+reasoning as one blob let
  // the prompt's words outvote the model's actual answer.
  assert.equal(
    classifierVerdict({
      content: 'SMART',
      reasoning_content: 'Is it FAST for small talk, or SMART for analysis? ... I think FAST at first',
    }),
    'smart',
  );
  // Reasoning is still a fallback when the model emitted no content.
  assert.equal(
    classifierVerdict({ content: '', reasoning_content: 'Considering FAST ... final answer: SMART' }),
    'smart',
  );
  assert.equal(classifierVerdict({ content: 'FAST' }), 'fast');
  assert.equal(classifierVerdict({ content: 'fast\n' }), 'fast');
});

test('classifier verdict is null (not a silent "fast") when nothing was decided', () => {
  // A truncated reasoning model returns finish_reason 'length' with empty
  // content. The old code turned that into a confident 'fast'; callers must be
  // able to tell "no answer" from "answered fast" so the failure is loggable.
  assert.equal(classifierVerdict({ content: '', reasoning_content: 'Thinking Process:\n1. Analyze' }), null);
  assert.equal(classifierVerdict({}), null);
});

test('classifier token budget leaves room for a reasoning model to reach its verdict', () => {
  // Measured need on the local roster: gemma-4-E2B ~162 tokens, Qwen3.5-9B
  // ~427. The old budget of 64 truncated both before any verdict appeared.
  assert.ok(CLASSIFIER_MAX_TOKENS >= 427, `budget ${CLASSIFIER_MAX_TOKENS} is below the measured worst case`);
});

test('the router fails open to fast, and only offers CODE when a code role exists', async () => {
  const calls = [];
  const build = (roles, reply) => createAutoRouter({
    roles: () => roles,
    provider: () => ({ baseUrl: 'http://engine.test/v1' }),
    headers: () => ({}),
    fetchJson: async (url, init) => { calls.push(JSON.parse(init.body)); return reply; },
    log: { warn: () => {}, log: () => {} },
  });
  // No roles configured at all: no call, and the cheap model.
  assert.equal(await build(null, null).classify('anything'), 'fast');
  assert.equal(calls.length, 0);

  // A fenced block is code only where a code role exists; otherwise it is smart, as before.
  assert.equal(await build({ fast: 'f', smart: 's', code: 'c' }, null).classify('```js\nx\n```'), 'code');
  assert.equal(await build({ fast: 'f', smart: 's' }, null).classify('```js\nx\n```'), 'smart');
  assert.equal(calls.length, 0, 'the heuristic answers without spending a call');

  // A classifier that errors, or answers nothing usable, never blocks the chat.
  assert.equal(await build({ fast: 'f', smart: 's' }, { ok: false, status: 500 }).classify('hi'), 'fast');
  assert.equal(await build({ fast: 'f', smart: 's' }, { ok: true, body: { choices: [{ message: { content: 'mumble' } }] } }).classify('hi'), 'fast');
  assert.equal(await build({ fast: 'f', smart: 's' }, { ok: true, body: { choices: [{ message: { content: 'SMART' } }] } }).classify('hi'), 'smart');

  // The prompt offered to the model names CODE only when it could be honoured.
  const withCode = build({ fast: 'f', smart: 's', code: 'c' }, { ok: true, body: { choices: [{ message: { content: 'FAST' } }] } });
  await withCode.classify('what time is it');
  assert.match(calls.at(-1).messages[0].content, /CODE for/);
  const without = build({ fast: 'f', smart: 's' }, { ok: true, body: { choices: [{ message: { content: 'FAST' } }] } });
  await without.classify('what time is it');
  assert.ok(!/CODE for/.test(calls.at(-1).messages[0].content));
});

test('a provider that rejects the no-thinking hint is retried plainly, not downgraded', async () => {
  const sent = [];
  const router = createAutoRouter({
    roles: () => ({ fast: 'f', smart: 's' }),
    provider: () => ({ baseUrl: 'http://engine.test/v1' }),
    headers: () => ({}),
    fetchJson: async (url, init) => {
      const body = JSON.parse(init.body); sent.push(body);
      return body.chat_template_kwargs ? { status: 400, ok: false } : { ok: true, body: { choices: [{ message: { content: 'SMART' } }] } };
    },
    log: { warn: () => {}, log: () => {} },
  });
  assert.equal(await router.classify('a plain question'), 'smart');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].chat_template_kwargs.enable_thinking, false);
  assert.equal(sent[1].chat_template_kwargs, undefined);
});
