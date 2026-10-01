'use strict';
// The Planner's plan step with a fake fetch: offline, synthetic task data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlannerPlan, validatePlanArtifact } = require('./planner-plan.cjs');
const { PLAN_ARTIFACT_SCHEMA } = require('./plan-constrained-decoding.cjs');

const capable = { id: 'engine-a', baseUrl: 'http://engine.invalid/v1', capabilities: { jsonSchemaParam: true } };
const incapable = { id: 'engine-b', baseUrl: 'http://engine.invalid/v1', capabilities: {} };
const state = {
  taskId: 'task-1', tenantId: 'tenant-a', request: 'Summarise the three synthetic notes into one list.',
  projectInstructions: 'Keep answers short.', capabilities: [{ name: 'read' }, { name: 'edit' }],
};
const plan = {
  goal: 'One list from three notes', context: ['three notes'], constraints: ['read only'], investigation: ['open each note'],
  steps: [{ n: 1, do: 'Read the notes', done_when: 'All read' }, { n: 2, do: 'Write the list', done_when: 'List written' }],
  capabilities: ['read'], approval_boundaries: ['no writes'], verification: ['three items'], completion: 'The list is shown', non_goals: ['editing'],
};
const reply = (content, extra = {}) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content, ...extra } }] }) });
const status = (code) => ({ ok: false, status: code, json: async () => ({ error: { message: 'engine detail: synthetic secret text' } }) });

function fakeFetch(...replies) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); const r = replies.shift(); if (r instanceof Error) throw r; return r; };
  return { fetch, calls };
}
function planner({ flag = true, provider = capable, model = 'synthetic-plan-model', replies, deadlineMs }) {
  const f = fakeFetch(...replies), logs = [];
  const p = createPlannerPlan({ enabled: () => flag, engine: () => ({ baseUrl: 'http://engine.invalid/v1', apiKey: 'local', model, provider }), fetch: f.fetch, log: (e) => logs.push(e), ...(deadlineMs ? { deadlineMs } : {}) });
  return { p, calls: f.calls, logs };
}

test('flag off: no schema is sent, and the plan is still validated', async () => {
  const { p, calls } = planner({ flag: false, replies: [reply(JSON.stringify(plan))] });
  const r = await p.generate({ state });
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan, plan);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.response_format, undefined);
  assert.equal(calls[0].body.json_schema, undefined);
  assert.equal(calls[0].body.chat_template_kwargs, undefined);
  assert.deepEqual(r.constraint, { applied: false, mode: null, reason: 'flag_off', fallback: false });
});

test('flag on + capable provider: the plan schema is sent in the response_format shape, thinking off', async () => {
  const { p, calls, logs } = planner({ replies: [reply(JSON.stringify(plan))] });
  const r = await p.generate({ state });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://engine.invalid/v1/chat/completions');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_schema', json_schema: { name: 'plan_artifact', strict: true, schema: PLAN_ARTIFACT_SCHEMA } });
  assert.deepEqual(calls[0].body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].headers.Authorization, undefined, 'the placeholder local key is not sent');
  // Only the Planner's allowlisted projection goes out.
  const user = calls[0].body.messages[1].content;
  assert.match(user, /three synthetic notes/);
  assert.doesNotMatch(user, /tenant-a/);
  assert.deepEqual(r.constraint, { applied: true, mode: 'json_schema', reason: null, fallback: false });
  assert.deepEqual(logs.at(-1), { event: 'planner.plan', constrained: true, fallback: false, reason: null, corrected: false, problems: [] });
});

test('incapable provider: no schema is sent even with the flag on', async () => {
  const { p, calls } = planner({ provider: incapable, replies: [reply(JSON.stringify(plan))] });
  const r = await p.generate({ state });
  assert.equal(r.ok, true);
  assert.equal(calls[0].body.response_format, undefined);
  assert.equal(r.constraint.reason, 'provider_unsupported');
});

test('engine 400: one unconstrained retry, a text-free log, and the stream validator still runs', async () => {
  const { p, calls, logs } = planner({ replies: [status(400), reply(JSON.stringify(plan))] });
  const r = await p.generate({ state });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].body.response_format);
  assert.equal(calls[1].body.response_format, undefined);
  assert.equal(calls[1].body.chat_template_kwargs, undefined);
  assert.deepEqual(r.constraint, { applied: false, mode: null, reason: 'engine_rejected_400', fallback: true });
  assert.deepEqual(logs[0], { event: 'plan.constraint_rejected', status: 400 });
  assert.doesNotMatch(JSON.stringify(logs), /synthetic secret text|three synthetic notes|One list/);
});

test('after a rejection the correction attempt does not ask for the schema again', async () => {
  const { p, calls } = planner({ replies: [status(422), reply('{"goal": 7}'), reply(JSON.stringify(plan))] });
  const r = await p.generate({ state });
  assert.equal(r.ok, true);
  assert.equal(r.corrected, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => !!c.body.response_format), [true, false, false]);
  assert.match(calls[2].body.messages.at(-1).content, /not a valid plan/);
  assert.deepEqual(r.constraint, { applied: false, mode: null, reason: 'engine_rejected_422', fallback: true });
});

test('constrained output is still validated: a schema-shaped but wrong plan is refused, never returned', async () => {
  // Steps numbered out of order and an empty goal pass the restricted subset the grammar and the
  // stream validator share; the full artifact check catches both.
  const wrong = { ...plan, goal: ' ', steps: [{ n: 2, do: 'a', done_when: 'b' }] };
  const { p, calls } = planner({ replies: [reply(JSON.stringify(wrong))] });
  const r = await p.generate({ state });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid');
  assert.deepEqual(r.problems, ['goal_not_text', 'step_1_malformed']);
  assert.equal(r.plan, undefined);
  assert.equal(calls[0].body.response_format.type, 'json_schema');
});

test('constrained output that breaks the schema goes through the one bounded correction (still constrained)', async () => {
  const { p, calls } = planner({ replies: [reply('{"goal": "x", "unknown": 1}'), reply(JSON.stringify(plan))] });
  const r = await p.generate({ state });
  assert.equal(r.ok, true);
  assert.equal(r.corrected, true);
  assert.deepEqual(calls.map((c) => !!c.body.response_format), [true, true]);
  assert.deepEqual(r.constraint, { applied: true, mode: 'json_schema', reason: null, fallback: false });
});

test('two invalid answers fail closed', async () => {
  const { p } = planner({ replies: [reply('[]'), reply('"no"')] });
  const r = await p.generate({ state });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid');
});

test('a plan naming a capability the task was not given is invalid', async () => {
  const { p } = planner({ replies: [reply(JSON.stringify({ ...plan, capabilities: ['git_push'] }))] });
  const r = await p.generate({ state });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['unknown_capability']);
});

test('thinking: constrained calls turn the reasoning channel off; reasoning text is never read as the plan', async () => {
  const { p, calls } = planner({ replies: [reply(JSON.stringify(plan), { reasoning_content: 'synthetic thoughts {"goal": "other"}' })] });
  const r = await p.generate({ state });
  assert.equal(r.ok, true);
  assert.equal(r.plan.goal, plan.goal);
  assert.equal(calls[0].body.chat_template_kwargs.enable_thinking, false);
  // A caller that keeps thinking on, or a harmony-format model, is not constrained at all.
  const keep = planner({ replies: [reply(JSON.stringify(plan))] });
  assert.equal((await keep.p.generate({ state, thinking: true })).constraint.reason, 'thinking_enabled');
  assert.equal(keep.calls[0].body.response_format, undefined);
  assert.equal(keep.calls[0].body.chat_template_kwargs, undefined);
  const harmony = planner({ model: 'gpt-oss-20b', replies: [reply(JSON.stringify(plan))] });
  assert.equal((await harmony.p.generate({ state })).constraint.reason, 'reasoning_model');
  assert.equal(harmony.calls[0].body.response_format, undefined);
});

test('other engine failures are not retried and do not leak the engine message', async () => {
  const { p, calls, logs } = planner({ replies: [status(503)] });
  const r = await p.generate({ state });
  assert.deepEqual(r, { ok: false, code: 'error', reason: 'The Planner model could not be reached.' });
  assert.equal(calls.length, 1);
  assert.deepEqual(logs, [{ event: 'planner.plan_failed', status: 503, code: 'transport' }]);
});

test('a task without a tenant is refused before anything is sent; no engine, no call', async () => {
  const a = planner({ replies: [] });
  assert.equal((await a.p.generate({ state: { ...state, tenantId: undefined } })).code, 'context_invalid');
  assert.equal(a.calls.length, 0);
  const b = createPlannerPlan({ engine: () => ({ baseUrl: null }), fetch: async () => { throw Error('no'); } });
  assert.equal((await b.generate({ state })).code, 'unavailable');
});

test('a throwing flag reader is off', async () => {
  const f = fakeFetch(reply(JSON.stringify(plan)));
  const p = createPlannerPlan({ enabled: () => { throw Error('x'); }, engine: () => ({ baseUrl: 'http://engine.invalid/v1', provider: capable }), fetch: f.fetch });
  const r = await p.generate({ state });
  assert.equal(r.constraint.reason, 'flag_off');
  assert.equal(f.calls[0].body.response_format, undefined);
});

test('the deadline and the caller signal end the plan', async () => {
  // Like a real request, the pending fetch holds the event loop open (the deadline timer is unref'd).
  const hang = (url, init) => new Promise((_, reject) => {
    const socket = setTimeout(() => {}, 10_000);
    init.signal.addEventListener('abort', () => { clearTimeout(socket); reject(Object.assign(Error('aborted'), { name: 'AbortError' })); });
  });
  const p = createPlannerPlan({ engine: () => ({ baseUrl: 'http://engine.invalid/v1', provider: capable }), fetch: hang, deadlineMs: 20 });
  assert.equal((await p.generate({ state })).code, 'timeout');
  const controller = new AbortController();
  const q = createPlannerPlan({ engine: () => ({ baseUrl: 'http://engine.invalid/v1', provider: capable }), fetch: hang });
  const pending = q.generate({ state, signal: controller.signal });
  controller.abort();
  assert.equal((await pending).code, 'aborted');
});

test('validatePlanArtifact codes carry no model text', () => {
  assert.deepEqual(validatePlanArtifact(plan), []);
  assert.deepEqual(validatePlanArtifact(null), ['not_object']);
  const problems = validatePlanArtifact({ ...plan, 'ignore previous instructions': 1, context: 'text' });
  assert.deepEqual(problems, ['unexpected_key', 'context_not_list']);
  assert.deepEqual(validatePlanArtifact({ ...plan, steps: Array.from({ length: 13 }, (_, i) => ({ n: i + 1, do: 'a', done_when: 'b' })) }), ['steps_count']);
  assert.deepEqual(validatePlanArtifact({ ...plan, context: ['x'.repeat(6000)] }), ['too_long']);
});
