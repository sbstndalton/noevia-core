'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PLAN_ARTIFACT_SCHEMA, planConstraint, requestPlanArtifact } = require('./plan-constrained-decoding.cjs');
const { createFeatures } = require('./features.cjs');

const local = { id: 'default', baseUrl: 'http://engine:8080/v1' };
const base = { enabled: true, provider: local, managerKind: 'llamacpp', defaultProviderId: 'default', model: 'qwen3.5-4b' };
const payload = { model: 'qwen3.5-4b', messages: [{ role: 'user', content: 'x' }] };
const fake = (...replies) => { const calls = []; const send = async p => { calls.push(p); const r = replies.shift(); if (r instanceof Error) throw r; return r; }; return { send, calls }; };

test('the feature flag exists, is off, and is unavailable until a server caller exists', () => {
  const f = createFeatures({ env: { NOEVIA_FEATURE_CONSTRAINED_PLAN_DECODING: 'true' } });
  assert.equal(createFeatures({ env: {} }).enabled('constrainedPlanDecoding'), false);
  assert.equal(f.enabled('constrainedPlanDecoding'), false, 'unavailable wins over the env pin');
  assert.match(f.describe().find(x => x.name === 'constrainedPlanDecoding').unavailable, /no server-side plan generator/);
});

test('flag off: no constraint fields', async () => {
  const c = planConstraint({ ...base, enabled: false });
  assert.deepEqual(c.fields, {});
  const { send, calls } = fake({ ok: true, body: 'a' });
  const r = await requestPlanArtifact({ payload, send, constraint: c });
  assert.deepEqual(calls, [payload]);
  assert.equal(r.constraint.applied, false);
  assert.equal(r.constraint.reason, 'flag_off');
});

test('flag on, local llama.cpp provider: json_schema is sent', async () => {
  const { send, calls } = fake({ ok: true, body: 'a' });
  const r = await requestPlanArtifact({ payload, send, constraint: planConstraint(base) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].response_format.type, 'json_schema');
  assert.deepEqual(calls[0].response_format.json_schema.schema, PLAN_ARTIFACT_SCHEMA);
  assert.equal(calls[0].messages, payload.messages);
  assert.equal(r.constraint.applied, true);
  assert.equal(r.constraint.fallback, false);
});

test('remote, external and non-llama.cpp providers never get the fields', () => {
  for (const provider of [{ id: 'openai', baseUrl: 'https://api.openai.com/v1' }, { id: 'default', external: true }, { id: 'default', kind: 'chatgpt-oauth' }, null]) {
    const c = planConstraint({ ...base, provider });
    assert.deepEqual(c.fields, {});
    assert.equal(c.reason, 'not_llamacpp_provider');
  }
  assert.equal(planConstraint({ ...base, managerKind: 'lemonade' }).applied, false);
});

test('harmony reasoning models and thinking mode fall back with a reason', () => {
  assert.equal(planConstraint({ ...base, model: 'gpt-oss-20b' }).reason, 'reasoning_model');
  assert.equal(planConstraint({ ...base, thinking: true }).reason, 'thinking_enabled');
  assert.deepEqual(planConstraint({ ...base, model: 'gpt-oss-20b' }).fields, {});
});

test('an engine 400 falls back to unconstrained generation and records why', async () => {
  const logs = [];
  const { send, calls } = fake({ ok: false, status: 400 }, { ok: true, body: 'plain' });
  const r = await requestPlanArtifact({ payload, send, constraint: planConstraint(base), log: m => logs.push(m) });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].response_format);
  assert.equal(calls[1].response_format, undefined);
  assert.equal(r.body, 'plain');
  assert.deepEqual(r.constraint, { applied: false, mode: null, reason: 'engine_rejected_400', fallback: true });
  assert.equal(logs.length, 1);
});

test('a thrown 400 also falls back; other failures propagate without a retry', async () => {
  const bad = Object.assign(new Error('bad'), { status: 400 });
  const a = fake(bad, { ok: true, body: 'p' });
  assert.equal((await requestPlanArtifact({ payload, send: a.send, constraint: planConstraint(base) })).constraint.fallback, true);
  const down = Object.assign(new Error('down'), { status: 503 });
  const b = fake(down);
  await assert.rejects(requestPlanArtifact({ payload, send: b.send, constraint: planConstraint(base) }), /down/);
  assert.equal(b.calls.length, 1);
});
