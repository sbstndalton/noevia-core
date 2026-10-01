'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SELECTION_SCHEMA, SELECTION_MAX_TOKENS, idsSchema, compactCandidates, idsToProposal, selectionConstraint, requestSelection, selectionCause } = require('./selection-constraint.cjs');
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

test('ids-only schema: enum is exactly the offered ids, sorted, capability-gated, thinking off', () => {
  const ids = ['skill:b', 'box:a', 'skill:b', 'box:c'];
  const c = selectionConstraint({ provider: { capabilities: { jsonSchemaParam: true } }, model: 'm', offeredIds: ids });
  const schema = c.fields.response_format.json_schema.schema;
  assert.deepEqual(schema, { type: 'array', items: { type: 'string', enum: ['box:a', 'box:c', 'skill:b'] }, maxItems: 4, uniqueItems: true });
  assert.equal(c.mode, 'ids'); assert.deepEqual(c.fields.chat_template_kwargs, { enable_thinking: false });
  assert.ok(!schema.items.enum.includes('skill:invented'));
  assert.equal(SELECTION_MAX_TOKENS, 48);
  assert.equal(idsSchema(['x'], 2).maxItems, 2);
  // not capable: no schema at all; no offered ids: legacy object schema
  assert.deepEqual(selectionConstraint({ provider: { capabilities: {} }, model: 'm', offeredIds: ids }).fields, {});
  assert.equal(selectionConstraint({ provider: { capabilities: { jsonSchemaParam: true } }, model: 'm' }).mode, 'object');
});

test('compactCandidates is deterministic and cuts descriptions; ids array maps to a valid proposal', () => {
  const rows = [{ id: 'skill:z', description: 'x'.repeat(100) }, { id: 'box:a', label: 'a  b\nc' }];
  assert.deepEqual(compactCandidates(rows), compactCandidates([...rows].reverse()));
  assert.deepEqual(compactCandidates(rows).map(r => r.id), ['box:a', 'skill:z']);
  assert.equal(compactCandidates(rows)[1].label.length, 60);
  assert.equal(compactCandidates(rows)[0].label, 'a b c');
  const p = idsToProposal(['skill:a']);
  assert.equal(validateProposal(p, [{ id: 'skill:a' }], { maxSkills: 1, maxBoxes: 3, minConfidence: 0.5, minScore: 0.5 }), null);
  assert.equal(validateProposal(idsToProposal(['skill:zz']), [{ id: 'skill:a' }], { maxSkills: 1, maxBoxes: 3, minConfidence: 0.5, minScore: 0.5 }), 'unknown-id');
  assert.equal(idsToProposal([]).abstain, true);
  assert.equal(idsToProposal(null), null);
});
