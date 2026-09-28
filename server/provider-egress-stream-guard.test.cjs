'use strict';
// The stream-guard (#516) integration seam: tool-call argument validation
// against an optional registered JSON-schema subset, wired through
// `evaluateToolCall` — the same helper chat.cjs's `egressToolRefusal` wrapper
// calls for every tool call, for every provider (local/default included).
// OFF by default (a code flag, not a live preference) and a no-op with no
// schema registered even when flipped on. `toolRefusal` itself stays
// external-provider-only and untouched by the guard.
const test = require('node:test');
const assert = require('node:assert/strict');
const egress = require('./provider-egress.cjs');

const LOCAL_PROVIDER = { id: 'default' };
const EXTERNAL_PROVIDER = { id: 'chatgpt-prov', kind: 'chatgpt-oauth', label: 'ChatGPT' };
const FIXTURE_SCHEMA = { type: 'object', required: ['x'], additionalProperties: false, properties: { x: { type: 'string' } } };

test.afterEach(() => {
  egress.__setStreamGuardEnabledForTests(false);
  egress.setToolArgumentSchema('fixture_tool', null);
});

test('off by default: a registered schema is never consulted through the real call path, even for a local provider', () => {
  egress.setToolArgumentSchema('fixture_tool', FIXTURE_SCHEMA);
  const refusal = egress.evaluateToolCall({ provider: LOCAL_PROVIDER, toolName: 'fixture_tool', rawArgs: '{"y":"bad"}' });
  assert.equal(refusal, null, 'default behaviour must be unchanged: the guard is off unless enabled in code');
});

test('enabled with no registered schema is a no-op for every tool, local provider included', () => {
  egress.__setStreamGuardEnabledForTests(true);
  const refusal = egress.evaluateToolCall({ provider: LOCAL_PROVIDER, toolName: 'some_other_tool', rawArgs: '{"anything":true}' });
  assert.equal(refusal, null);
});

// ---- the MEDIUM fix: the guard must run for local/default providers, not only external ones ----

test('enabled with a registered schema refuses bad arguments on a LOCAL/default provider (not just external)', () => {
  egress.__setStreamGuardEnabledForTests(true);
  egress.setToolArgumentSchema('fixture_tool', FIXTURE_SCHEMA);
  const refusal = egress.evaluateToolCall({ provider: LOCAL_PROVIDER, toolName: 'fixture_tool', rawArgs: '{"y":"bad"}' });
  assert.match(refusal, /fixture_tool arguments failed schema validation/);
  assert.match(refusal, /Unknown property 'y'/);
});

test('enabled with a registered schema also refuses bad arguments on an external provider', () => {
  egress.__setStreamGuardEnabledForTests(true);
  egress.setToolArgumentSchema('fixture_tool', FIXTURE_SCHEMA);
  const refusal = egress.evaluateToolCall({ provider: EXTERNAL_PROVIDER, toolName: 'fixture_tool', rawArgs: '{"y":"bad"}' });
  assert.match(refusal, /fixture_tool arguments failed schema validation/);
});

test('enabled with a registered schema lets valid arguments through to the existing rules unchanged, on a local provider', () => {
  egress.__setStreamGuardEnabledForTests(true);
  egress.setToolArgumentSchema('fixture_tool', FIXTURE_SCHEMA);
  const refusal = egress.evaluateToolCall({ provider: LOCAL_PROVIDER, toolName: 'fixture_tool', rawArgs: '{"x":"ok"}' });
  assert.equal(refusal, null);
});

test('enabling the guard does not change the unrelated Diary/storage egress rules (still external-only)', () => {
  egress.__setStreamGuardEnabledForTests(true);
  const refusalExternal = egress.evaluateToolCall({ provider: EXTERNAL_PROVIDER, toolName: 'diary_search', rawArgs: '{}' });
  assert.match(refusalExternal, /Diary content is never sent to/);
  // toolRefusal itself is untouched and still returns null for local providers regardless of the flag:
  const localToolRefusal = egress.toolRefusal({ provider: LOCAL_PROVIDER, toolName: 'diary_search', rawArgs: '{}' });
  assert.equal(localToolRefusal, null, 'toolRefusal stays external-provider-only; local Diary tools are gated elsewhere');
});

test('toolRefusal itself never sees or applies the stream-guard check directly (evaluateToolCall does)', () => {
  egress.__setStreamGuardEnabledForTests(true);
  egress.setToolArgumentSchema('fixture_tool', FIXTURE_SCHEMA);
  // A direct toolRefusal call on a local provider is unaffected by the registered schema:
  // proves the guard lives in evaluateToolCall, ahead of toolRefusal, not inside it.
  const refusal = egress.toolRefusal({ provider: LOCAL_PROVIDER, toolName: 'fixture_tool', rawArgs: '{"y":"bad"}' });
  assert.equal(refusal, null);
});

test('validateToolArguments is directly usable and returns null when disabled', () => {
  egress.setToolArgumentSchema('fixture_tool', { type: 'object', required: ['x'] });
  assert.equal(egress.validateToolArguments('fixture_tool', '{}'), null);
  egress.__setStreamGuardEnabledForTests(true);
  const violation = egress.validateToolArguments('fixture_tool', '{}');
  assert.ok(violation);
  assert.match(violation.message, /Missing required property x/);
});

test('__setStreamGuardEnabledForTests is test-only and cannot be used as a production back door', () => {
  const savedTestContext = process.env.NODE_TEST_CONTEXT;
  const savedNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_ENV;
  try {
    assert.throws(() => egress.__setStreamGuardEnabledForTests(true), /test-only/);
  } finally {
    if (savedTestContext !== undefined) process.env.NODE_TEST_CONTEXT = savedTestContext;
    if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
  }
});
