'use strict';

// #1522 (where a new project starts) and #1550 (where an Automatic turn goes when its routed model
// cannot take tools). Pure functions over synthetic model names; no model is loaded or run.

const test = require('node:test');
const assert = require('node:assert/strict');
const { toolsModeOf, initialToolsMode, toolCapableRoute } = require('./tools-mode.cjs');

const roles = { fast: 'fast-model', smart: 'smart-model', code: 'code-model' };

/** A template gate over synthetic names: `capable` are the models whose template takes tools. */
function gate(capable) {
  const asked = [];
  return { asked, allowsTools: async (model) => { asked.push(model); return capable.has(model); } };
}

test('toolsModeOf: an explicit toolsMode wins; without one a list means Manual and no list means Automatic', () => {
  assert.equal(toolsModeOf({ toolsMode: 'auto', toolboxes: ['core', 'web'] }), 'auto');
  assert.equal(toolsModeOf({ toolsMode: 'manual' }), 'manual');
  assert.equal(toolsModeOf({ toolboxes: ['core'] }), 'manual', 'a record stored before toolsMode keeps its list');
  assert.equal(toolsModeOf({ name: 'no list' }), 'auto');
  assert.equal(toolsModeOf(null), 'auto', 'a free chat with no project uses the default set');
  assert.equal(toolsModeOf({ toolsMode: 'bogus', toolboxes: ['core'] }), 'manual', 'an unknown value is ignored');
});

test('initialToolsMode (#1522): a new project is Automatic unless the request chose Manual', () => {
  assert.equal(initialToolsMode({ name: 'Plan' }), 'auto', 'the web sends neither toolboxes nor toolsMode');
  assert.equal(initialToolsMode({}), 'auto');
  assert.equal(initialToolsMode(undefined), 'auto');
  assert.equal(initialToolsMode({ toolsMode: 'auto' }), 'auto');
  assert.equal(initialToolsMode({ toolsMode: 'manual' }), 'manual');
  assert.equal(initialToolsMode({ toolboxes: ['core', 'web'] }), 'manual', 'an explicit list is a hand pick, not ignored');
  assert.equal(initialToolsMode({ toolboxes: ['core'], toolsMode: 'auto' }), 'auto', 'an explicit toolsMode wins over a list');
  assert.equal(initialToolsMode({ toolsMode: 'sideways' }), 'auto', 'an invalid value falls back to the default');
});

test('#1550: a routed model that can take tools is kept, and no other model is asked', async () => {
  const g = gate(new Set(['fast-model']));
  assert.deepEqual(await toolCapableRoute({ model: 'fast-model', routedRole: 'fast', roles, allowsTools: g.allowsTools }),
    { rerouted: false, model: 'fast-model', role: 'fast' });
  assert.deepEqual(g.asked, ['fast-model']);
});

test('#1550: a Fast model whose template cannot take tools moves the turn to Smart', async () => {
  const g = gate(new Set(['smart-model']));
  assert.deepEqual(await toolCapableRoute({ model: 'fast-model', routedRole: 'fast', roles, allowsTools: g.allowsTools }),
    { rerouted: true, model: 'smart-model', role: 'smart' });
});

test('#1550: when Smart cannot take tools either, Code is tried next', async () => {
  const g = gate(new Set(['code-model']));
  assert.deepEqual(await toolCapableRoute({ model: 'fast-model', routedRole: 'fast', roles, allowsTools: g.allowsTools }),
    { rerouted: true, model: 'code-model', role: 'code' });
  assert.deepEqual(g.asked, ['fast-model', 'smart-model', 'code-model']);
});

test('#1550: the routed role is never asked again, and Fast is the last resort', async () => {
  const g = gate(new Set(['fast-model']));
  assert.deepEqual(await toolCapableRoute({ model: 'smart-model', routedRole: 'smart', roles, allowsTools: g.allowsTools }),
    { rerouted: true, model: 'fast-model', role: 'fast' });
  assert.deepEqual(g.asked, ['smart-model', 'code-model', 'fast-model']);
});

test('#1550: with no tool-capable role the routed model is kept, so the caller can say tools are off', async () => {
  const g = gate(new Set());
  assert.deepEqual(await toolCapableRoute({ model: 'fast-model', routedRole: 'fast', roles, allowsTools: g.allowsTools }),
    { rerouted: false, model: 'fast-model', role: 'fast' });
  assert.deepEqual(g.asked, ['fast-model', 'smart-model', 'code-model']);
});

test('#1550: a template of unknown capability counts as able (the gate allows it), so nothing moves', async () => {
  const g = gate(new Set());
  const allowsTools = async (model) => { g.asked.push(model); return true; };
  assert.equal((await toolCapableRoute({ model: 'fast-model', routedRole: 'fast', roles, allowsTools })).rerouted, false);
  assert.deepEqual(g.asked, ['fast-model']);
});

test('#1550: a missing role, or one that names the routed model, is skipped without being asked', async () => {
  const g = gate(new Set());
  const sparse = { fast: 'fast-model', smart: undefined, code: 'fast-model' };
  assert.equal((await toolCapableRoute({ model: 'fast-model', routedRole: 'fast', roles: sparse, allowsTools: g.allowsTools })).rerouted, false);
  assert.deepEqual(g.asked, ['fast-model']);
  assert.equal((await toolCapableRoute({ model: 'fast-model', routedRole: 'fast', roles: undefined, allowsTools: g.allowsTools })).rerouted, false);
});

// #1550: only a verdict that picks a tool counts as "the turn needs a tool".
const { gateSaysToolNeeded } = require('./tools-mode.cjs');

test('gateSaysToolNeeded: a rule or the decision service picking a tool counts; none, unavailable and no gate do not', () => {
  assert.equal(gateSaysToolNeeded({ decision: { tool: 'tavily_search', mode: 'prefetch', args: { query: 'x' } }, source: 'rule' }), true);
  assert.equal(gateSaysToolNeeded({ decision: { tool: 'synthetic_search', mode: 'require' }, source: 'decision' }), true);
  assert.equal(gateSaysToolNeeded({ decision: 'none', source: 'none' }), false, 'chit-chat');
  assert.equal(gateSaysToolNeeded({ decision: 'none', source: 'none', reason: 'deadline' }), false, 'timed out');
  assert.equal(gateSaysToolNeeded({ decision: 'none', source: 'none', reason: 'error' }), false, 'errored');
  assert.equal(gateSaysToolNeeded({ source: 'none' }), false, 'no decision at all');
  assert.equal(gateSaysToolNeeded(null), false, 'no gate: the feature is off');
  assert.equal(gateSaysToolNeeded(undefined), false);
});
