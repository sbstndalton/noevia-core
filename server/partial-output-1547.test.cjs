// #1547: the failure text says "Partial output was preserved" only when partial text was kept.
// Synthetic upstream bodies only.
const test = require('node:test');
const assert = require('node:assert/strict');
const context = require('./chat-context.cjs');
const caps = require('./chat-template-caps.cjs');

const PRESERVED = /Partial output was preserved/;

test('#1547 a stream failure with no kept text makes no claim that output was preserved', () => {
  const text = context.providerError('terminated: other side closed');
  assert.equal(text, context.STREAM_FAILED_TEXT);
  assert.doesNotMatch(text, PRESERVED);
  assert.match(text, /Check the backend before retrying/);
});

test('#1547 a stream failure after text was shown keeps the preserved sentence', () => {
  const text = context.providerError('terminated: other side closed', undefined, { partial: true });
  assert.equal(text, context.STREAM_FAILED_PARTIAL_TEXT);
  assert.match(text, PRESERVED);
});

test('#1547 a provider refusal with no kept text drops the sentence; with kept text it keeps it', () => {
  const body = '{"detail":"temperature must be <= 2"}';
  assert.equal(caps.failureText(422, body), 'The model provider refused the request: temperature must be <= 2.');
  assert.equal(caps.failureText(422, body, { partial: true }), 'The model provider refused the request: temperature must be <= 2. Partial output was preserved.');
});

test('#1547 an upstream reason with no kept text does not claim preserved output', () => {
  const text = caps.failureText(500, '{"error":"upstream exploded, synthetic"}');
  assert.doesNotMatch(text ?? '', PRESERVED);
  const partial = caps.failureText(500, '{"error":"upstream exploded, synthetic"}', { partial: true });
  assert.match(partial ?? '', PRESERVED);
});

test('#1547 the provider-error helper passes the partial flag through to the classifier text', () => {
  const body = { message: 'Context size has been exceeded.' };
  assert.equal(context.providerError(body, undefined, { partial: true }), context.CONTEXT_FULL_TEXT, 'context-full text is unchanged');
});
