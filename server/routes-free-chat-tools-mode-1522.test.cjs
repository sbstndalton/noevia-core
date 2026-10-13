'use strict';

// #1522 (core side): the attachments project a free chat opens on its first use starts on Automatic
// tools, as its comment in routes/projects.cjs already says. Driven through the project routes with
// fakes: no server, storage or model, and synthetic ids only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectRoutes } = require('./routes/projects.cjs');
const diaryExtras = require('./diary-extras.cjs');

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-free-chat-1522-'));
  const PROJECTS = [];
  const store = { getProject: (id) => PROJECTS.find((p) => p.id === id) || null, saveProjects() {} };
  const routes = createProjectRoutes({
    json: (res, status, body) => { res.status = status; res.body = body; },
    readBody: async () => '', readJson: async () => ({}), requestScope: { getStore: () => ({}) }, dispatch: () => {},
    currentWorkspace: () => ({ dir, userId: 'synthetic-user' }), authService: {}, storageClient: {}, documents: {}, documentSources: {},
    rag: {}, fs, path, reasoningEffort: {}, projectAppearance: () => ({}), diaryExtras, PROJECTS, DEFAULT_TOOLBOXES: ['core'],
    sanitizeToolboxes: (v) => (Array.isArray(v) ? v : null), allToolboxes: () => [{ id: 'core' }], getProvider: () => null,
    ensureRolesLoaded() {}, servedCatalogue: async () => [], DEFAULT_PROVIDER_ID: 'default', store,
  });
  return { routes, PROJECTS, dir };
}

test('#1522: a free chat opens its attachments context on Automatic tools with the default set', async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const res = {};
  const url = new URL('http://localhost/api/chats/fixture-chat-1522/context');
  const handled = await h.routes({ method: 'POST' }, res, { path: url.pathname, authn: { user: { id: 'synthetic-user' } }, url });
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(res.body.project.id, 'cowork-chat-context-fixture-chat-1522');
  assert.equal(res.body.project.routing, 'auto');
  assert.equal(res.body.project.toolsMode, 'auto', 'not a Manual list that the web would read as hand-picked');
  assert.deepEqual(res.body.project.toolboxes, ['core']);
});
