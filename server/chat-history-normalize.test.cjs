'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReplayHistory } = require('./chat.cjs');

test('merges adjacent user turns (errored/cancelled reply or two-device merge) with the new message', () => {
  const result = normalizeReplayHistory(
    [{ role: 'user', content: 'first attempt' }, { role: 'user', content: 'retry' }],
    'new message',
  );
  assert.deepEqual(result, [{ role: 'user', content: 'first attempt\n\nretry\n\nnew message' }]);
});

test('drops a leading assistant turn and merges the trailing pair', () => {
  const result = normalizeReplayHistory(
    [{ role: 'assistant', content: 'stray reply' }, { role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' }],
  );
  assert.deepEqual(result, [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' }]);
});

test('leaves an already-alternating history unchanged, appending the new user message', () => {
  const result = normalizeReplayHistory(
    [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
    'how are you',
  );
  assert.deepEqual(result, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'how are you' },
  ]);
});

test('system messages, if present, pass through untouched', () => {
  const result = normalizeReplayHistory(
    [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'hi' }],
    'again',
  );
  assert.deepEqual(result, [
    { role: 'system', content: 'be nice' },
    { role: 'user', content: 'hi\n\nagain' },
  ]);
});

test('with no history, only the new user message is emitted', () => {
  assert.deepEqual(normalizeReplayHistory([], 'solo'), [{ role: 'user', content: 'solo' }]);
});

test('compactOnly (no new message) still merges and drops a leading assistant turn', () => {
  const result = normalizeReplayHistory([
    { role: 'assistant', content: 'stray' },
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
  ]);
  assert.deepEqual(result, [{ role: 'user', content: 'a\n\nb' }]);
});
