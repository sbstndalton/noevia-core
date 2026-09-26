'use strict';
// #237: the per-turn view of permitted tools. Synthetic boxes only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computePermittedTools, createTtlCache, selectedToolboxIds } = require('./toolboxes-permitted.cjs');

const fn = (name, description = '') => ({ type: 'function', function: { name, description, parameters: {} } });
const BOXES = [
  { id: 'core', label: 'Core', description: 'Built-ins', source: 'builtin', tools: [fn('get_current_time')], reads: ['get_current_time'] },
  { id: 'web-search', label: 'Web search', description: 'Search the web', source: 'mcp', tools: [fn('tavily_search')] },
  { id: 'nextcloud-notes', label: 'Notes', description: 'Notes', source: 'mcp', tools: [fn('nc_notes_search_notes'), fn('nc_notes_create_note')] },
  { id: 'diary', label: 'Diary', description: 'Diary', source: 'mcp', tools: [fn('diary_read')] },
  { id: 'gdrive', label: 'Google Drive', description: 'Drive', source: 'builtin', tools: [fn('gdrive_search')] },
];
const WRITES = new Set(['nc_notes_create_note']);
function input(overrides = {}) {
  return {
    user: { id: 'u-member', role: 'member' }, project: { id: 'p1', toolboxes: ['core', 'web-search'] }, mode: 'chat',
    boxes: BOXES, manifest: [{ id: 'nextcloud-calendar', label: 'Calendar', description: 'Calendar' }],
    defaultToolboxes: ['core'], connectorBoxes: new Set(['gdrive']), connected: [],
    oauthServerIds: new Set(['nextcloud-notes']), accountReady: () => true,
    policyMode: (_u, name, write) => (name === 'tavily_search' ? 'ask' : write ? 'ask' : 'allow'),
    isWriteTool: (name) => WRITES.has(name), diaryEnabled: true, harnessEnabled: true, repositories: ['demo'],
    ...overrides,
  };
}
const byId = (boxes) => Object.fromEntries(boxes.map((b) => [b.id, b]));

test('reads are allowed, writes and Ask reads need approval, and the project selection is marked active', () => {
  const boxes = byId(computePermittedTools(input()));
  assert.equal(boxes.core.tools[0].permission, 'allowed');
  assert.equal(boxes.core.active, true);
  assert.equal(boxes['web-search'].tools[0].permission, 'needs-approval', 'a read set to Ask still asks');
  const notes = Object.fromEntries(boxes['nextcloud-notes'].tools.map((t) => [t.name, t]));
  assert.equal(notes.nc_notes_search_notes.permission, 'allowed');
  assert.equal(notes.nc_notes_create_note.permission, 'needs-approval', 'writes always pass the approval card');
  assert.equal(boxes['nextcloud-notes'].active, false, 'available but not selected: offered for a turn, not on by default');
});

test('a blocked tool is unavailable with a reason, and a tool policy is read for this account only', () => {
  const seen = [];
  const boxes = byId(computePermittedTools(input({ policyMode: (u, name) => { seen.push(u); return name === 'get_current_time' ? 'block' : 'allow'; } })));
  assert.deepEqual(boxes.core.tools[0], { name: 'get_current_time', description: '', write: false, permission: 'unavailable', reason: 'Blocked in your tool permissions.' });
  assert.ok(seen.every((u) => u === 'u-member'));
});

test('an unconnected connector, a signed-out OAuth service, and a disabled Diary are unavailable with reasons', () => {
  const boxes = byId(computePermittedTools(input({ accountReady: () => false, diaryEnabled: false })));
  assert.equal(boxes.gdrive.state, 'unavailable');
  assert.match(boxes.gdrive.reason, /Connect/);
  assert.equal(boxes['nextcloud-notes'].state, 'unavailable');
  assert.ok(boxes['nextcloud-notes'].tools.every((t) => t.permission === 'unavailable'), 'an unavailable box offers nothing, even its reads');
  assert.equal(boxes.diary.state, 'unavailable');
  const connected = byId(computePermittedTools(input({ connected: ['gdrive'] })));
  assert.equal(connected.gdrive.state, 'available');
  assert.equal(connected.gdrive.active, true, 'a connected account box is on for every chat');
});

test('configured but undiscovered services are listed as unavailable and never offered', () => {
  const boxes = byId(computePermittedTools(input()));
  assert.deepEqual([boxes['nextcloud-calendar'].state, boxes['nextcloud-calendar'].tools.length], ['unavailable', 0]);
});

test('the coding harness: Cowork-only, admin-only, harness on, project and repository required', () => {
  const code = (o) => byId(computePermittedTools(input(o))).code;
  assert.match(code({}).reason, /Cowork/);
  assert.match(code({ mode: 'cowork' }).reason, /administrators/, 'a member never gets code tools');
  const admin = { id: 'u-admin', role: 'admin' };
  assert.match(code({ mode: 'cowork', user: admin, harnessEnabled: false }).reason, /off/);
  assert.match(code({ mode: 'cowork', user: admin, project: null }).reason, /project/);
  assert.match(code({ mode: 'cowork', user: admin, repositories: [] }).reason, /repository/);
  const on = code({ mode: 'cowork', user: admin });
  assert.equal(on.state, 'available');
  assert.deepEqual(on.tools.map((t) => t.permission), ['allowed', 'needs-approval', 'needs-approval']);
});

test('selectedToolboxIds (#354): the shared union chat.cjs, this catalogue and the picker must all agree on', () => {
  const connectorBoxes = new Set(['gdrive']);
  // A connector id can end up stored on an older/hand-edited project even though
  // sanitizeToolboxes normally strips it; the union still strips it from the base list and adds
  // it back exactly once, from `connected`, never from the project's own list.
  assert.deepEqual(
    selectedToolboxIds({ project: { toolboxes: ['core', 'gdrive'] }, defaultToolboxes: ['core'], connectorBoxes, connected: ['gdrive'] }),
    ['core', 'gdrive'],
  );
  assert.deepEqual(
    selectedToolboxIds({ project: { toolboxes: ['core'] }, defaultToolboxes: ['core'], connectorBoxes, connected: [] }),
    ['core'],
  );
  // No project (a free chat with no explicit choice) falls back to the operator default, same as
  // a project's own empty selection would not.
  assert.deepEqual(
    selectedToolboxIds({ project: null, defaultToolboxes: ['core'], connectorBoxes, connected: ['gdrive'] }),
    ['core', 'gdrive'],
  );
});

test('a free chat (no project) uses the default selection', () => {
  const boxes = byId(computePermittedTools(input({ project: null })));
  assert.equal(boxes.core.active, true);
  assert.equal(boxes['web-search'].active, false);
});

test('the TTL cache expires and evicts', () => {
  let t = 0;
  const cache = createTtlCache({ ttlMs: 100, now: () => t, max: 2 });
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  t = 101;
  assert.equal(cache.get('a'), undefined);
  cache.set('a', 1); cache.set('b', 2); cache.set('c', 3);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), 3);
});
