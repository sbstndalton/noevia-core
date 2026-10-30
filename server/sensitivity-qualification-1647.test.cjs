'use strict';
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}
// #1647: in Hybrid routing a "not sensitive" verdict may clear a turn for a cloud provider only when
// the decision model that gave it is on the qualified list for the sensitivity decision, matched by
// the identity the service reports (model id AND content revision), with its evidence at the bar.
// The #1639 evaluation found the live model (Laya-en) answered "not sensitive" to all 40 English
// sensitive texts at a share of 0.6 or more, so after #1640 every one would have gone to the cloud.
//
// Driven the way server/index.cjs wires it (decision settings -> endpoint -> decision layer ->
// createSensitivity) against a synthetic decision service on loopback, and through chat.cjs with stub
// providers. Synthetic text only; no model, no Diary, nothing leaves 127.0.0.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { EventEmitter } = require('node:events');
const rm = require('./routing-modes.cjs');
const qualification = require('./decision-qualification.cjs');
const { createDecisions } = require('./decision/index.cjs');
const { createDecisionSettings } = require('./decision-settings.cjs');
const { rustSavesDecision } = require('../tests/server/rust-decision-row.cjs');
const { createDecisionEndpoint } = require('./decision-endpoint.cjs');
const { createApprovals } = require('./approvals.cjs');

// The live service's reported name and the Hugging Face revision noevia-services pins for it.
const LAYA_EN = { model: 'convaiinnovations/laya', revision: '1c5edc17a7acd8701df6fc341c0d179f1c62c982' };
const SYN = { model: 'synthetic/sensitivity-test', revision: 'b'.repeat(64) };
const SYN_QUALIFIED = [{ ...SYN, evidence: { set: 'synthetic', sensitiveRecall: 0.95, measured: '2026-10-13' } }];

const BENIGN_TEXT = 'Synthetic test: how do widgets work?';

/** A reply in the decision service's shape. `identity` adds the fields a model reports about itself. */
const reply = (selected, share, identity = SYN) => {
  const other = selected === 'sensitive' ? 'not_sensitive' : 'sensitive';
  return { selected, scores: { [selected]: share, [other]: Math.round((1 - share) * 1000) / 1000 }, calibrated: false,
    ...(identity ? { model: identity.model, ...(identity.revision ? { model_revision: identity.revision } : {}) } : {}) };
};

/** A synthetic decision service on loopback; `seen` records every request body. */
async function fakeService(t, answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null; try { parsed = JSON.parse(body); } catch { /* recorded as null */ }
      seen.push(parsed);
      const r = typeof answer === 'function' ? answer(parsed) : answer;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/** The production chain. Without `qualified` the check uses the shipped list, as server/index.cjs does. */
function productionCheck(url, extra = {}) {
  const kv = new Map();
  const settings = createDecisionSettings({ store: { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) }, env: {} });
  rustSavesDecision({ set: (k, v) => kv.set(k, v) }, { url, timeoutMs: 1500 });
  const decisions = createDecisions({ backends: { configured: settings.backend() }, chains: { 'routing.sensitivity': ['configured'] } });
  const logs = [];
  const check = rm.createSensitivity({ decide: decisions.decide, log: (e) => logs.push(e), ...extra });
  return { check, logs };
}

// ── A chat turn through chat.cjs, with stub local and cloud providers ────────
const LOCAL = 'http://local.invalid', CLOUD = 'http://cloud.invalid';
const PROVIDERS = { default: { id: 'default', baseUrl: LOCAL }, 'cloud-x': { id: 'cloud-x', baseUrl: CLOUD, label: 'Synthetic cloud', shared: true } };
const HYBRID = { mode: 'hybrid', cloud: { providerId: 'cloud-x', smart: 'cloud-smart', fast: 'cloud-fast' } };
const sse = (...frames) => ({ ok: true, status: 200, body: (async function* () { for (const f of frames) yield Buffer.from(`data: ${JSON.stringify(f)}\n\n`); })() });

async function turn(t, { sensitivity, message = 'Reply with the word ok.', chat = {}, answer = { choice: 'local' } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1647-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], upstream = [], errors = [];
  const gate = createApprovals();
  const res = new EventEmitter();
  res.writeHead = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  res.write = (chunk) => {
    const m = String(chunk).match(/^data: (.*)\n\n$/s);
    if (!m) return;
    const ev = JSON.parse(m[1]); events.push(ev);
    if (ev.type === 'route_pending') setImmediate(() => gate.pendingApprovals.get(ev.id)?.decide(answer.choice, { remember: false }));
  };
  const fetch = async (url, init) => {
    if (!String(url).endsWith('/chat/completions')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    upstream.push({ url: String(url), body: JSON.parse(init.body) });
    return sse({ choices: [{ delta: { content: 'ok' } }] });
  };
  const userId = 'synthetic-user';
  const project = { id: 'fixture-project', name: 'Fixture', routing: 'auto', assets: [], chats: [{ id: 'fixture-chat', title: 't', updatedAt: 1, ...chat }] };
  const { handleChat } = require('./chat.cjs').createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: ['local-fast', 'local-smart'].map((n) => ({ model_name: n, loaded: true, recipe_options: { ctx_size: 32768 } })) } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {}, diaryEnabled: () => false },
    crypto: require('node:crypto'), path, fs, fetch, HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange: require('./tool-exchange.cjs').createToolExchange,
    currentWorkspace: () => ({ userId, dir, assetDir: () => dir }),
    getProject: (id) => (id === project.id ? project : null),
    skillsIndexFor: () => [], getProvider: (id) => PROVIDERS[id] || PROVIDERS.default, providerHeaders: () => ({}), autoRoles: () => ({ fast: 'local-fast', smart: 'local-smart' }),
    visionDescriptions: new Map(), visionProbe: async () => ({ supported: true }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => false,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' },
    requestScope: { getStore: () => ({ authn: { user: { id: userId, role: 'member' } }, workspace: { userId } }) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (r) => ({ text: String(r) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://diary.invalid', TOOL_RESULT_CAP: 8000, json: (r, status, body) => { errors.push({ status, body }); r.end(); }, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'smart', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], grantContext: async raw => require('../tests/server/chat-grant-fixture.cjs').context(raw, { holder: { kind: 'absent' } }), chatWideApproved: () => false, awaitApproval: async () => 'deny', recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => 'SYNTHETIC', freeChats: () => [],
    routingModes: {
      enabled: () => true,
      settings: () => rm.normalize(HYBRID),
      sensitivity,
      awaitChoice: gate.awaitRouteChoice,
      log: () => {},
      setChatFlags: () => true,
    },
  });
  const origLog = console.log, origWarn = console.warn, origInfo = console.info;
  console.log = () => {}; console.warn = () => {}; console.info = () => {};
  try {
    await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message, history: [] });
  } finally { console.log = origLog; console.warn = origWarn; console.info = origInfo; }
  return { events, upstream, errors, meta: events.find((e) => e.type === 'meta'), card: events.some((e) => e.type === 'route_pending') };
}
const reachedCloud = (r) => r.upstream.some((u) => u.url.startsWith(CLOUD));

// ── The shipped list ─────────────────────────────────────────────────────────

test('#1647: no decision model ships qualified for sensitivity; the live Laya-en identity is not qualified', () => {
  assert.deepEqual(qualification.qualifiedEntries('sensitivity'), [], 'qualifying a model is the owner\'s call (#1639)');
  assert.equal(qualification.qualifiedFor('sensitivity', LAYA_EN), null);
  assert.equal(qualification.qualifiedFor('sensitivity', { model: 'convaiinnovations/laya' }), null, 'a name alone is never an identity');
  assert.equal(qualification.BARS.sensitivity.min, 0.85);
});

test('#1647: an entry counts only with its evidence at the bar, and matches on model AND revision', () => {
  const entry = (evidence, id = SYN) => [{ ...id, evidence }];
  const at = { set: '#1639 sensitivity', sensitiveRecall: 0.85, measured: '2026-10-13' };
  assert.ok(qualification.qualifiedFor('sensitivity', SYN, entry(at)), 'recall 0.85 meets the bar');
  for (const [label, evidence] of [['under the bar (Kev-0.8B measured 0.846)', { ...at, sensitiveRecall: 0.846 }], ['no evidence', undefined],
    ['no set', { ...at, set: '' }], ['no date', { ...at, measured: undefined }], ['recall as text', { ...at, sensitiveRecall: '0.9' }], ['recall over 1', { ...at, sensitiveRecall: 1.5 }],
    ['Laya-en\'s 1.9% recall', { ...at, sensitiveRecall: 0.019 }]]) {
    assert.equal(qualification.qualifiedFor('sensitivity', SYN, entry(evidence)), null, label);
  }
  assert.equal(qualification.qualifiedFor('sensitivity', { ...SYN, revision: 'c'.repeat(64) }, entry(at)), null, 'other weights under the same name');
  assert.equal(qualification.qualifiedFor('sensitivity', { ...SYN, model: 'synthetic/other' }, entry(at)), null, 'another model with the same revision');
  assert.equal(qualification.qualifiedFor('sensitivity', null, entry(at)), null);
  assert.equal(qualification.qualifiedFor('routing', SYN, entry(at)), null, 'a decision without a bar qualifies nobody');
});

test('#1647: the endpoint reports a validated identity only when the service gives a model id and a content revision', async (t) => {
  const two = [{ id: 'sensitive', label: 'a' }, { id: 'not_sensitive', label: 'b' }];
  const identityFrom = async (body) => {
    const svc = await fakeService(t, body);
    return (await createDecisionEndpoint({ env: { COWORK_DECISION_URL: svc.url } }).choice({ state: 'synthetic', question: 'q', options: two })).metadata.identity;
  };
  assert.deepEqual(await identityFrom(reply('not_sensitive', 0.9)), SYN);
  assert.deepEqual(await identityFrom(reply('not_sensitive', 0.9, LAYA_EN)), LAYA_EN);
  // Laya's reply today has no revision (noevia-services laya/server.py): no identity.
  assert.equal(await identityFrom(reply('not_sensitive', 0.9, { model: 'convaiinnovations/laya' })), undefined);
  for (const bad of [{ model: 'http://evil.invalid/x', revision: SYN.revision }, { model: 'a b', revision: SYN.revision },
    { model: SYN.model, revision: 'B'.repeat(64) }, { model: SYN.model, revision: '1c5edc' }, { model: SYN.model, revision: `${SYN.revision}\n` }]) {
    assert.equal(await identityFrom(reply('not_sensitive', 0.9, bad)), undefined, JSON.stringify(bad));
  }
});

// ── The check and the chat turn ──────────────────────────────────────────────

test('#1647: with the shipped list, "not sensitive" at 0.99 keeps the turn local, with no card, and nothing reaches the cloud', async (t) => {
  // Even a model that reports a well-formed identity is not trusted until it is on the list.
  for (const identity of [SYN, LAYA_EN, null]) {
    const svc = await fakeService(t, reply('not_sensitive', 0.99, identity));
    const s = productionCheck(svc.url);
    const r = await turn(t, { sensitivity: s.check });
    assert.equal(reachedCloud(r), false, 'nothing reached the cloud URL');
    assert.deepEqual(s.logs.map((e) => [e.verdict, e.cause]), [['unavailable', 'not-qualified']]);
    assert.deepEqual(await s.check({ chunks: [BENIGN_TEXT], complete: true }), { flagged: true, flag: 'unavailable', cause: 'not-qualified' });
    assert.ok(r.upstream.length === 1 && r.upstream[0].url.startsWith(LOCAL), 'answered locally');
    assert.deepEqual(r.meta.routing, { route: 'local', reason: 'check-unavailable', detail: 'not-qualified' });
    assert.equal(r.card, false, 'no card: an unqualified check is not a verdict (#1421)');
    assert.equal(svc.seen.length, 0, 'with no qualified model the decision service is not asked at all');
  }
});

test('#1647: with the shipped list, "sensitive" at 0.99 is not a verdict either: local, no card', async (t) => {
  const svc = await fakeService(t, reply('sensitive', 0.99));
  const r = await turn(t, { sensitivity: productionCheck(svc.url).check });
  assert.equal(reachedCloud(r), false);
  assert.deepEqual(r.meta.routing, { route: 'local', reason: 'check-unavailable', detail: 'not-qualified' });
  assert.equal(r.card, false);
});

test('#1647: a qualified identity clears "not sensitive" at 0.99 for cloud, and "sensitive" still shows the card', async (t) => {
  const clear = await fakeService(t, reply('not_sensitive', 0.99));
  const r = await turn(t, { sensitivity: productionCheck(clear.url, { qualified: SYN_QUALIFIED }).check });
  assert.deepEqual(r.meta.routing, { route: 'cloud', reason: 'mode' });
  assert.ok(reachedCloud(r));
  assert.equal(r.card, false);
  assert.equal(clear.seen.length, 1);
  const flagged = await fakeService(t, reply('sensitive', 0.99));
  const f = await turn(t, { sensitivity: productionCheck(flagged.url, { qualified: SYN_QUALIFIED }).check, answer: { choice: 'local' } });
  assert.equal(f.events.find((e) => e.type === 'route_pending')?.flag, 'router');
  assert.equal(reachedCloud(f), false);
});

test('#1647: a missing or mismatched identity keeps the turn local even with a qualified model on the list', async (t) => {
  const cases = [
    ['no identity', null],
    ['a name without a revision', { model: SYN.model }],
    ['other weights under the qualified name', { model: SYN.model, revision: 'c'.repeat(64) }],
    ['another model', { model: 'synthetic/other-model', revision: SYN.revision }],
    ['a malformed revision', { model: SYN.model, revision: 'not-a-hash' }],
  ];
  for (const [label, identity] of cases) {
    const svc = await fakeService(t, reply('not_sensitive', 0.99, identity));
    const s = productionCheck(svc.url, { qualified: SYN_QUALIFIED });
    // Several chunks: the first answer shows the model is not qualified, so the rest are not sent.
    assert.deepEqual(await s.check({ chunks: ['a', 'b', 'c'], complete: true }), { flagged: true, flag: 'unavailable', cause: 'not-qualified' }, label);
    assert.equal(svc.seen.length, 1, `${label}: one request, then stop`);
    const r = await turn(t, { sensitivity: s.check });
    assert.equal(reachedCloud(r), false, `${label}: nothing reached the cloud URL`);
    assert.deepEqual(r.meta.routing, { route: 'local', reason: 'check-unavailable', detail: 'not-qualified' }, label);
    assert.equal(r.card, false, label);
  }
});

test('#1647: an explicit per-chat grant still decides: allowCloud goes to cloud, forceLocal stays local', async (t) => {
  const svc = await fakeService(t, reply('not_sensitive', 0.99));
  const granted = await turn(t, { sensitivity: productionCheck(svc.url).check, chat: { allowCloud: true } });
  assert.deepEqual(granted.meta.routing, { route: 'cloud', reason: 'remembered' });
  assert.ok(reachedCloud(granted));
  const forced = await turn(t, { sensitivity: productionCheck(svc.url, { qualified: SYN_QUALIFIED }).check, chat: { forceLocal: true } });
  assert.deepEqual(forced.meta.routing, { route: 'local', reason: 'force-local' });
  assert.equal(reachedCloud(forced), false);
});

test('#1647: the check still reports a partial view as partial before qualification, and logs no text', async () => {
  const logs = [];
  let asked = 0;
  const check = rm.createSensitivity({ decide: async () => { asked += 1; return null; }, log: (e) => logs.push(e) });
  assert.deepEqual(await check({ chunks: ['SYNTHETIC-PRIVATE-TEXT'], complete: false }), { flagged: true, flag: 'unavailable', cause: 'partial' });
  assert.deepEqual(await check({ chunks: ['SYNTHETIC-PRIVATE-TEXT'], complete: true }), { flagged: true, flag: 'unavailable', cause: 'not-qualified' });
  assert.equal(asked, 0);
  assert.equal(JSON.stringify(logs).includes('SYNTHETIC'), false);
});
