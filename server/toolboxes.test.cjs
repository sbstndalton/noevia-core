'use strict';
// createToolboxes with everything injected: no server boot, no data dir, no MCP.
// toolbox.test.cjs and tool-permissions.test.cjs still exercise the same code
// through index.cjs, so this file covers the seams that only the factory exposes:
// injected MCP boxes, the server's own read/write verdict, and the executor.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createToolboxes, estimateToolTokens, toolCapFor, TOOL_RESULT_CAP, CORE_TOOLS } = require('./toolboxes.cjs');

const tool = (name, extra = {}) => ({ type: 'function', function: { name, description: 'x'.repeat(extra.chars || 40), parameters: { type: 'object', properties: {} } } });
const box = (id, tools, reads = []) => ({ id, label: id, description: '', source: 'mcp', server: 'nextcloud', tools, reads });

function build(over = {}) {
  const mcpBoxes = over.mcpBoxes || [];
  const mcpTools = new Map();
  for (const b of mcpBoxes) for (const t of b.tools) mcpTools.set(t.function.name, { serverId: 'nextcloud', readOnly: over.readOnly?.[t.function.name] });
  const calls = [];
  const scope = new AsyncLocalStorage();
  const api = createToolboxes({
    boxes: over.boxes || [],
    driveTools: over.driveTools || null,
    kiwixTools: over.kiwixTools || null,
    mcpBoxes: () => mcpBoxes,
    mcpTools: () => mcpTools,
    offered: over.offered || (() => true),
    prefill: over.prefill || { budgetFor: () => null, rateFor: () => 0 },
    scope,
    getProject: (id) => ({ id, files: [] }),
    documentSources: { notice: () => '', readPages: () => { throw new Error('no pages'); } },
    workspace: () => ({ dir: '/nowhere' }),
    executeMcp: async (name, args) => { calls.push({ name, args, project: scope.getStore()?.internalCallProject ?? null }); return `ran ${name}`; },
  });
  return { ...api, calls, scope };
}

test('MCP boxes join the built-ins through the injected accessor, and the offer filter applies to both', () => {
  const t = build({ mcpBoxes: [box('nc-notes', [tool('nc_notes_search_notes')])], offered: (id) => id !== 'core' });
  assert.deepEqual(t.allToolboxes().map((b) => b.id), ['nc-notes']);
  assert.deepEqual(t.toolboxSummaries().map((b) => b.id), ['nc-notes']);
  assert.deepEqual(t.sanitizeToolboxes(['core', 'nc-notes', 'nc-notes', 7]), ['nc-notes']);
});

test('resolveTools sends MCP tools within the cap and budget, first box first', () => {
  const t = build({ mcpBoxes: [box('a', [tool('a_1'), tool('a_2')]), box('b', [tool('b_1')])] });
  const r = t.resolveTools({ toolboxes: ['b', 'a'] }, 'model-9b');
  assert.deepEqual(r.boxes, ['b', 'a']);
  assert.deepEqual(r.tools.map((x) => x.function.name), ['b_1', 'a_1', 'a_2']);
  assert.equal(r.cap, toolCapFor('model-9b'));
  assert.ok(r.estTokens > 240, 'the preamble is charged once when any tool is sent');
});

test('a measured prefill rate replaces the filename guess, clamped to a sane range', () => {
  const slow = build({ prefill: { budgetFor: () => 100, rateFor: () => 0.05 } });
  assert.equal(slow.toolTokenBudgetFor('big-70b'), 1500);
  const fast = build({ prefill: { budgetFor: () => 99999, rateFor: () => 5 } });
  assert.equal(fast.toolTokenBudgetFor('tiny-4b'), 16000);
  const unmeasured = build();
  assert.equal(unmeasured.toolTokenBudgetFor('tiny-4b'), 5000);
  assert.equal(unmeasured.toolTokenBudgetFor('big-70b'), 8000);
});

test("a tool the manifest calls a read is still a write when the MCP server says so", () => {
  const t = build({ mcpBoxes: [box('nc', [tool('nc_read'), tool('nc_lied')], ['nc_read', 'nc_lied'])], readOnly: { nc_read: true, nc_lied: false } });
  assert.equal(t.isWriteTool('nc_read'), false);
  assert.equal(t.isWriteTool('nc_lied'), true, 'a positive "this writes" from the server is never overridden');
  assert.equal(t.isWriteTool('nc_unknown'), true, 'unknown means write');
  assert.equal(t.isWriteTool('get_current_time'), false);
});

test('connected account boxes are offered per user and never appear in the picker', () => {
  const drive = { box: box('gdrive', [tool('drive_search')], ['drive_search']), names: new Set(['drive_search']), connected: (u) => u.id === 'linked', execute: async (u, name) => `${name} as ${u.id}` };
  const t = build({ boxes: [drive.box], driveTools: drive });
  assert.deepEqual(t.connectedBoxes({ id: 'linked' }), ['gdrive']);
  assert.deepEqual(t.connectedBoxes({ id: 'other' }), []);
  assert.deepEqual(t.connectedBoxes(null), []);
  assert.ok(!t.toolboxSummaries().some((b) => b.id === 'gdrive'));
  assert.equal(t.sanitizeToolboxes(['gdrive']).length, 0);
});

test('the executor runs built-ins itself and hands MCP tools on with the project in scope', async () => {
  const t = build({ mcpBoxes: [box('nc', [tool('nc_notes_search_notes')])] });
  assert.match(await t.executeToolCall(null, 'get_current_time', '{}'), /^Current time: .* \| ISO: /);
  assert.match(await t.executeToolCall(null, 'get_current_time', '{"timezone":"Europe/Berlin"}'), /\(Europe\/Berlin\)/);
  assert.match(await t.executeToolCall(null, 'get_current_time', '{"timezone":"Mars/Olympus"}'), /^ERROR: unknown IANA timezone/);
  assert.match(await t.executeToolCall(null, 'read_project_file', 'not json'), /^ERROR: tool arguments were not valid JSON/);
  assert.match(await t.executeToolCall({ id: 'p', files: [] }, 'read_project_file', '{"name":"x.md"}'), /^ERROR: no project file named "x.md"/);
  const big = '#'.repeat(TOOL_RESULT_CAP + 500);
  const out = await t.executeToolCall({ id: 'p', files: [{ name: 'big.md', content: big }] }, 'read_project_file', '{"name":"big.md"}');
  assert.ok(out.endsWith('…[truncated]'));
  assert.equal((out.match(/#/g) || []).length, TOOL_RESULT_CAP, 'the body stops at the cap');
  assert.equal(await t.executeToolCall({ id: 'p' }, 'nc_notes_search_notes', '{"q":"x"}', new Set(['get_current_time'])), 'ERROR: tool "nc_notes_search_notes" is not enabled for this project');
  const ran = await t.scope.run({ authn: { user: { id: 'u' } } }, () => t.executeToolCall({ id: 'proj-1' }, 'nc_notes_search_notes', '{"q":"x"}', new Set(['nc_notes_search_notes'])));
  assert.equal(ran, 'ran nc_notes_search_notes');
  assert.deepEqual(t.calls, [{ name: 'nc_notes_search_notes', args: { q: 'x' }, project: { id: 'proj-1' } }]);
  assert.equal(await t.executeToolCall(null, 'nope', '{}'), 'ERROR: unknown tool "nope"');
});

test('the pure helpers need no factory', () => {
  assert.equal(estimateToolTokens([]), 0);
  assert.equal(estimateToolTokens(null), 0);
  assert.equal(estimateToolTokens(CORE_TOOLS), Math.round(JSON.stringify(CORE_TOOLS).length / 3.6));
  assert.equal(toolCapFor('Qwen3.5-9B'), 12);
  assert.equal(toolCapFor('Qwen3.5-27B'), 24);
  assert.equal(toolCapFor(''), 24);
});
