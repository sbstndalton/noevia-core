'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { familyOf, hasHarmonyReasoning, quirksOf, resolveSamplingRecommendation, toIniOptions, FAMILIES } = require('./sampling-recommendation.cjs');
const { fields } = require('./llamacpp-presets.cjs');

test('family matching is table driven, and specific families win over the base architecture', () => {
  const cases = { 'gpt-oss-20b': 'gpt-oss', 'unsloth/gpt_oss:20b': 'gpt-oss', 'DeepSeek-R1-Distill-Qwen-7B': 'deepseek-r1',
    'Qwen3-30B-A3B-GGUF:Q4_K_M': 'qwen3', 'Qwen3.5-4B-UD-Q8_K_XL': 'qwen3.5', 'Qwen3.5-9B-UD-Q4_K_XL': 'qwen3.5',
    'gemma-4-E2B_q4_0-it': 'gemma-4', 'gemma-4-E4B-it-qat-UD-Q4_K_XL': 'gemma-4', 'Llama-3.1-8B-Instruct': 'llama-3', 'gemma-3-27b-it': 'gemma-3',
    'Devstral-Small': 'devstral', 'Phi-4-reasoning': 'phi-4', 'Qwen2.5-7B': null, 'unknown-model': null, '': null };
  for (const [name, id] of Object.entries(cases)) assert.equal(familyOf(name)?.id ?? null, id, name);
  assert.equal(hasHarmonyReasoning('gpt-oss-20b'), true);
  assert.equal(hasHarmonyReasoning('gptossy-model'), false);
  assert.deepEqual(quirksOf('nothing'), {});
  assert.equal(quirksOf('gpt-oss-20b').reasoningEffort, 'low');
});

test('every family value converts to a models.ini key the preset store accepts', () => {
  for (const family of FAMILIES) {
    const options = toIniOptions(family.values);
    assert.ok(Object.keys(options).length > 0, family.id);
    for (const [key, value] of Object.entries(options)) assert.ok(fields[key].valid(value), family.id + ' ' + key + '=' + value);
  }
});

test('a source generation_config wins as a whole over the family table', () => {
  const r = resolveSamplingRecommendation({ model: 'Qwen3-8B', sourceValues: { temperature: 0.7, top_p: 0.8 }, sourceProvenance: { revision: 'r' } });
  assert.equal(r.tier, 'model-card'); assert.equal(r.source, 'generation_config.json');
  assert.deepEqual(r.values, { temperature: 0.7, top_p: 0.8 });
  assert.deepEqual(r.provenance, { revision: 'r' }); assert.equal(r.familyId, 'qwen3');
});

test('the family table applies without a source claim, and invalid source values are ignored', () => {
  for (const bad of [null, {}, { temperature: 9 }, { top_p: 0 }, { temperature: 'hot' }, { min_p: 2 }]) {
    const r = resolveSamplingRecommendation({ model: 'gemma-3-27b-it', sourceValues: bad });
    assert.equal(r.tier, 'family'); assert.deepEqual(r.values, { temperature: 1, top_p: 0.95, top_k: 64, min_p: 0 });
    assert.match(r.source, /Gemma 3 family table/);
  }
  const partial = resolveSamplingRecommendation({ model: 'Qwen3-8B', sourceValues: { temperature: 9, top_k: 20 } });
  assert.deepEqual(partial.values, { top_k: 20 }); assert.equal(partial.tier, 'model-card');
});

test('an unknown model falls back to the task preset, which carries no values for general chat', () => {
  const general = resolveSamplingRecommendation({ model: 'mystery-1b' });
  assert.equal(general.tier, 'preset'); assert.deepEqual(general.values, {}); assert.equal(general.familyId, null);
  const coding = resolveSamplingRecommendation({ model: 'mystery-1b', presetId: 'coding' });
  assert.deepEqual(coding.values, { temperature: 0.2, top_p: 0.9, repeat_penalty: 1.05 });
  assert.equal(resolveSamplingRecommendation({ model: 'mystery-1b', presetId: 'nope' }).tier, 'preset');
});

test('ini conversion uses llama-server names, rounds, and drops invalid entries', () => {
  assert.deepEqual(toIniOptions({ temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, repeat_penalty: 1.05, extra: 1 }),
    { temp: '0.6', 'top-p': '0.95', 'top-k': '20', 'min-p': '0', 'repeat-penalty': '1.05' });
  assert.deepEqual(toIniOptions({ temperature: 5, top_k: -1, top_p: NaN }), {});
});

test('Gemma 4 and Qwen3.5 use their own card values, not Gemma 3 or Qwen3', () => {
  for (const name of ['gemma-4-E2B_q4_0-it', 'gemma-4-E4B-it-qat-UD-Q4_K_XL']) {
    const r = resolveSamplingRecommendation({ model: name });
    assert.equal(r.tier, 'family'); assert.deepEqual(r.values, { temperature: 1, top_p: 0.95, top_k: 64 });
  }
  for (const name of ['Qwen3.5-4B-UD-Q8_K_XL', 'Qwen3.5-9B-UD-Q4_K_XL']) {
    const r = resolveSamplingRecommendation({ model: name });
    assert.equal(r.familyId, 'qwen3.5'); assert.deepEqual(r.values, { temperature: 1, top_p: 0.95, top_k: 20, min_p: 0 });
  }
  assert.equal(resolveSamplingRecommendation({ model: 'Qwen3-8B' }).values.temperature, 0.6);
});

test('the recommendation carries stable ids next to the English display strings (#565)', () => {
  const family = resolveSamplingRecommendation({ model: 'Qwen3.5-4B' });
  assert.equal(family.tier, 'family'); assert.equal(family.sourceId, 'family-table');
  assert.equal(family.familyId, 'qwen3.5'); assert.equal(family.familyLabel, 'Qwen3.5');
  assert.equal(family.noteId, 'thinking-mode');
  assert.equal(family.source, 'Qwen3.5 family table', 'the English strings stay for older clients');
  assert.equal(family.note, 'thinking-mode values');
  const gemma = resolveSamplingRecommendation({ model: 'gemma-4-E2B-it' });
  assert.equal(gemma.familyLabel, 'Gemma 4'); assert.equal(gemma.noteId, null);
  const card = resolveSamplingRecommendation({ model: 'Qwen3-8B', sourceValues: { temperature: 0.7 } });
  assert.equal(card.sourceId, 'generation-config'); assert.equal(card.noteId, null);
  const preset = resolveSamplingRecommendation({ model: 'unknown-model' });
  assert.equal(preset.sourceId, 'task-preset'); assert.equal(preset.presetId, 'general');
});
