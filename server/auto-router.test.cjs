'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classifierVerdict, CLASSIFIER_MAX_TOKENS } = require('./index.cjs');

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
