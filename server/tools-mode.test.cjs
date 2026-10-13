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

// #1550: what an Automatic turn adds for its message. Pure, over synthetic box records.
const { automaticBoxesFor, automaticPool, automaticAdditions, MAX_ADDED, createAutomaticToolsReady } = require('./tools-mode.cjs');

test('automaticBoxesFor: current-information and search questions need Web search', () => {
  for (const message of [
    'What are the latest stable versions of Rust and Node LTS? Cite sources.',
    "What's the weather in Oslo today?",
    'Search the web for this week\'s top news',
    'Look up the current EUR to NOK exchange rate',
    'Read https://example.com/synthetic-page and summarise it',
  ]) assert.deepEqual(automaticBoxesFor(message), ['web-search'], message);
});

test('automaticBoxesFor: a Nextcloud question needs Nextcloud Files, or the Nextcloud app it names', () => {
  assert.deepEqual(automaticBoxesFor('List my Nextcloud top-level folders.'), ['nextcloud-files']);
  assert.deepEqual(automaticBoxesFor('use your nextcloud tools now'), ['nextcloud-files']);
  assert.deepEqual(automaticBoxesFor('Which files are in my Documents folder?'), ['nextcloud-files']);
  assert.deepEqual(automaticBoxesFor('Search my Nextcloud notes for the synthetic recipe'), ['nextcloud-notes']);
  assert.deepEqual(automaticBoxesFor("What's on my calendar on Friday?"), ['nextcloud-calendar']);
  assert.deepEqual(automaticBoxesFor('Add a reminder to my Nextcloud tasks'), ['nextcloud-tasks']);
  assert.deepEqual(automaticBoxesFor('Find the synthetic report in my Nextcloud files and my notes'), ['nextcloud-notes', 'nextcloud-files']);
});

test('automaticBoxesFor: chit-chat, general topics and other connectors need nothing extra', () => {
  for (const message of ['hello', 'Thanks, that helps a lot.', 'Summarise the plan for the garden.', 'Write a function that searches an array',
    'Find the synthetic budget sheet in Google Drive.', 'How do calendars work in the Julian system?', '', '   ']) {
    assert.deepEqual(automaticBoxesFor(message), [], JSON.stringify(message));
  }
  assert.deepEqual(automaticBoxesFor(undefined), []);
  assert.deepEqual(automaticBoxesFor({ text: 'latest news' }), [], 'only a string message is read');
});

const box = (id, tools, reads, extra = {}) => ({ id, tools: tools.map((name) => ({ type: 'function', function: { name } })), reads, ...extra });
const POOL_BOXES = [
  box('core', ['get_current_time'], ['get_current_time']),
  box('web-search', ['tavily_search'], ['tavily_search'], { server: 'synthetic-search' }),
  box('nextcloud-files', ['nc_list', 'nc_delete'], ['nc_list'], { server: 'nextcloud' }),
  box('nextcloud-mail-send', ['nc_send'], [], { server: 'nextcloud' }),
  box('gdrive', ['drive_search'], ['drive_search']),
];
const READS = new Set(POOL_BOXES.flatMap((b) => b.reads));
const isWrite = (name) => !READS.has(name);

test('automaticPool: offered boxes with a read tool, ready for the account; never a connector or a box of writes only', () => {
  const pool = automaticPool({ boxes: POOL_BOXES, connectorBoxes: new Set(['gdrive']), isWriteTool: isWrite });
  assert.deepEqual([...pool], ['core', 'web-search', 'nextcloud-files']);
  const noNextcloud = automaticPool({ boxes: POOL_BOXES, connectorBoxes: new Set(['gdrive']), isWriteTool: isWrite, ready: (b) => b.server !== 'nextcloud' });
  assert.deepEqual([...noNextcloud], ['core', 'web-search'], 'a Nextcloud box waits for the account\'s Nextcloud connection');
  const throws = automaticPool({ boxes: POOL_BOXES, connectorBoxes: new Set(), isWriteTool: isWrite, ready: () => { throw new Error('synthetic'); } });
  assert.deepEqual([...throws], [], 'a readiness check that fails adds nothing');
  assert.deepEqual([...automaticPool({ boxes: null, connectorBoxes: new Set(), isWriteTool: isWrite })], []);
});

test('automaticAdditions: only pooled boxes the base lacks, in the order the message needs them, at most MAX_ADDED', () => {
  const pool = new Set(['web-search', 'nextcloud-files', 'nextcloud-notes', 'nextcloud-calendar', 'nextcloud-tasks']);
  assert.deepEqual(automaticAdditions({ message: 'latest Rust release?', base: ['core'], pool }), ['web-search']);
  assert.deepEqual(automaticAdditions({ message: 'latest Rust release?', base: ['core', 'web-search'], pool }), [], 'already carried');
  assert.deepEqual(automaticAdditions({ message: 'latest Rust release?', base: ['core'], pool: new Set(['nextcloud-files']) }), [], 'not offered here');
  const many = automaticAdditions({ message: 'Compare my Nextcloud notes, my calendar and my tasks with the latest news', base: [], pool });
  assert.equal(many.length, MAX_ADDED);
  assert.deepEqual(many, ['nextcloud-notes', 'nextcloud-calendar', 'nextcloud-tasks']);
});

test('createAutomaticToolsReady: a Nextcloud box needs the account\'s own connection on an allowed origin; others are ready', () => {
  const storages = {
    'connected-user': { kind: 'nextcloud', username: 'synthetic', secret: 'synthetic-app-password', baseUrl: 'https://cloud.example.test' },
    'webdav-user': { kind: 'webdav', username: 'synthetic', secret: 'synthetic-app-password', baseUrl: 'https://cloud.example.test' },
    'other-origin': { kind: 'nextcloud', username: 'synthetic', secret: 'synthetic-app-password', baseUrl: 'https://elsewhere.example.test' },
    'local-user': { kind: 'local' },
    'no-secret': { kind: 'nextcloud', username: 'synthetic', baseUrl: 'https://cloud.example.test' },
  };
  const ready = createAutomaticToolsReady({
    getStorage: (id) => { if (id === 'broken') throw new Error('synthetic'); return storages[id] || { kind: 'local' }; },
    originAllowed: (url) => url === 'https://cloud.example.test',
  });
  const nc = { server: 'nextcloud' };
  assert.equal(ready({ id: 'connected-user' }, nc), true);
  assert.equal(ready({ id: 'webdav-user' }, nc), true, 'a WebDAV connection to Nextcloud carries the same app password');
  assert.equal(ready({ id: 'other-origin' }, nc), false, 'an origin the operator did not allow is never sent the credential');
  assert.equal(ready({ id: 'local-user' }, nc), false);
  assert.equal(ready({ id: 'no-secret' }, nc), false);
  assert.equal(ready({ id: 'broken' }, nc), false, 'a storage read that fails adds nothing');
  assert.equal(ready(null, nc), false);
  assert.equal(ready(null, { server: 'synthetic-search' }), true, 'a box on another server needs nothing from the account here');
  assert.equal(ready({ id: 'local-user' }, { id: 'core' }), true);
});
