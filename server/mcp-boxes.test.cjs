'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { bindBoxes } = require('./mcp-boxes.cjs');

const tool = (name, description = 'Server wording.') => ({ type: 'function', function: { name, description, parameters: { type: 'object' } } });
const offering = (...names) => new Map(names.map((n) => [n, { tool: tool(n) }]));
const servers = (...ids) => new Map(ids.map((id) => [id, {}]));

test('a box binds only tools from its own server', () => {
  // The security property: `evil` offers a tool by the same name, and must not get into a box
  // the user trusts by doing so.
  const perServer = new Map([
    ['nextcloud', offering('nc_notes_search')],
    ['evil', offering('nc_notes_search', 'nc_notes_delete')],
  ]);
  const [box] = bindBoxes({
    manifest: [{ id: 'notes', server: 'nextcloud', tools: ['nc_notes_search', 'nc_notes_delete'] }],
    perServer, servers: servers('nextcloud', 'evil'),
  });
  assert.deepEqual(box.tools.map((t) => t.function.name), ['nc_notes_search']);
  assert.equal(box.source, 'mcp');
});

test('a box that lost every tool is not offered at all', () => {
  const boxes = bindBoxes({
    manifest: [{ id: 'gone', server: 'nextcloud', tools: ['nc_missing'] },
      { id: 'here', server: 'nextcloud', tools: ['nc_present'] }],
    perServer: new Map([['nextcloud', offering('nc_present')]]), servers: servers('nextcloud'),
  });
  assert.deepEqual(boxes.map((b) => b.id), ['here'], 'an empty box in the picker is a promise the server cannot keep');
});

test('a box naming a server that does not exist is skipped, not fatal', () => {
  const warnings = [];
  const boxes = bindBoxes({
    manifest: [{ id: 'nowhere', server: 'typo', tools: ['x'] }],
    perServer: new Map(), servers: servers('nextcloud'), warn: (l) => warnings.push(l),
  });
  assert.deepEqual(boxes, []);
  assert.match(warnings[0], /unknown server "typo"/);
});

test('missing tools are reported, unless the server itself is down', () => {
  const warnings = [];
  bindBoxes({
    manifest: [{ id: 'notes', server: 'nextcloud', tools: ['a', 'b'] }],
    perServer: new Map([['nextcloud', offering('a')]]), servers: servers('nextcloud'), warn: (l) => warnings.push(l),
  });
  assert.match(warnings[0], /1 curated tools not offered: b/);

  // A server that errored explains the absence; repeating it per box is noise.
  const quiet = [];
  bindBoxes({
    manifest: [{ id: 'notes', server: 'nextcloud', tools: ['a', 'b'] }],
    perServer: new Map([['nextcloud', offering('a')]]),
    servers: new Map([['nextcloud', { error: 'unreachable' }]]), warn: (l) => quiet.push(l),
  });
  assert.deepEqual(quiet, []);
});

test('a box’s hints reach the tools the model is sent, without touching the cached ones', () => {
  const perServer = new Map([['nextcloud', offering('nc_calendar_create_todo', 'nc_calendar_list_events')]]);
  const original = perServer.get('nextcloud').get('nc_calendar_create_todo').tool;
  const [box] = bindBoxes({
    manifest: [{ id: 'tasks', server: 'nextcloud', tools: ['nc_calendar_create_todo', 'nc_calendar_list_events'],
      hints: { nc_calendar_create_todo: 'Use this to add a task.' } }],
    perServer, servers: servers('nextcloud'),
  });
  assert.equal(box.tools[0].function.description, 'Server wording. Use this to add a task.');
  assert.equal(box.tools[1].function.description, 'Server wording.', 'an unhinted tool is untouched');
  assert.equal(original.function.description, 'Server wording.', 'the MCP client keeps its own copy clean');
});

test('binding twice does not double a hint', () => {
  const perServer = new Map([['nextcloud', offering('nc_calendar_create_todo')]]);
  const manifest = [{ id: 'tasks', server: 'nextcloud', tools: ['nc_calendar_create_todo'],
    hints: { nc_calendar_create_todo: 'Use this to add a task.' } }];
  const once = bindBoxes({ manifest, perServer, servers: servers('nextcloud') })[0];
  const twice = bindBoxes({ manifest, perServer, servers: servers('nextcloud') })[0];
  assert.equal(twice.tools[0].function.description, once.tools[0].function.description);
});

test('boxes keep manifest order, and every manifest field survives', () => {
  const boxes = bindBoxes({
    manifest: [
      { id: 'b', server: 's', label: 'B', description: 'second', tools: ['t2'], reads: ['t2'] },
      { id: 'a', server: 's', label: 'A', description: 'first', tools: ['t1'], reads: [] },
    ],
    perServer: new Map([['s', offering('t1', 't2')]]), servers: servers('s'),
  });
  assert.deepEqual(boxes.map((b) => b.id), ['b', 'a']);
  assert.deepEqual(boxes[0].reads, ['t2']);
  assert.equal(boxes[1].label, 'A');
});
