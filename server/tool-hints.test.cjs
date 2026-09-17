'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { withHint, hintTool, MAX_HINT } = require('./tool-hints.cjs');

const tool = (description) => ({ type: 'function', function: { name: 'nc_calendar_create_todo', description, parameters: { type: 'object' } } });

test('a hint is appended after the server’s own words, never instead of them', () => {
  const out = withHint(tool('Create a VTODO in a calendar.'), 'Use this to add a task.');
  assert.equal(out.function.description, 'Create a VTODO in a calendar. Use this to add a task.');
  assert.equal(out.function.name, 'nc_calendar_create_todo');
  assert.deepEqual(out.function.parameters, { type: 'object' });
});

test('hinting does not mutate the tool the MCP client holds', () => {
  const original = tool('Create a VTODO.');
  const out = withHint(original, 'Use this to add a task.');
  assert.equal(original.function.description, 'Create a VTODO.', 'the cached tool is untouched');
  assert.notEqual(out, original);
  assert.notEqual(out.function, original.function);
});

test('applying a hint twice does not grow the description', () => {
  const once = withHint(tool('Create a VTODO.'), 'Use this to add a task.');
  const twice = withHint(once, 'Use this to add a task.');
  assert.equal(twice.function.description, once.function.description);
  assert.equal(twice, once, 'nothing to do means nothing is copied');
});

test('a tool with no description of its own still gets the hint alone', () => {
  assert.equal(withHint(tool(undefined), 'Use this to add a task.').function.description, 'Use this to add a task.');
  assert.equal(withHint(tool(''), 'Use this to add a task.').function.description, 'Use this to add a task.');
});

test('an empty, missing or non-string hint changes nothing', () => {
  const original = tool('Create a VTODO.');
  for (const hint of ['', '   ', null, undefined, 42, {}]) assert.equal(withHint(original, hint), original, String(hint));
  assert.equal(withHint(null, 'x'), null);
  assert.equal(withHint({ type: 'function' }, 'x').function, undefined);
});

test('a hint is bounded, so a manifest typo cannot eat the tool budget', () => {
  const out = withHint(tool('Create a VTODO.'), 'x'.repeat(MAX_HINT * 10));
  assert.equal(out.function.description.length, 'Create a VTODO. '.length + MAX_HINT);
});

test('hintTool reads the box’s map, and leaves unnamed tools alone', () => {
  const box = { hints: { nc_calendar_create_todo: 'Use this to add a task.' } };
  assert.match(hintTool(box, tool('Create a VTODO.')).function.description, /add a task/);
  const other = { type: 'function', function: { name: 'nc_calendar_list_events', description: 'List events.' } };
  assert.equal(hintTool(box, other), other, 'a tool the box did not name is untouched');
  assert.equal(hintTool({}, other), other);
  assert.equal(hintTool(null, other), other);
});

test('the Tasks box actually carries hints for every tool it binds', () => {
  const { MCP_TOOLBOX_MANIFEST } = require('./index.cjs');
  const box = MCP_TOOLBOX_MANIFEST.find((b) => b.id === 'nextcloud-tasks');
  assert.ok(box.hints, 'the reported problem was the 4B not calling this box');
  assert.deepEqual(Object.keys(box.hints).sort(), [...box.tools].sort());
  // Every hint has to say one of the words a person actually uses.
  for (const [name, hint] of Object.entries(box.hints)) {
    assert.match(hint, /task|to-do|reminder/i, name);
    assert.ok(hint.length <= MAX_HINT, name);
  }
  // And no hint names a tool the box does not bind.
  for (const name of Object.keys(box.hints)) assert.ok(box.tools.includes(name), name);
});

test('no box hints a tool it does not bind', () => {
  const { MCP_TOOLBOX_MANIFEST } = require('./index.cjs');
  for (const box of MCP_TOOLBOX_MANIFEST) {
    for (const name of Object.keys(box.hints || {})) {
      assert.ok(box.tools.includes(name), `${box.id} hints ${name}, which it does not bind`);
    }
  }
});
