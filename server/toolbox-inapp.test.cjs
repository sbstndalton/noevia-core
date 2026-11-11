'use strict';
// #615 (round 9): the composer tools menu is fed by /api/toolboxes/permitted, which left out the
// `inApp` flag /api/toolboxes carried, so every MCP-backed in-app box stayed English. The flag now
// comes from one helper; this asserts that EVERY server path that hands toolboxes to the client
// carries it for EVERY in-app box, through the real route factory, so the paths cannot drift again.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isInAppBox } = require('./toolbox-flags.cjs');
const { buildInAppBoxes } = require('../tests/server/toolbox-inapp-fixture.cjs');

const fixture = buildInAppBoxes();
const IN_APP_IDS = fixture.allToolboxes().map((b) => b.id);

test('the fixture covers the real manifest: diary, project docs, web, Nextcloud, plus the built-ins', () => {
  for (const id of ['core', 'diary', 'project-docs', 'web-search', 'web-crawl', 'nextcloud-files', 'nextcloud-sharing', 'offline-wikipedia', 'gdrive']) assert.ok(IN_APP_IDS.includes(id), id);
});

// The front composes /api/toolboxes/permitted and the picker from the chat process's facts and its own discovery, and flags a box
// in-app by the same rule (noevia-rs mcp_discovery.rs compose, differential-tested there): built in, or bound from the curated
// manifest. This asserts the rule for every box noevia ships.
test('every box noevia ships is in-app, a third party box never is', () => {
  for (const b of fixture.allToolboxes()) assert.equal(isInAppBox(b), true, b.id);
  const foreign = { id: 'their-box', label: 'Theirs', description: 'x', source: 'mcp', tools: [{ type: 'function', function: { name: 'their_tool' } }] };
  assert.equal(isInAppBox(foreign), false);
  assert.equal(isInAppBox(null), false);
});
