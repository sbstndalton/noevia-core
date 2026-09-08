'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  resolveTools,
  toolboxSummaries,
  estimateToolTokens,
  toolCapFor,
  sanitizeToolboxes,
  executeToolCall,
  TOOLBOXES,
} = require('./index.cjs');

// Step 14 turned a module-scope TOOL_DEFS constant into a per-request resolved
// list. The value of the seam is that a project can be handed fewer tools than
// the process knows about — so these tests are mostly about what does NOT get
// sent, which is the part a passing chat would never reveal.

test('an unselected project resolves to the core box', () => {
  const { tools, boxes } = resolveTools({}, 'Qwen3.5-9B-GGUF-UD-Q4_K_XL');
  assert.deepEqual(boxes, ['core']);
  assert.deepEqual(tools.map((t) => t.function.name), ['get_current_time', 'read_project_file']);
});

test('an explicit empty selection sends no tools at all', () => {
  // Distinct from "unset". A user who unticks every box means it, and the chat
  // loop then omits the `tools` key entirely (some OpenAI-compatible servers
  // reject `tools: []`). Conflating the two would make the UI checkbox lie.
  const { tools, boxes } = resolveTools({ toolboxes: [] }, 'any-model');
  assert.deepEqual(boxes, []);
  assert.deepEqual(tools, []);
});

test('a project predating toolboxes still gets core', () => {
  // Upgrading must not silently disarm existing projects, so an absent key is
  // NOT the same as an empty one.
  assert.equal(resolveTools({ name: 'legacy' }, 'model').tools.length, 2);
  assert.equal(resolveTools({ toolboxes: null }, 'model').tools.length, 2);
});

test('an unknown toolbox id is ignored, not fatal', () => {
  // A box disappears when its MCP server goes away. That must degrade to
  // fewer tools, never to a request that throws.
  const { tools, boxes } = resolveTools({ toolboxes: ['core', 'nextcloud-calendar'] }, 'model');
  assert.deepEqual(boxes, ['core']);
  assert.equal(tools.length, 2);
});

test('a selection of only unknown ids yields an empty list', () => {
  const { tools, boxes } = resolveTools({ toolboxes: ['ghost'] }, 'model');
  assert.deepEqual(boxes, []);
  assert.deepEqual(tools, []);
});

test('the cap truncates and reports every dropped tool by name', () => {
  // Synthesise a box larger than the small-model cap by resolving against a
  // stub project; the real registry has only two tools today, so drive the
  // resolver through a temporarily registered oversized box.
  const big = {
    id: 'test-big',
    label: 'Big',
    description: 'oversized fixture',
    source: 'builtin',
    tools: Array.from({ length: 20 }, (_, i) => ({
      type: 'function',
      function: { name: `t${i}`, description: 'x', parameters: { type: 'object', properties: {}, required: [] } },
    })),
  };
  TOOLBOXES.push(big);
  try {
    const small = resolveTools({ toolboxes: ['test-big'] }, 'Gemma-4-E4B-it-GGUF-4b');
    assert.equal(small.cap, 12);
    assert.equal(small.tools.length, 12);
    assert.equal(small.dropped.length, 8);
    // Each dropped entry names the tool AND why it went, so a truncated
    // catalogue is diagnosable from the log alone.
    assert.deepEqual(small.dropped.map((d) => d.split(' ')[0]), ['t12', 't13', 't14', 't15', 't16', 't17', 't18', 't19']);
    assert.match(small.dropped[0], /over 12-tool cap/);

    // Same selection, roomier model: nothing is dropped.
    const large = resolveTools({ toolboxes: ['test-big'] }, 'claude-sonnet-4-5');
    assert.equal(large.cap, 24);
    assert.equal(large.dropped.length, 0);
    assert.equal(large.tools.length, 20);
  } finally {
    TOOLBOXES.pop();
  }
});

test('a tool appearing in two boxes is sent once', () => {
  const dup = { id: 'test-dup', label: 'Dup', description: 'd', source: 'builtin', tools: TOOLBOXES[0].tools };
  TOOLBOXES.push(dup);
  try {
    const { tools } = resolveTools({ toolboxes: ['core', 'test-dup'] }, 'model');
    assert.equal(tools.length, 2);
  } finally {
    TOOLBOXES.pop();
  }
});

test('the cap keys off parameter count in the model id', () => {
  assert.equal(toolCapFor('Qwen3.5-9B-GGUF-UD-Q4_K_XL'), 12);
  assert.equal(toolCapFor('Gemma-4-E4B-it-GGUF-4b'), 12);
  assert.equal(toolCapFor('some-70B-model'), 24);
  // An unrecognised name gets the roomier default: withholding tools is the
  // worse failure.
  assert.equal(toolCapFor('claude-sonnet-4-5'), 24);
  assert.equal(toolCapFor(''), 24);
  assert.equal(toolCapFor(undefined), 24);
});

test('toolbox summaries carry the per-turn cost the UI shows', () => {
  const [core] = toolboxSummaries();
  assert.equal(core.id, 'core');
  assert.equal(core.source, 'builtin');
  assert.equal(core.toolCount, 2);
  // Pinned to a live measurement: the two core tools cost 390 prompt tokens on
  // Qwen3.5-9B, of which ~240 is the fixed tool-calling preamble charged once
  // per request. estimateToolTokens reports only the MARGINAL cost, so per-box
  // numbers stay additive — hence ~150-250 here, not 390.
  assert.ok(
    core.estTokens > 120 && core.estTokens < 280,
    `core box marginal estimate looks wrong: ${core.estTokens}`,
  );
  assert.equal(estimateToolTokens([]), 0);
});

test('sanitizeToolboxes rejects non-arrays, drops unknowns, dedupes', () => {
  assert.equal(sanitizeToolboxes('core'), null);
  assert.equal(sanitizeToolboxes(undefined), null);
  assert.deepEqual(sanitizeToolboxes(['core', 'core', 'nope', 7]), ['core']);
  assert.deepEqual(sanitizeToolboxes([]), []);
});

test('a tool outside the resolved list cannot be executed', () => {
  // The model can name a tool it was never offered — hallucinated, or from a
  // box deselected mid-conversation. It must come back as a correctable
  // message, not run.
  return Promise.all([
    executeToolCall({}, 'get_current_time', '{}', new Set(['read_project_file']))
      .then((r) => assert.match(r, /not enabled for this project/)),
    executeToolCall({}, 'get_current_time', '{}', new Set(['get_current_time']))
      .then((r) => assert.match(r, /^Current time:/)),
    // No allow-set given: unchanged legacy behaviour.
    executeToolCall({}, 'get_current_time', '{}')
      .then((r) => assert.match(r, /^Current time:/)),
  ]);
});
