'use strict';
const skipWasm = !require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
// Guards a wrong test signature (options passed twice makes node:test take the second object as the body, so the body never runs and the
// test reports ok): when the module is there, every guarded body must have run.
let ran = 0;
// The toolbox ids a request carries (#237, #354, #1006). The per-turn view of permitted tools is the Rust front's since
// sbstndalton/noevia#2202 round 2 (noevia-rs bins/noevia-server toolbox_routes.rs, tested there). Synthetic only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectedToolboxIds } = require('./toolboxes-permitted.cjs');

test('selectedToolboxIds (#354): the shared union chat.cjs, this catalogue and the picker must all agree on', { skip: skipWasm }, () => {
  ran++;
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

test('#1006: Tools Automatic uses the default set; Manual (or no mode) the project list', { skip: skipWasm }, () => {
  ran++;
  const { projectToolboxIds, selectedToolboxIds } = require('./toolboxes-permitted.cjs');
  const defaults = ['core'];
  assert.deepEqual(projectToolboxIds({ toolsMode: 'auto', toolboxes: ['core', 'web', 'storage'] }, defaults), ['core']);
  assert.deepEqual(projectToolboxIds({ toolsMode: 'manual', toolboxes: ['web'] }, defaults), ['web']);
  assert.deepEqual(projectToolboxIds({ toolboxes: [] }, defaults), [], 'an empty hand-picked list is honoured');
  assert.deepEqual(projectToolboxIds({}, defaults), ['core']);
  assert.deepEqual(projectToolboxIds(null, defaults), ['core']);
  assert.deepEqual(selectedToolboxIds({ project: { toolsMode: 'auto', toolboxes: ['web'] }, defaultToolboxes: defaults, connectorBoxes: new Set(['gdrive']), connected: ['gdrive'] }), ['core', 'gdrive']);
});

test('#1006 review: an Automatic project keeps the Project documents box its first upload added', { skip: skipWasm }, () => {
  ran++;
  const { projectToolboxIds } = require('./toolboxes-permitted.cjs');
  const { applyProjectDocsDefault, BOX } = require('./project-docs-default.cjs');
  const project = { id: 'proj-syn', toolsMode: 'auto', files: [{ name: 'synthetic.txt', content: 'x' }] };
  assert.equal(applyProjectDocsDefault(project, { offered: () => true, defaults: ['core'], hadUploads: false }), true);
  assert.deepEqual(projectToolboxIds(project, ['core']), ['core', BOX]);
  assert.deepEqual(projectToolboxIds({ toolsMode: 'auto', toolboxes: ['core', BOX] }, ['core']), ['core'], 'only when the upload default added it');
  assert.deepEqual(projectToolboxIds({ toolsMode: 'auto', toolboxes: ['web'], docsToolboxDefaulted: true }, ['core']), ['core']);
});

test.after(() => { if (!skipWasm) assert.equal(ran, 3, 'a wasm-guarded test body did not run'); });
