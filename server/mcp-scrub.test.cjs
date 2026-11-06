'use strict';
// The Node half of the credential scrub (noevia-rs bins/noevia-server mcp_scrub.rs has the same cases).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSecrets, scrubbedError, REDACTED } = require('./mcp-scrub.cjs');

const secretsOf = (...values) => { const s = createSecrets(); for (const v of values) s.addValue(v); return s; };

test('every length of credential is redacted as a whole token', () => {
  for (const key of ['a', 'q7', 'q7Z', 'q7Z!', 'q7Z!2', 'q7Z!2x', 'q7Z!2xy', 'q7Z!2xyz']) {
    const s = secretsOf(key);
    assert.equal(s.scrub(`bad token ${key}`), `bad token ${REDACTED}`, key);
    assert.equal(s.scrub(`bad token ${key}.`), `bad token ${REDACTED}.`, key);
    assert.equal(s.scrub(`(${key})`), `(${REDACTED})`, key);
    assert.equal(s.scrub(key), REDACTED, key);
  }
});

test('a short value inside a longer word is left alone and a long one is not', () => {
  assert.equal(secretsOf('ab').scrub('cabin about ab'), 'cabin about [redacted]');
  assert.equal(secretsOf('ab').scrub('ab_c ab9 9ab'), 'ab_c ab9 9ab');
  assert.equal(secretsOf('abcdefg').scrub('xabcdefgx'), 'xabcdefgx');
  assert.equal(secretsOf('abcdefgh').scrub('xabcdefghx'), 'x[redacted]x');
});

test('the scheme-stripped token, the Basic halves and the other spellings are covered; the account id is not a credential', () => {
  const basic = Buffer.from('al:pw12').toString('base64');
  const s = secretsOf(`Basic ${basic}`, 'Bearer t9');
  assert.equal(s.scrub(`${basic} al:pw12 al pw12 t9 Basic ${basic} Bearer t9`), '[redacted] [redacted] [redacted] [redacted] [redacted] [redacted] [redacted]');
  const h = createSecrets({ 'X-Cowork-User-ID': 'user-1', 'X-Api-Key': 'k"q\\ü' });
  assert.equal(h.scrub('user-1'), 'user-1');
  assert.equal(h.scrub('{"m":"k\\"q\\\\ü"} k%22q%5C%C3%BC'), '{"m":"[redacted]"} [redacted]');
});

test('numbers and booleans are text to the scrub, and the scrubbed error keeps its status and plain code only', () => {
  const s = secretsOf('12345', 'true');
  assert.equal(s.scrub(12345), REDACTED);
  assert.equal(s.scrub('MCP error 12345: boolean true'), 'MCP error [redacted]: boolean [redacted]');
  const e = scrubbedError(Object.assign(new Error('MCP 401: key 12345'), { httpStatus: 401, code: 'EPRIVATEADDR', retryAfter: '3' }), s);
  assert.deepEqual([e.message, e.httpStatus, e.code, e.retryAfter], ['MCP 401: key [redacted]', 401, 'EPRIVATEADDR', undefined]);
  assert.equal(scrubbedError(Object.assign(new Error('x'), { code: 'has a secret 12345' }), s).code, undefined);
});
