'use strict';
const skipWasm = !require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
// Guards a wrong test signature (options passed twice makes node:test take the second object as the body, so the body never runs and the
// test reports ok): when the module is there, every guarded body must have run.
let ran = 0;

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
const { automaticBoxesFor, automaticAdditions, orderWithAdditions, wantsWeb, MAX_ADDED, createAutomaticToolsReady } = require('./tools-mode.cjs');

test('automaticBoxesFor: current-information and search questions need Web search', { skip: skipWasm }, () => {

  ran++;
  for (const message of [
    'What are the latest stable versions of Rust and Node LTS? Cite sources.',
    "What's the weather in Oslo today?",
    "Search the web for this week's top news",
    'Look up the current EUR to NOK exchange rate',
    'Read https://example.com/synthetic-page and summarise it',
  ]) assert.deepEqual(automaticBoxesFor(message), ['web-search'], message);
});

test('automaticBoxesFor: bare "current", "online", "recent" and "today\'s" do not reach for the web', () => {
  for (const message of [
    'What is the current through a 10 ohm resistor at 5 V?',
    "Write a poem about today's sunset",
    'Is this course taught online?',
    'Summarise the recent paragraph I wrote above',
    "What's on my calendar this week?".replace('my calendar', 'the calendar'),
  ]) assert.ok(!automaticBoxesFor(message).includes('web-search'), message);
});

test('automaticBoxesFor: a URL is fetched only from a short one-line message, never from a pasted email', { skip: skipWasm }, () => {

  ran++;
  assert.deepEqual(automaticBoxesFor('Summarise https://example.com/synthetic-page'), ['web-search']);
  const email = 'Hi Sam,\nplease find the synthetic invoice at https://example.com/invoice/123 before Friday.\nThanks,\nAlex';
  assert.deepEqual(automaticBoxesFor(email), []);
  assert.equal(wantsWeb(email), false);
  // #1550 review: a word like "latest" inside the pasted text does not let its link be fetched.
  const latest = 'Hi Sam,\nyour latest synthetic invoice is at https://example.com/i/123\nThanks';
  assert.deepEqual(automaticBoxesFor(latest), []);
  assert.equal(wantsWeb(latest), false);
  // Asking for the web by name still adds it.
  assert.equal(wantsWeb(`${latest}\nPlease search the web for this sender.`), true);
  assert.equal(wantsWeb(`Summarise ${'this synthetic page in detail '.repeat(6)}https://example.com/x`), false, 'a long message with a URL is not fetched');
});

test('automaticBoxesFor: beside a Nextcloud box, the web only when the message asks for it by name', () => {
  assert.deepEqual(automaticBoxesFor('Summarise the latest entries in my notes'), ['nextcloud-notes']);
  assert.deepEqual(automaticBoxesFor('What is the latest file in my Nextcloud?'), ['nextcloud-files']);
  assert.deepEqual(automaticBoxesFor('Search the web for the latest news and add it to my Nextcloud notes'), ['nextcloud-notes', 'web-search']);
});

test('automaticBoxesFor: a Nextcloud question needs Nextcloud Files, or the Nextcloud app it names', () => {
  assert.deepEqual(automaticBoxesFor('List my Nextcloud top-level folders.'), ['nextcloud-files']);
  assert.deepEqual(automaticBoxesFor('use your nextcloud tools now'), ['nextcloud-files']);
  assert.deepEqual(automaticBoxesFor('Which files are in my Documents folder?'), ['nextcloud-files']);
  assert.deepEqual(automaticBoxesFor('Search my Nextcloud notes for the synthetic recipe'), ['nextcloud-notes']);
  assert.deepEqual(automaticBoxesFor("What's on my calendar this week?"), ['nextcloud-calendar']);
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
const BOXES = [
  box('core', ['get_current_time'], ['get_current_time']),
  box('web-search', ['tavily_search'], ['tavily_search'], { server: 'synthetic-search' }),
  box('nextcloud-files', ['nc_list', 'nc_delete'], ['nc_list'], { server: 'nextcloud' }),
  box('nextcloud-notes', ['nc_notes_search'], ['nc_notes_search'], { server: 'nextcloud' }),
  box('nextcloud-calendar', ['nc_cal_list'], ['nc_cal_list'], { server: 'nextcloud' }),
  box('nextcloud-tasks', ['nc_tasks_list'], ['nc_tasks_list'], { server: 'nextcloud' }),
  box('nextcloud-mail', ['nc_mail_send'], [], { server: 'nextcloud' }),
  box('gdrive', ['drive_search'], ['drive_search']),
];
const READS = new Set(BOXES.flatMap((b) => b.reads));
const additions = (message, extra = {}) => automaticAdditions({ message, base: ['core'], boxes: BOXES, connectorBoxes: new Set(['gdrive']),
  isWriteTool: (name) => !READS.has(name), privateData: true, ...extra });

test('automaticAdditions: offered boxes the base lacks, with a read tool, at most MAX_ADDED', () => {
  assert.deepEqual(additions('latest Rust release?'), ['web-search']);
  assert.deepEqual(additions('latest Rust release?', { base: ['core', 'web-search'] }), [], 'already carried');
  assert.deepEqual(additions('latest Rust release?', { boxes: BOXES.filter((b) => b.id !== 'web-search') }), [], 'not offered here');
  assert.deepEqual(additions('Check my mail inbox'), [], 'a box of writes only is never added');
  assert.deepEqual(additions('Search my Google Drive files'), ['nextcloud-files'], 'a connector box is never added; "my ... files" means Nextcloud');
  const many = additions('Compare my Nextcloud notes, my calendar and my tasks with my files');
  assert.equal(many.length, MAX_ADDED);
  assert.deepEqual(many, ['nextcloud-notes', 'nextcloud-calendar', 'nextcloud-tasks']);
});

test('automaticAdditions: user-data boxes only for a local model; Web search for any provider', () => {
  assert.deepEqual(additions('List my Nextcloud folders', { privateData: false }), []);
  assert.deepEqual(additions('What are the latest Rust releases?', { privateData: false }), ['web-search']);
});

test('automaticAdditions: readiness is asked only for the boxes the message names, and a failing check adds nothing', () => {
  const asked = [];
  assert.deepEqual(additions('List my Nextcloud folders', { ready: (b) => { asked.push(b.id); return true; } }), ['nextcloud-files']);
  assert.deepEqual(asked, ['nextcloud-files']);
  assert.deepEqual(additions('List my Nextcloud folders', { ready: () => { throw new Error('synthetic'); } }), []);
  assert.deepEqual(additions('hello', { ready: () => { throw new Error('never asked'); } }), []);
});

test('orderWithAdditions: the default and Project documents boxes first, then additions, then the rest', () => {
  assert.deepEqual(orderWithAdditions(['core', 'gdrive', 'project-docs', 'web-search'], ['web-search'], ['core', 'project-docs']), ['core', 'project-docs', 'web-search', 'gdrive']);
  assert.deepEqual(orderWithAdditions(['gdrive', 'web-search'], ['web-search'], ['core']), ['web-search', 'gdrive'], 'routing dropped core: nothing is invented');
  assert.deepEqual(orderWithAdditions(['core', 'gdrive'], [], ['core']), ['core', 'gdrive']);
});

test('createAutomaticToolsReady: a Nextcloud box needs the account\'s own connection on an allowed origin, read once per request', () => {
  const storages = {
    'connected-user': { kind: 'nextcloud', username: 'synthetic', secret: 'synthetic-app-password', baseUrl: 'https://cloud.example.test' },
    'webdav-user': { kind: 'webdav', username: 'synthetic', secret: 'synthetic-app-password', baseUrl: 'https://cloud.example.test' },
    'other-origin': { kind: 'nextcloud', username: 'synthetic', secret: 'synthetic-app-password', baseUrl: 'https://elsewhere.example.test' },
    'local-user': { kind: 'local' },
    'no-secret': { kind: 'nextcloud', username: 'synthetic', baseUrl: 'https://cloud.example.test' },
  };
  const reads = [];
  const ready = createAutomaticToolsReady({
    getStorage: (id) => { reads.push(id); if (id === 'broken') throw new Error('synthetic'); return storages[id] || { kind: 'local' }; },
    originAllowed: (url) => url === 'https://cloud.example.test',
  });
  const nc = { server: 'nextcloud' };
  const forConnected = ready({ id: 'connected-user' });
  assert.equal(forConnected(nc), true);
  assert.equal(forConnected({ server: 'nextcloud', id: 'nextcloud-notes' }), true);
  assert.deepEqual(reads, ['connected-user'], 'the storage is read once per request, however many Nextcloud boxes are asked about');
  assert.equal(ready({ id: 'webdav-user' })(nc), true, 'a WebDAV connection to Nextcloud carries the same app password');
  assert.equal(ready({ id: 'other-origin' })(nc), false, 'an origin the operator did not allow is never sent the credential');
  assert.equal(ready({ id: 'local-user' })(nc), false);
  assert.equal(ready({ id: 'no-secret' })(nc), false);
  assert.equal(ready({ id: 'broken' })(nc), false, 'a storage read that fails adds nothing');
  assert.equal(ready(null)(nc), false);
  reads.length = 0;
  assert.equal(ready({ id: 'local-user' })({ server: 'synthetic-search' }), true, 'a box on another server needs nothing from the account');
  assert.deepEqual(reads, [], 'and the storage is not read for it');
});

test('#1646: isPrivateDataBox is an allow-list: only core, web and offline-reference boxes may go to a hybrid cloud route', () => {
  const tm = require('./tools-mode.cjs');
  for (const id of ['core', 'web-search', 'web-crawl', 'offline-wikipedia']) assert.equal(tm.isPrivateDataBox(id), false, id);
  for (const id of ['nextcloud-files', 'nextcloud-mail', 'project-docs', 'gdrive', 'diary', 'a-box-added-later', '', undefined]) assert.equal(tm.isPrivateDataBox(id), true, String(id));
  assert.ok(tm.PRIVATE_CORE_TOOLS.has('read_project_file') && !tm.PRIVATE_CORE_TOOLS.has('get_current_time'));
});

test.after(() => { if (!skipWasm) assert.equal(ran, 2, 'a wasm-guarded test body did not run'); });
