'use strict';
// #1079: a chat or project with Context: High is served by its model's `<model>-long` profile; Low
// (the default) by the model itself. Roles and the stored pick keep naming the model. Synthetic
// fixtures; no network. The pick is Rust's (dav-parse.wasm long_profile); here the fixture
// generator's independent reference stands in for it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { createLongProfiles } = require('./long-profile.cjs');
const longRef = require('../tools/gen-long-profile-fixtures.cjs');

const BASE = 'Synthetic-12B-it', LONG = 'Synthetic-12B-it-long';
const reference = createLongProfiles({ log: () => {}, decide: { pairs: longRef.refPairs, section: longRef.refSection, pick: longRef.refPick } });

async function send(t, { project, catalogue = [{ name: BASE, labels: [], longVariant: LONG, longLoaded: false }], roles = null, longProfiles = reference, provider = undefined }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-ctx-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const replies = [], upstream = [];
  const fetch = async (url, init) => { upstream.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null }); return { ok: false, status: 500, json: async () => ({}), text: async () => '', body: null }; };
  const res = new EventEmitter(); res.writeHead = () => {}; res.write = (c) => { replies.push({ sse: String(c) }); }; res.end = () => { res.emit('finish'); };
  const rows = { default: { id: 'default', label: 'Local', baseUrl: 'http://fixture.invalid' }, 'cloud-a': { id: 'cloud-a', label: 'Synthetic Cloud', baseUrl: 'https://cloud.invalid', external: true } };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {}, diaryEnabled: () => false },
    crypto: require('node:crypto'), path, fs, fetch, HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', assets: [], toolboxes: [], provider, ...project }),
    skillsIndexFor: () => [], getProvider: (id) => rows[id], providerHeaders: () => ({}), autoRoles: () => roles,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => false,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' },
    requestScope: { getStore: () => ({ authn: { user: { id: 'synthetic-user', role: 'member' } }, workspace: { userId: 'synthetic-user' } }) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (r) => ({ text: String(r) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'smart', servedCatalogue: async () => catalogue, modelsInstalled: async () => catalogue, missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], chatWideApproved: () => false, awaitApproval: async () => 'deny', recordUsage() {}, recordToolUse() {}, executeToolCall: async () => '',
    json: (_res, status, body) => { replies.push({ status, body }); },
    longProfiles,
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'hello' });
  const events = replies.filter((r) => r.sse).flatMap((r) => r.sse.split('\n').filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })).filter(Boolean);
  // The meta event names the model this turn is sent to (the same value the request carries).
  return { replies, upstream, meta: events.find((e) => e.type === 'meta'), status: events.find((e) => e.type === 'status') };
}

test('#1079 Context High serves the long profile and says the switch may take a moment', async (t) => {
  const r = await send(t, { project: { routing: 'manual', model: BASE, contextProfile: 'high' } });
  assert.equal(r.meta.model, LONG);
  assert.equal(r.meta.contextProfile, 'high');
  assert.equal(r.status.id, 'loadingLongContext');
});

test('#1079 an already-loaded long profile needs no switch notice', async (t) => {
  const r = await send(t, { project: { routing: 'manual', model: BASE, contextProfile: 'high' }, catalogue: [{ name: BASE, labels: [], longVariant: LONG, longLoaded: true }] });
  assert.equal(r.meta.model, LONG);
  assert.equal(r.status.id, 'preparing');
});

test('#1079 Low (no choice stored) serves the model itself, as before', async (t) => {
  const r = await send(t, { project: { routing: 'manual', model: BASE } });
  assert.equal(r.meta.model, BASE);
  assert.equal(r.meta.contextProfile, undefined);
  assert.equal(r.status.id, 'preparing');
});

test('#1079 High on a model without a long profile serves the model and reports Low', async (t) => {
  const r = await send(t, { project: { routing: 'manual', model: BASE, contextProfile: 'high' }, catalogue: [{ name: BASE, labels: [] }] });
  assert.equal(r.meta.model, BASE);
  assert.equal(r.meta.contextProfile, 'low');
  assert.equal(r.status.id, 'preparing');
});

test('#1079 Auto keeps routing to the role model; High then serves that model\'s long profile', async (t) => {
  const r = await send(t, { project: { routing: 'auto', contextProfile: 'high' }, roles: { fast: 'Synthetic-E2B', smart: BASE } });
  assert.equal(r.meta.route, 'smart');
  assert.equal(r.meta.model, LONG);
  const fast = await send(t, { project: { routing: 'auto', contextProfile: 'high' }, roles: { fast: 'Synthetic-E2B', smart: 'Synthetic-E2B' } });
  assert.equal(fast.meta.model, 'Synthetic-E2B');
});

test('#1079 a cloud provider is never given a long profile id', async (t) => {
  const r = await send(t, { provider: 'cloud-a', project: { routing: 'manual', model: BASE, contextProfile: 'high' } });
  assert.equal(r.meta.model, BASE);
  assert.equal(r.meta.contextProfile, undefined);
});

test('#1079 without the long-profile module High fails closed to the model itself', async (t) => {
  const broken = createLongProfiles({ log: () => {}, decide: { pairs: () => { throw Error('x'); }, section: () => { throw Error('x'); }, pick: () => { throw Error('missing'); } } });
  const r = await send(t, { project: { routing: 'manual', model: BASE, contextProfile: 'high' }, longProfiles: broken });
  assert.equal(r.meta.model, BASE);
  assert.equal(r.meta.contextProfile, 'low');
});
