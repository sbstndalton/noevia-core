'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PLAN_ARTIFACT_SCHEMA, planConstraint, requestPlanArtifact, supportsJsonSchema } = require('./plan-constrained-decoding.cjs');
const { createFeatures } = require('./features.cjs');
const { parseCapabilities, effectiveCapabilities, engineCapabilities } = require('./providers.cjs');

// Synthetic rows only. The capable one declares the capability; nothing about its address matters.
const capable = { id: 'engine-a', baseUrl: 'http://engine.invalid/v1', capabilities: { jsonSchemaParam: true } };
const base = { enabled: true, provider: capable, model: 'synthetic-plan-model' };
const payload = { model: 'synthetic-plan-model', messages: [{ role: 'user', content: 'x' }] };
const fake = (...replies) => { const calls = []; const send = async p => { calls.push(p); const r = replies.shift(); if (r instanceof Error) throw r; return r; }; return { send, calls }; };

test('the feature flag exists, is off by default, and is available now the pipeline runs the plan step (#705)', () => {
  const f = createFeatures({ env: { NOEVIA_FEATURE_CONSTRAINED_PLAN_DECODING: 'true' } });
  assert.equal(createFeatures({ env: {} }).enabled('constrainedPlanDecoding'), false);
  assert.equal(f.enabled('constrainedPlanDecoding'), true, 'the env pin turns it on');
  assert.equal(f.describe().find(x => x.name === 'constrainedPlanDecoding').unavailable, null);
});

test('flag off: no constraint fields', async () => {
  const c = planConstraint({ ...base, enabled: false });
  assert.deepEqual(c.fields, {});
  const { send, calls } = fake({ ok: true, body: 'a' });
  const r = await requestPlanArtifact({ payload, send, constraint: c });
  assert.deepEqual(calls, [payload]);
  assert.deepEqual(r.constraint, { applied: false, mode: null, reason: 'flag_off', fallback: false });
});

test('flag on, provider declaring jsonSchemaParam: response_format json_schema is sent with thinking off', async () => {
  const { send, calls } = fake({ ok: true, body: 'a' });
  const r = await requestPlanArtifact({ payload, send, constraint: planConstraint(base) });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].response_format, { type: 'json_schema', json_schema: { name: 'plan_artifact', strict: true, schema: PLAN_ARTIFACT_SCHEMA } });
  assert.equal(calls[0].json_schema, undefined, 'only the response_format shape is sent, never both');
  assert.deepEqual(calls[0].chat_template_kwargs, { enable_thinking: false });
  assert.equal(calls[0].messages, payload.messages);
  assert.deepEqual(r.constraint, { applied: true, mode: 'json_schema', reason: null, fallback: false });
});

test('existing chat_template_kwargs are kept and only enable_thinking is overridden', async () => {
  const { send, calls } = fake({ ok: true, body: 'a' });
  await requestPlanArtifact({ payload: { ...payload, chat_template_kwargs: { other: 1, enable_thinking: true } }, send, constraint: planConstraint(base) });
  assert.deepEqual(calls[0].chat_template_kwargs, { other: 1, enable_thinking: false });
});

test('providers that do not declare the capability never get the fields', () => {
  for (const provider of [
    { id: 'p', baseUrl: 'http://engine.invalid/v1' },
    { id: 'p', baseUrl: 'http://engine.invalid/v1', capabilities: {} },
    { id: 'p', baseUrl: 'http://engine.invalid/v1', capabilities: { jsonSchemaParam: false } },
    { id: 'p', baseUrl: 'http://engine.invalid/v1', capabilities: { jsonSchemaParam: 'true' } },
    { id: 'p', baseUrl: 'http://engine.invalid/v1', capabilities: { reasoningEffortParam: true } },
    null]) {
    const c = planConstraint({ ...base, provider });
    assert.deepEqual(c.fields, {});
    assert.equal(c.reason, 'provider_unsupported');
    assert.equal(supportsJsonSchema(provider), false);
  }
});

test('thinking: a model whose reasoning channel cannot be switched off, or a caller asking for thinking, stays unconstrained', () => {
  // The family table (sampling-recommendation.cjs) marks harmony-format models; the name is test data.
  const harmony = planConstraint({ ...base, model: 'gpt-oss-20b' });
  assert.equal(harmony.reason, 'reasoning_model');
  assert.deepEqual(harmony.fields, {});
  const thinking = planConstraint({ ...base, thinking: true });
  assert.equal(thinking.reason, 'thinking_enabled');
  assert.deepEqual(thinking.fields, {});
});

test('an engine 400 falls back once to unconstrained generation and logs a text-free cause', async () => {
  const logs = [];
  const { send, calls } = fake({ ok: false, status: 400 }, { ok: true, body: 'plain' });
  const r = await requestPlanArtifact({ payload, send, constraint: planConstraint(base), log: m => logs.push(m) });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].response_format);
  assert.equal(calls[1].response_format, undefined);
  assert.equal(calls[1].chat_template_kwargs, undefined, 'the retry is the caller payload as it was');
  assert.equal(r.body, 'plain');
  assert.deepEqual(r.constraint, { applied: false, mode: null, reason: 'engine_rejected_400', fallback: true });
  assert.deepEqual(logs, [{ event: 'plan.constraint_rejected', status: 400 }]);
});

test('a thrown 422 also falls back; other failures propagate without a retry; a second rejection is not retried again', async () => {
  const bad = Object.assign(new Error('engine said: secret prompt text'), { status: 422 });
  const a = fake(bad, { ok: true, body: 'p' });
  const logs = [];
  assert.equal((await requestPlanArtifact({ payload, send: a.send, constraint: planConstraint(base), log: m => logs.push(m) })).constraint.fallback, true);
  assert.doesNotMatch(JSON.stringify(logs), /secret prompt text/);
  const down = Object.assign(new Error('down'), { status: 503 });
  const b = fake(down);
  await assert.rejects(requestPlanArtifact({ payload, send: b.send, constraint: planConstraint(base) }), /down/);
  assert.equal(b.calls.length, 1);
  const c = fake({ ok: false, status: 400 }, { ok: false, status: 400 });
  await assert.rejects(requestPlanArtifact({ payload, send: c.send, constraint: planConstraint(base) }), /400/);
  assert.equal(c.calls.length, 2, 'exactly one unconstrained retry');
});

test('provider capability data: jsonSchemaParam is validated, and the default row gets it from its engine kind', () => {
  assert.deepEqual(parseCapabilities({ jsonSchemaParam: true }), { value: { jsonSchemaParam: true } });
  assert.match(parseCapabilities({ jsonSchemaParam: 'yes' }).error, /jsonSchemaParam/);
  assert.deepEqual(engineCapabilities('llamacpp'), { jsonSchemaParam: true });
  for (const kind of ['lemonade', 'none', '', undefined, '__proto__', 'constructor']) assert.equal(engineCapabilities(kind), null, String(kind));
  engineCapabilities('llamacpp').jsonSchemaParam = false;
  assert.equal(engineCapabilities('llamacpp').jsonSchemaParam, true, 'callers get a copy');
  assert.deepEqual(effectiveCapabilities({ id: 'default', baseUrl: 'http://engine.invalid/v1', capabilities: engineCapabilities('llamacpp') }), { jsonSchemaParam: true });
  // A row with no declaration (and no preset address) declares nothing.
  assert.deepEqual(effectiveCapabilities({ id: 'x', baseUrl: 'http://engine.invalid/v1' }), {});
});

test('no vendor host or model literal in the constrained-decoding path', () => {
  for (const file of ['plan-constrained-decoding.cjs', 'planner-plan.cjs']) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.doesNotMatch(src, /api\.openai\.com|anthropic|gemini|gpt-|qwen|llama3|mistral|lemonade/i, file);
    assert.doesNotMatch(src, /managerKind|MODEL_MANAGER_KIND|baseUrl\s*===|\.includes\(['"]http/, `${file} decides from capability data, not engine kind or address`);
  }
});
