'use strict';
// The Node half of the credential scrub (noevia-rs bins/noevia-server mcp_scrub.rs has the same cases).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createSecrets, scrubbedError, sanitizeTool, REDACTED } = require('./mcp-scrub.cjs');

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

// ── the one policy, two implementations: tests/fixtures/mcp-scrub.v1.json is read by noevia-rs too ──

const FIXTURE = path.join(__dirname, '..', 'tests', 'fixtures', 'mcp-scrub.v1.json');
const fixture = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const secretsFrom = (headers) => createSecrets(Object.fromEntries(headers));

test('every shared text case scrubs as recorded', () => {
  const { text } = fixture();
  assert.ok(text.length >= 35);
  for (const c of text) assert.equal(secretsFrom(c.headers).scrub(c.text), c.expect, c.id);
});

test('every shared tool case is sanitized as recorded', () => {
  const { tool } = fixture();
  assert.ok(tool.length >= 18);
  for (const c of tool) {
    const out = sanitizeTool(c.tool, secretsFrom(c.headers));
    assert.deepEqual(out.dropped ? { dropped: out.dropped } : { tool: out.tool }, c.expect, c.id);
  }
});

test('the committed shared fixture is what the reference says', { timeout: 60000 }, () => {
  const fresh = execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'gen-mcp-scrub-fixtures.cjs')], { encoding: 'utf8' });
  assert.equal(fresh, fs.readFileSync(FIXTURE, 'utf8'), 'regenerate: node tools/gen-mcp-scrub-fixtures.cjs > tests/fixtures/mcp-scrub.v1.json (and copy it to noevia-rs)');
});

test('a sanitized tool never repeats the credential anywhere, and a scrubbed schema keeps its shape', () => {
  const KEY = 'SYNTH-api-secret-1234';
  const secrets = createSecrets({ 'X-Api-Key': KEY });
  const input = { name: 'ok', description: `d ${KEY}`, inputSchema: { type: 'object', properties: { q: { type: 'string', description: `use ${KEY}`, minLength: 1 } }, required: ['q'] } };
  const { tool } = sanitizeTool(input, secrets);
  assert.equal(JSON.stringify(tool).includes(KEY), false);
  assert.deepEqual(tool.inputSchema.required, ['q']);
  assert.equal(tool.inputSchema.properties.q.minLength, 1);
  assert.equal(input.description.includes(KEY), true, 'the listed definition itself is not mutated');
});
