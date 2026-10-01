'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SELECTION_SCHEMA, selectionConstraint, requestSelection, selectionCause } = require('./selection-constraint.cjs');
const { validateProposal } = require('../../../experiments/system-one/skills-mcp/contract.cjs');

test('schema is sent only to providers that declare jsonSchemaParam; thinking is off with it', () => {
  const on = selectionConstraint({ provider: { capabilities: { jsonSchemaParam: true } }, model: 'any-model' });
  assert.equal(on.fields.response_format.json_schema.schema, SELECTION_SCHEMA);
  assert.deepEqual(on.fields.chat_template_kwargs, { enable_thinking: false });
  for (const provider of [null, {}, { capabilities: {} }, { capabilities: { jsonSchemaParam: false } }]) {
    const c = selectionConstraint({ provider, model: 'm' });
    assert.deepEqual(c.fields, {}); assert.equal(c.applied, false);
  }
});

test('reasoning_effort low only where the capability data says so', () => {
  const caps = { reasoningEffortParam: true, reasoningEffortModels: ['listed'] };
  assert.equal(selectionConstraint({ provider: { capabilities: caps }, model: 'listed' }).fields.reasoning_effort, 'low');
  assert.equal(selectionConstraint({ provider: { capabilities: caps }, model: 'other' }).fields.reasoning_effort, undefined);
  assert.equal(selectionConstraint({ provider: { capabilities: { reasoningEffortParam: true } }, model: 'x' }).fields.reasoning_effort, 'low');
  assert.equal(selectionConstraint({ provider: { capabilities: { reasoningEffortParam: false } }, model: 'x' }).fields.reasoning_effort, undefined);
});

test('a valid proposal satisfies the schema keys and the contract validator accepts it', () => {
  assert.deepEqual(Object.keys(SELECTION_SCHEMA.properties).sort(), ['abstain', 'confidence', 'scores', 'selected']);
  const rows = [{ id: 'skill:a' }];
  assert.equal(validateProposal({ selected: ['skill:a'], scores: { 'skill:a': 0.9 }, confidence: 0.9, abstain: false }, rows,
    { maxSkills: 1, maxBoxes: 3, minConfidence: 0.5, minScore: 0.5 }), null);
});

test('requestSelection falls back once on 400/422/501 only', async () => {
  const constraint = selectionConstraint({ provider: { capabilities: { jsonSchemaParam: true } }, model: 'm' });
  const seen = [];
  const r = await requestSelection({ payload: { a: 1 }, constraint, send: async p => { seen.push(p); if (p.response_format) throw Object.assign(new Error('x'), { status: 422 }); return 'ok'; } });
  assert.deepEqual([r.result, r.fallback, r.status], ['ok', true, 422]);
  assert.equal(seen[1].response_format, undefined);
  await assert.rejects(requestSelection({ payload: {}, constraint, send: async () => { throw Object.assign(new Error('x'), { status: 500 }); } }));
});

test('selectionCause is text-free', () => {
  assert.equal(selectionCause({ content: '', finishReason: 'length' }), 'truncated');
  assert.equal(selectionCause({ content: '  ', finishReason: 'stop' }), 'empty-content');
  assert.equal(selectionCause({ content: 'x', parsed: null }), 'invalid-json');
  assert.equal(selectionCause({ content: '{}', parsed: {} }), null);
});
