'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { handle, searchCode, outlineFile, resolveInRoot } = require('./server.cjs');
const { outline, enclosing } = require('./symbols.cjs');

const call = (name, args) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const textOf = (res) => res.result.content[0].text;

test('initialize and tools/list answer the three supported methods', () => {
  assert.equal(handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }).result.serverInfo.name, 'noevia-repo-index');
  const names = handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ['outline_file', 'search_code']);
  assert.equal(handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' }).error.code, -32601);
});

test('a notification is owed no reply', () => {
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

// The tools return one shape: a header line, then tab-separated rows.
function rowsOf(text) {
  const lines = text.split('\n');
  const keys = lines[1].split('\t');
  return lines.slice(2).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [keys[i], v])));
}

test('search finds text that is really in the tree and names the enclosing declaration', () => {
  // Regression guard: ripgrep inherited this process's stdin once and searched
  // the JSON-RPC stream instead of the repo, reporting zero matches for text
  // that was plainly there.
  const out = textOf(call('search_code', { query: 'TOOL_PREFILL_TARGET_MS', k: 40, glob: 'server/*.cjs' }));
  assert.match(out, /matches\. Tab-separated|of \d+ matches/);
  const hits = rowsOf(out);
  assert.ok(hits.length > 0, 'a constant that exists must be found');
  assert.ok(hits.every((h) => h.file.startsWith('server/')), 'the glob is honoured');
  assert.ok(hits.every((h) => !h.file.startsWith('./')), "rg's './' prefix is stripped");
  assert.ok(hits.some((h) => h.file === 'server/toolboxes.cjs' && h.symbol.startsWith('createToolboxes')));
});

test('a query with no matches is an answer, not an error', () => {
  // Built at runtime so this file cannot match its own needle.
  const needle = ['zzz', 'absent', 'needle', Date.now()].join('_');
  assert.equal(textOf(call('search_code', { query: needle })), '[0 matches]');
});

test('a path outside the repository is refused', () => {
  const res = call('outline_file', { path: '../../../etc/passwd' });
  assert.equal(res.result.isError, true);
  assert.match(textOf(res), /outside the repository/);
  assert.throws(() => resolveInRoot('/etc/passwd'), /outside the repository/);
  assert.equal(resolveInRoot('server/index.cjs').endsWith('/server/index.cjs'), true);
});

test('outlining toolboxes reports the top-level factory enclosing its budget helper', () => {
  const out = textOf(call('outline_file', { path: 'server/toolboxes.cjs' }));
  const raw = require('fs').readFileSync(require('path').resolve(__dirname, '../../server/toolboxes.cjs'), 'utf8');
  assert.ok(out.length < raw.length / 10, `outline ${out.length} vs file ${raw.length}`);
  assert.match(out, /advisory/, 'the brace-counted end line is declared advisory');
  const budget = rowsOf(out).map((d) => ({ ...d, line: Number(d.line), endLine: Number(d.endLine) }))
    .find((d) => d.name === 'createToolboxes');
  assert.ok(budget, 'the enclosing top-level factory is listed');
  // The range must actually contain the function, or the outline is a trap.
  const body = raw.split('\n').slice(budget.line - 1, budget.endLine).join('\n');
  assert.match(body, /^function createToolboxes/);
  assert.match(body, /function toolTokenBudgetFor/);
});

test('an unknown tool is a protocol error, a failing tool is content', () => {
  assert.equal(handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } }).error.code, -32602);
  assert.equal(call('search_code', {}).result.isError, true);
});

test('outline handles python and reports a class by dedent', () => {
  const src = 'import os\n\n\nclass Thing:\n    def go(self):\n        return 1\n\n\ndef top():\n    return 2\n';
  const decls = outline(src);
  assert.deepEqual(decls.map((d) => d.name), ['Thing', 'top']);
  assert.equal(enclosing(src, 5).name, 'Thing');
});


test('nested functions are reported inside their top-level enclosing factory', () => {
  const src = 'function factory() {\n  function nested() {\n    return 1;\n  }\n  return nested;\n}\n';
  assert.deepEqual(outline(src), [{ name: 'factory', line: 1, endLine: 6 }]);
  assert.equal(enclosing(src, 3).name, 'factory');
});
