'use strict';
// #778 routing modes: the pre-rules, the fail-closed sensitivity check, the route resolution, and
// handleChat end to end with stub providers (no real model, no cloud call). Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const rm = require('./routing-modes.cjs');
const { createDecisions } = require('./decision/index.cjs');
const { createApprovals } = require('./approvals.cjs');
const { createApprovalRoutes } = require('./routes/approvals.cjs');

// A valid synthetic IBAN (checksum computed below), a Luhn-valid test card number, a key shape.
const SYN_IBAN = (() => { const bban = '370400440532013000'; for (let c = 2; c < 99; c++) { const v = `DE${String(c).padStart(2, '0')}${bban}`; if (rm.ibanValid(v)) return v; } return null; })();
const SYN_CARD = '4111 1111 1111 1111';
const SYN_SECRET = 'password: Synthetic-Hunter2-Value';

// ── Pre-rules ────────────────────────────────────────────────────────────────
test('preRule: secrets, IBANs and card numbers are flagged; ordinary text is not', () => {
  assert.ok(SYN_IBAN);
  assert.equal(rm.preRule(`My account is ${SYN_IBAN} thanks`), 'iban');
  assert.equal(rm.preRule(`card ${SYN_CARD}`), 'card');
  assert.equal(rm.preRule(SYN_SECRET), 'secret');
  assert.equal(rm.preRule('api_key=abcd1234efgh'), 'secret');
  assert.equal(rm.preRule('-----BEGIN OPENSSH PRIVATE KEY-----'), 'secret');
  assert.equal(rm.preRule('Authorization: Bearer abcdefghijklmnop1234'), 'secret');
  assert.equal(rm.preRule('key sk_SyntheticKey1234567890abcdefXYZ here'), 'secret');
  for (const clean of ['What is the capital of France?', 'Call me at 2026-10-05 12:00', 'Order 1234 5678 9012 3456 shipped',
    'commit 3e7bbed8a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6', 'DE00 1234 5678 9012 3456 78']) assert.equal(rm.preRule(clean), null, clean);
});

test('preRule secret keywords: real values flag, code and placeholders do not (#817)', () => {
  // The password family keeps the plain-word rule (review of #828); token/secret/api_key need a real-looking value.
  const positives = ['password: "hunter2xyz"', "password = 'Synthetic99'", 'token=abcd1234efgh', 'api_key: Sy7nthetic-Key-0001', 'auth token: zq81-x0p2-ww93',
    'passwd=S3cretValue', 'secret: `fake-value-9`', 'password=hunter2', 'password: letmein', 'password = correct-horse-battery-staple', 'passwd=S3cret', 'pin: 4821', 'passcode=00112233', 'PASSWORD : "Synthetic-Pass"', 'access_token=ya29Synthetic01'];
  const negatives = ['token = getToken()', 'token = fetchToken2(user)', 'a == b', 'token == expected', 'password: null', 'password = None', 'token: undefined',
    'password: "xxxxxx"', 'password: "******"', 'password = user.password', 'password = getPassword()', 'password: <redacted>', 'api_key: "<your-api-key>"', 'token: "${TOKEN}"', 'password = "your-password"', 'password: changeme',
    'secret: "example-secret"', 'token = response.data.token', 'token = this.session.token2', 'token = value2', 'token: abc', 'pwd: /home/synthetic',
    'Token::fromString(x)', 'password = "abc"', 'token = tokenValue', 'pin: 12', 'cd $(pwd)'];
  for (const text of positives) assert.equal(rm.preRule(text), 'secret', text);
  for (const text of negatives) assert.equal(rm.preRule(text), null, text);
  // Linear: a long run of near-misses for the assignment rule.
  for (const text of ['token=' + 'a('.repeat(100000), 'password: "' + 'x'.repeat(300000), 'token ='.repeat(50000), 'pin:'.repeat(80000)]) {
    const t0 = performance.now(); rm.preRule(text); const ms = performance.now() - t0;
    assert.ok(ms < 100, `${text.slice(0, 12)} took ${ms.toFixed(1)} ms`);
  }
});

test('the sensitivity option labels fit the 120-character option limit (#817)', () => {
  for (const option of rm.OPTIONS) assert.ok(option.label.length <= 120, `${option.id}: ${option.label.length}`);
  assert.equal(rm.OPTIONS.find((o) => o.id === 'sensitive').label, 'Private or confidential: health, finances, ID numbers, passwords, relationships, legal or work secrets');
});

test('preRule is linear on adversarial input for every pattern', () => {
  const cases = {
    keyShape: 'ab-'.repeat(60000), keyShapeDashes: ('ab' + '-'.repeat(30)).repeat(6000) + '!', jwt: 'eyJ-'.repeat(60000), jwtDots: 'eyJ.'.repeat(60000),
    privateKey: '-----BEGIN ' + 'A '.repeat(100000), password: 'token: '.repeat(50000), passwordSpaces: 'password' + ' '.repeat(200000),
    bearer: 'Bearer '.repeat(50000), iban: 'DE00 '.repeat(80000), ibanRun: 'DE001234'.repeat(40000), card: '1 '.repeat(150000), cardDash: '4-'.repeat(150000),
  };
  for (const [name, text] of Object.entries(cases)) {
    const t0 = performance.now(); rm.preRule(text); const ms = performance.now() - t0;
    assert.ok(ms < 100, `${name} took ${ms.toFixed(1)} ms`);
  }
  // The rewritten shapes still match what they should.
  assert.equal(rm.preRule('x eyJhbGciOiJIUzI1.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4 y'), 'secret');
  assert.equal(rm.preRule('key ghp-' + 'abcdefghijklmnopqrstuvwxyz'), null, 'no digit: not a key');
});

test('pre-rules scan the current message first, so a huge context cannot push it past the scan limit', () => {
  const rest = 'filler '.repeat(70000); // over 400k characters
  assert.equal(rm.preRule(rest + SYN_IBAN), null, 'past the limit on its own');
  assert.equal(rm.preRule(SYN_IBAN) || rm.preRule(rest), 'iban');
});

test('hasDiaryContent: a Diary tool result in the history counts; other tools do not', () => {
  assert.equal(rm.hasDiaryContent([{ role: 'tool', name: 'diary_search', content: 'x' }]), true);
  assert.equal(rm.hasDiaryContent([{ role: 'tool', name: 'tavily_search', content: 'x' }, { role: 'user', content: 'diary_' }]), false);
});

test('routerChunks: by default a max-size turn is ONE chunk with the message start and the newest history', () => {
  const big = { message: 'M'.repeat(400000), system: 'S'.repeat(400000), history: Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: `h${i} `.repeat(2000) })), attachments: Array.from({ length: 500 }, (_, i) => `file-${i}.pdf`) };
  assert.equal(rm.ROUTER_MAX_CHUNKS, 1);
  const one = rm.routerChunks(big);
  assert.equal(one.length, 1);
  assert.ok(one[0].length <= rm.ROUTER_CHUNK_CHARS);
  assert.ok(one[0].startsWith('Message:\nMMMM'), 'starts with the message');
  assert.match(one[0], /Recent history \(most recent first\):\nuser: h199 /, 'a slice of the newest history');
  // The admin setting: NOEVIA_ROUTER_CHUNKS, bounded 1-4, default 1.
  assert.equal(rm.routerMaxChunks({}), 1);
  assert.equal(rm.routerMaxChunks({ NOEVIA_ROUTER_CHUNKS: '3' }), 3);
  assert.equal(rm.routerMaxChunks({ NOEVIA_ROUTER_CHUNKS: '99' }), 4);
  assert.equal(rm.routerMaxChunks({ NOEVIA_ROUTER_CHUNKS: '0' }), 1);
  assert.equal(rm.routerMaxChunks({ NOEVIA_ROUTER_CHUNKS: 'x' }), 1);
  const chunks = rm.routerChunks(big, { maxChunks: 4 });
  assert.ok(chunks.length >= 1 && chunks.length <= 4, String(chunks.length));
  for (const c of chunks) assert.ok(c.length <= rm.ROUTER_CHUNK_CHARS, String(c.length));
  const all = chunks.join('');
  for (const label of ['Message:', 'Context:', 'Attachments:', 'Recent history (most recent first):']) assert.ok(all.includes(label), label);
  assert.match(all, /h199 /, 'the most recent history turn is included');
  assert.match(all, /file-0\.pdf/);
  // A short turn is one chunk; an empty one is none.
  assert.equal(rm.routerChunks({ message: 'hi', history: [{ role: 'user', content: 'earlier' }] }).length, 1);
  assert.deepEqual(rm.routerChunks({}), []);
  // A backend with a smaller state limit shrinks the chunks; a larger one does not grow them.
  assert.equal(rm.chunkCharsFor({ limits: { maxStateChars: 4000 } }), rm.ROUTER_CHUNK_CHARS);
  assert.equal(rm.chunkCharsFor({ limits: { maxStateChars: 600 } }), 600);
  assert.equal(rm.chunkCharsFor(null), rm.ROUTER_CHUNK_CHARS);
  for (const c of rm.routerChunks(big, { chunkChars: 600 })) assert.ok(c.length <= 600);
  assert.ok(rm.routerChunks(big, { maxChunks: 99 }).length <= 8, 'chunk count is capped');
});

test('sensitivity: a default max-size turn makes exactly 1 decide call; setting 3 makes 3', async () => {
  const big = { message: 'M'.repeat(400000), system: 'S'.repeat(400000), history: Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: `h${i} `.repeat(2000) })) };
  const calls = [];
  const check = rm.createSensitivity({ decide: async (r) => { calls.push(r.context.stateText); return { selected: 'not_sensitive', scores: { not_sensitive: 0.9 }, confidence: 0.9 }; } });
  assert.deepEqual(await check(rm.routerChunks(big, { maxChunks: rm.routerMaxChunks({}) })), { flagged: false, flag: null });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith('Message:\nM') && /h199 /.test(calls[0]));
  calls.length = 0;
  await check(rm.routerChunks(big, { maxChunks: rm.routerMaxChunks({ NOEVIA_ROUTER_CHUNKS: '3' }) }));
  assert.equal(calls.length, 3);
});

test('sensitivity: no further chunk is sent once the deadline budget is spent, and that fails closed', async () => {
  const calls = [];
  const check = rm.createSensitivity({ deadlineMs: () => 300, decide: (r) => { calls.push(r.constraints.deadlineMs); return new Promise((res) => setTimeout(() => res({ selected: 'not_sensitive', scores: { not_sensitive: 0.9 }, confidence: 0.9 }), 200)); } });
  assert.deepEqual(await check(['a', 'b', 'c', 'd']), { flagged: true, flag: 'unavailable' });
  assert.equal(calls.length, 2, 'the third chunk is never sent');
  assert.ok(calls[1] < 300, 'the second call only gets what is left');
});

test('sensitivity over chunks: chunks are asked one at a time; any sensitive or failed chunk flags the turn', async () => {
  const answer = (sel) => ({ selected: sel, scores: { [sel]: 0.9 }, confidence: 0.9 });
  const seen = [];
  const byText = (map) => rm.createSensitivity({ decide: async (r) => { seen.push(r.context.stateText); const v = map(r.context.stateText); if (v instanceof Error) throw v; return answer(v); } });
  assert.deepEqual(await byText(() => 'not_sensitive')(['a', 'b', 'c', 'd']), { flagged: false, flag: null });
  assert.deepEqual(seen.sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(await byText((t) => (t === 'c' ? 'sensitive' : 'not_sensitive'))(['a', 'b', 'c', 'd']), { flagged: true, flag: 'router' });
  assert.deepEqual(await byText((t) => (t === 'b' ? Error('over budget') : 'not_sensitive'))(['a', 'b', 'c']), { flagged: true, flag: 'unavailable' });
  assert.deepEqual(await byText(() => 'not_sensitive')([]), { flagged: true, flag: 'unavailable' }, 'nothing to ask is not a clear verdict');
  // Sequential: a sensitive chunk stops the rest.
  seen.length = 0;
  assert.deepEqual(await byText((t) => (t === 'a' ? 'sensitive' : 'not_sensitive'))(['a', 'b']), { flagged: true, flag: 'router' });
  assert.deepEqual(seen, ['a']);
  // A backend that ignores the deadline is cut off by the overall one, and that fails closed.
  const hung = rm.createSensitivity({ deadlineMs: () => 100, decide: () => new Promise(() => {}) });
  assert.deepEqual(await hung(['a']), { flagged: true, flag: 'unavailable' });
});

test('settings: normalize, validate and the admin allow-list', () => {
  assert.deepEqual(rm.normalize(null), { mode: null, whenSensitive: 'ask', cloud: { providerId: '', fast: '', smart: '', code: '' } });
  assert.throws(() => rm.validate({ mode: 'everywhere' }, rm.MODES), /mode must be/);
  assert.throws(() => rm.validate({ mode: 'cloud' }, ['local']), (e) => e.status === 403);
  assert.throws(() => rm.validate({ mode: 'hybrid', whenSensitive: 'never' }, rm.MODES), /whenSensitive/);
  assert.equal(rm.validate({ mode: 'hybrid', cloud: { providerId: 'p1', smart: 'm-1' } }, rm.MODES).cloud.smart, 'm-1');
  const kv = new Map(); const store = { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) };
  assert.deepEqual(rm.allowedModes(store), ['local', 'cloud', 'hybrid']);
  assert.deepEqual(rm.setAllowedModes(store, ['hybrid', 'local']), ['local', 'hybrid']);
  assert.throws(() => rm.setAllowedModes(store, ['anywhere']));
  assert.equal(rm.effectiveMode({ mode: 'cloud' }, ['local', 'hybrid']), 'local', 'a disallowed mode falls back to local');
  assert.equal(rm.effectiveMode({ mode: null }, ['local']), null);
});

// ── The sensitivity check: every failure is "flagged" ─────────────────────────
const backend = (decide) => ({ id: 'stub', locality: 'local', supports: () => true, decide });
const layer = (decide) => createDecisions({ backends: { b: backend(decide) }, chains: { 'routing.sensitivity': ['b'] } }).decide;

test('sensitivity: answers inside the options are used; the request forbids cloud', async () => {
  const seen = [];
  const sensitive = rm.createSensitivity({ decide: async (r) => { seen.push(r); return layer(async () => ({ selected: 'sensitive', scores: { sensitive: 0.9, not_sensitive: 0.1 }, confidence: 0.9 }))(r); } });
  assert.deepEqual(await sensitive('text'), { flagged: true, flag: 'router' });
  assert.equal(seen[0].context.cloud, 'forbidden');
  assert.deepEqual(seen[0].options.map((o) => o.id), ['sensitive', 'not_sensitive']);
  const clear = rm.createSensitivity({ decide: layer(async () => ({ selected: 'not_sensitive', scores: { sensitive: 0.1, not_sensitive: 0.9 }, confidence: 0.9 })) });
  assert.deepEqual(await clear('text'), { flagged: false, flag: null });
});

test('sensitivity fails closed: error, timeout, unavailable, low confidence, outside the options', async () => {
  const cases = {
    error: rm.createSensitivity({ decide: layer(async () => { throw Error('boom'); }) }),
    thrown: rm.createSensitivity({ decide: () => { throw Error('Decision service unavailable'); } }),
    unavailable: rm.createSensitivity({ decide: undefined }),
    timeout: rm.createSensitivity({ deadlineMs: () => 100, decide: layer(() => new Promise((r) => setTimeout(() => r({ selected: 'not_sensitive', scores: { not_sensitive: 1 } }), 400))) }),
    lowConfidence: rm.createSensitivity({ decide: layer(async () => ({ selected: 'not_sensitive', scores: { sensitive: 0.45, not_sensitive: 0.55 }, confidence: 0.55 })) }),
    outside: rm.createSensitivity({ decide: layer(async () => ({ selected: 'maybe', scores: { maybe: 1 } })) }),
    nullAnswer: rm.createSensitivity({ decide: async () => ({ selected: 'not_sensitive', scores: {}, source: 'fallback' }) }),
  };
  for (const [name, check] of Object.entries(cases)) assert.deepEqual(await check('text'), { flagged: true, flag: 'unavailable' }, name);
});

// ── Route resolution ─────────────────────────────────────────────────────────
test('resolveRoute: each mode, force-local, hard bans, remembered and the answers to the card', async () => {
  const clear = async () => ({ flagged: false });
  const flagged = async () => ({ flagged: true, flag: 'router' });
  const never = async () => { throw Error('must not ask'); };
  assert.deepEqual(await rm.resolveRoute({ mode: 'local', hasCloud: true, ask: never }), { route: 'local', reason: 'mode' });
  assert.deepEqual(await rm.resolveRoute({ mode: 'cloud', hasCloud: true, ask: never }), { route: 'cloud', reason: 'mode' });
  assert.deepEqual(await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: clear, ask: never }), { route: 'cloud', reason: 'mode' });
  assert.deepEqual(await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, forceLocal: true, check: flagged, ask: never }), { route: 'local', reason: 'force-local' });
  assert.deepEqual(await rm.resolveRoute({ mode: 'cloud', hasCloud: true, forceLocal: true, ask: never }), { route: 'local', reason: 'force-local' });
  assert.deepEqual(await rm.resolveRoute({ mode: 'cloud', hasCloud: true, hardLocal: true, allowCloud: true, ask: never }), { route: 'local', reason: 'sensitive-rule', flag: 'diary' });
  assert.deepEqual(await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: flagged, allowCloud: true, ask: never }), { route: 'cloud', reason: 'remembered', flag: 'router' });
  assert.deepEqual(await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, whenSensitive: 'local', preFlag: 'iban', ask: never }), { route: 'local', reason: 'sensitive-rule', flag: 'iban' });
  assert.deepEqual(await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, whenSensitive: 'local', check: async () => ({ flagged: true, flag: 'unavailable' }), ask: never }), { route: 'local', reason: 'fail-closed', flag: 'unavailable' });
  assert.deepEqual(await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: flagged, ask: async () => ({ choice: 'cloud', remember: true }) }), { route: 'cloud', reason: 'user-choice', flag: 'router', remember: 'cloud' });
  assert.deepEqual(await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: flagged, ask: async () => ({ choice: 'local' }) }), { route: 'local', reason: 'user-choice', flag: 'router' });
  for (const answer of [{ choice: 'timeout' }, { choice: 'aborted' }, null, { choice: 'approve' }]) {
    assert.equal((await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: flagged, ask: async () => answer })).route, 'local', JSON.stringify(answer));
  }
  assert.equal((await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: flagged, ask: async () => { throw Error('x'); } })).route, 'local');
  assert.deepEqual(await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, hasLocal: false, check: flagged, ask: async () => ({ choice: 'timeout' }) }), { cancel: true, reason: 'fail-closed' });
  // A check that does not answer `flagged: false` explicitly is a flag.
  let asked = 0;
  await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: async () => undefined, ask: async () => { asked++; return { choice: 'local' }; } });
  assert.equal(asked, 1);
});

// ── handleChat end to end ────────────────────────────────────────────────────
const LOCAL = 'http://local.invalid', CLOUD = 'http://cloud.invalid';
const sse = (...frames) => ({ ok: true, status: 200, body: (async function* () { for (const f of frames) yield Buffer.from(`data: ${JSON.stringify(f)}\n\n`); })() });
const PROVIDERS = { default: { id: 'default', baseUrl: LOCAL }, 'cloud-x': { id: 'cloud-x', baseUrl: CLOUD, label: 'Synthetic cloud', shared: true } };

async function run(t, { flag, settings = null, chat = {}, project: projectOver = {}, message = 'Tell me about synthetic widgets', history = [], verdict = 'clear', answer = null, approvals = null, userId = 'synthetic-user', withRouting = true, toolResult = null, brainContext = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-routing-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], calls = [], logs = [], flagsSet = [], errors = [];
  const res = new EventEmitter();
  res.writeHead = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const gate = approvals || createApprovals();
  res.write = (chunk) => {
    const m = String(chunk).match(/^data: (.*)\n\n$/s);
    if (!m) return;
    const ev = JSON.parse(m[1]); events.push(ev);
    if (ev.type === 'route_pending') {
      calls.push({ pending: true });
      if (answer) setImmediate(() => gate.pendingApprovals.get(ev.id)?.decide(answer.choice, { remember: answer.remember === true }));
    }
  };
  const fetch = async (url, init) => {
    if (!String(url).endsWith('/chat/completions')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    // With a tool result fixture, the first round asks for the synthetic read tool.
    if (toolResult !== null && calls.filter((c) => c.url).length === 1) {
      return sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'synthetic_read', arguments: '{}' } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    }
    return sse({ choices: [{ delta: { content: 'ok' } }] });
  };
  const project = { id: 'fixture-project', name: 'Fixture', routing: 'auto', assets: [], chats: [{ id: 'fixture-chat', title: 't', updatedAt: 1, ...chat }], ...projectOver };
  const verdicts = { clear: { flagged: false, flag: null }, sensitive: { flagged: true, flag: 'router' }, fail: { flagged: true, flag: 'unavailable' } };
  const sensitivityCalls = [];
  const { handleChat } = require('./chat.cjs').createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: ['local-fast', 'local-smart'].map((n) => ({ model_name: n, loaded: true, recipe_options: { ctx_size: 32768 } })) } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {}, diaryEnabled: () => false },
    crypto: require('node:crypto'), path, fs, fetch, HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange: require('./tool-exchange.cjs').createToolExchange,
    currentWorkspace: () => ({ userId, dir, assetDir: () => dir }),
    getProject: (id) => (id === 'fixture-project' ? project : null),
    skillsIndexFor: () => [], getProvider: (id) => PROVIDERS[id] || PROVIDERS.default, providerHeaders: () => ({}), autoRoles: () => ({ fast: 'local-fast', smart: 'local-smart' }),
    visionDescriptions: new Map(), visionProbe: async () => ({ supported: true }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => false,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' },
    requestScope: { getStore: () => ({ authn: { user: { id: userId, role: 'member' } }, workspace: { userId } }) },
    resolveTools: () => ({ tools: toolResult === null ? [] : [{ type: 'function', function: { name: 'synthetic_read', description: 'Synthetic read', parameters: { type: 'object', properties: {} } } }], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (r) => ({ text: String(r) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://diary.invalid', TOOL_RESULT_CAP: 8000, json: (r, status, body) => { errors.push({ status, body }); r.end(); }, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'smart', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], chatWideApproved: () => false, awaitApproval: async () => 'deny', recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => (toolResult === null ? 'SYNTHETIC' : toolResult), freeChats: () => [],
    ...(brainContext ? { chatFramingEnabled: () => true, brainContext } : {}),
    ...(withRouting ? { routingModes: {
      enabled: () => flag === true,
      settings: () => rm.normalize(settings),
      sensitivity: async (digest) => { sensitivityCalls.push(digest); return verdicts[verdict]; },
      awaitChoice: gate.awaitRouteChoice,
      log: (entry) => logs.push(entry),
      setChatFlags: (projectId, chatId, patch) => { flagsSet.push({ projectId, chatId, patch }); return true; },
    } } : {}),
  });
  const origLog = console.log, origWarn = console.warn, origInfo = console.info;
  const consoleLines = [];
  console.log = (...a) => consoleLines.push(a.join(' ')); console.warn = (...a) => consoleLines.push(a.join(' ')); console.info = (...a) => consoleLines.push(a.join(' '));
  try {
    await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message, history });
  } finally { console.log = origLog; console.warn = origWarn; console.info = origInfo; }
  const upstream = calls.filter((c) => c.url);
  const meta = events.find((e) => e.type === 'meta');
  return { events, calls, upstream, meta, logs, flagsSet, errors, consoleLines, sensitivityCalls };
}
// Wall-clock fields differ between any two runs; everything else must match byte for byte.
const stable = (events) => JSON.stringify(events, (k, v) => (['updatedAt', 'timeToFirstToken'].includes(k) ? 0 : v));
const HYBRID = { mode: 'hybrid', cloud: { providerId: 'cloud-x', smart: 'cloud-smart', fast: 'cloud-fast' } };

test('flag off: the model requests and events are byte-identical to a server without routing modes', async (t) => {
  for (const settings of [null, HYBRID, { ...HYBRID, mode: 'cloud' }]) {
    const base = await run(t, { withRouting: false, message: `pay ${SYN_IBAN}` });
    const off = await run(t, { flag: false, settings, message: `pay ${SYN_IBAN}`, answer: { choice: 'cloud' } });
    assert.equal(JSON.stringify(off.upstream), JSON.stringify(base.upstream));
    assert.equal(stable(off.events), stable(base.events));
    assert.equal(off.upstream[0].url.startsWith(LOCAL), true);
    assert.equal(off.meta.routing, undefined);
  }
  // Flag on but no mode chosen: also unchanged.
  const base = await run(t, { withRouting: false });
  const none = await run(t, { flag: true, settings: null });
  assert.equal(stable(none.events), stable(base.events));
  assert.equal(JSON.stringify(none.upstream), JSON.stringify(base.upstream));
});

test('local mode: local roles only; cloud mode: the cloud provider and its model', async (t) => {
  const local = await run(t, { flag: true, settings: { ...HYBRID, mode: 'local' }, message: `pay ${SYN_IBAN}` });
  assert.equal(local.upstream.length, 1); assert.ok(local.upstream[0].url.startsWith(LOCAL));
  assert.equal(local.upstream[0].body.model, 'local-smart');
  assert.deepEqual(local.meta.routing, { route: 'local', reason: 'mode' });
  const cloud = await run(t, { flag: true, settings: { ...HYBRID, mode: 'cloud' } });
  assert.ok(cloud.upstream[0].url.startsWith(CLOUD)); assert.equal(cloud.upstream[0].body.model, 'cloud-smart');
  assert.deepEqual(cloud.meta.routing, { route: 'cloud', reason: 'mode' });
  assert.equal(cloud.sensitivityCalls.length, 0, 'cloud mode does not ask the router role');
  // Cloud mode with no cloud target refuses rather than guessing.
  const missing = await run(t, { flag: true, settings: { mode: 'cloud' } });
  assert.equal(missing.upstream.length, 0); assert.equal(missing.errors[0].status, 409);
});

test('hybrid: a clear turn goes to cloud; the digest covers the history', async (t) => {
  const r = await run(t, { flag: true, settings: HYBRID, verdict: 'clear', history: [{ role: 'user', content: 'earlier synthetic turn' }, { role: 'assistant', content: 'reply' }] });
  assert.ok(r.upstream[0].url.startsWith(CLOUD));
  assert.deepEqual(r.meta.routing, { route: 'cloud', reason: 'mode' });
  assert.ok(Array.isArray(r.sensitivityCalls[0]));
  assert.match(r.sensitivityCalls[0].join('\n'), /earlier synthetic turn/);
  assert.equal(r.events.some((e) => e.type === 'route_pending'), false);
});

test('hybrid: pre-rules and every fail-closed verdict land on the card, never on cloud', async (t) => {
  for (const c of [{ message: `pay ${SYN_IBAN}`, flag: 'iban' }, { message: `my card ${SYN_CARD}`, flag: 'card' }, { message: SYN_SECRET, flag: 'secret' },
    { verdict: 'fail', flag: 'unavailable' }, { verdict: 'sensitive', flag: 'router' }]) {
    const r = await run(t, { flag: true, settings: HYBRID, message: c.message, verdict: c.verdict, answer: { choice: 'local' } });
    const pending = r.events.find((e) => e.type === 'route_pending');
    assert.equal(pending?.flag, c.flag, JSON.stringify(c));
    assert.equal(r.upstream.some((u) => u.url.startsWith(CLOUD)), false, 'nothing reached the cloud');
    // The card came before any model request.
    assert.ok(r.calls.findIndex((x) => x.pending) < r.calls.findIndex((x) => x.url));
  }
  // A pre-rule hit does not even ask the router role.
  const pre = await run(t, { flag: true, settings: HYBRID, message: `pay ${SYN_IBAN}`, answer: { choice: 'local' } });
  assert.equal(pre.sensitivityCalls.length, 0);
});

test('hybrid: a huge history cannot push the message past the scan limit; history reaches the router', async (t) => {
  const history = Array.from({ length: 10 }, () => ({ role: 'user', content: 'filler '.repeat(8000) }));
  const r = await run(t, { flag: true, settings: HYBRID, history, message: `pay ${SYN_IBAN}`, answer: { choice: 'local' } });
  assert.equal(r.events.find((e) => e.type === 'route_pending')?.flag, 'iban');
  const clear = await run(t, { flag: true, settings: HYBRID, history, message: 'hello' });
  assert.ok(clear.sensitivityCalls[0].length === 1 && clear.sensitivityCalls[0].every((c) => c.length <= rm.ROUTER_CHUNK_CHARS));
  assert.match(clear.sensitivityCalls[0].join(''), /Recent history/);
});

test('a sensitive tool result on a cloud route never reaches the cloud model', async (t) => {
  for (const mode of ['hybrid', 'cloud']) {
    const r = await run(t, { flag: true, settings: { ...HYBRID, mode }, toolResult: `Account on file: ${SYN_IBAN}` });
    assert.equal(r.upstream.length, 1, `${mode}: only round 1 was sent`);
    assert.ok(r.upstream[0].url.startsWith(CLOUD));
    assert.equal(JSON.stringify(r.upstream).includes(SYN_IBAN), false);
    const pause = r.events.find((e) => e.type === 'paused');
    assert.equal(pause?.reason, 'sensitive-tool-result'); assert.equal(pause?.flag, 'iban');
    assert.match(pause.text, /was not sent to the cloud model/);
    assert.ok(r.events.some((e) => e.type === 'done'));
  }
  // A harmless tool result carries on to round 2 on cloud; on a local route nothing is held.
  const ok = await run(t, { flag: true, settings: HYBRID, toolResult: 'synthetic weather: sunny' });
  assert.equal(ok.upstream.length, 2); assert.ok(ok.upstream[1].url.startsWith(CLOUD));
  const local = await run(t, { flag: true, settings: { ...HYBRID, mode: 'local' }, toolResult: `Account on file: ${SYN_IBAN}` });
  assert.equal(local.upstream.length, 2); assert.ok(local.upstream[1].url.startsWith(LOCAL));
  assert.equal(local.events.some((e) => e.type === 'paused'), false);
});

test('the card: Send to cloud goes to cloud; Keep local stays local', async (t) => {
  const cloud = await run(t, { flag: true, settings: HYBRID, verdict: 'sensitive', answer: { choice: 'cloud' } });
  assert.ok(cloud.upstream[0].url.startsWith(CLOUD)); assert.deepEqual(cloud.meta.routing, { route: 'cloud', reason: 'user-choice' });
  const local = await run(t, { flag: true, settings: HYBRID, verdict: 'sensitive', answer: { choice: 'local' } });
  assert.ok(local.upstream[0].url.startsWith(LOCAL)); assert.equal(local.upstream[0].body.model, 'local-smart');
  assert.deepEqual(local.meta.routing, { route: 'local', reason: 'user-choice' });
});

test('the card timing out never sends to cloud', async (t) => {
  const approvals = createApprovals({ timeoutMs: 30 });
  const r = await run(t, { flag: true, settings: HYBRID, verdict: 'sensitive', approvals });
  assert.ok(r.events.some((e) => e.type === 'route_pending'));
  assert.equal(r.upstream.length, 1); assert.ok(r.upstream[0].url.startsWith(LOCAL));
  assert.deepEqual(r.meta.routing, { route: 'local', reason: 'fail-closed' });
  assert.equal(approvals.pendingApprovals.size, 0);
});

test('"always local" when sensitive keeps it local without asking', async (t) => {
  const r = await run(t, { flag: true, settings: { ...HYBRID, whenSensitive: 'local' }, verdict: 'fail' });
  assert.equal(r.events.some((e) => e.type === 'route_pending'), false);
  assert.ok(r.upstream[0].url.startsWith(LOCAL)); assert.deepEqual(r.meta.routing, { route: 'local', reason: 'fail-closed' });
});

test('force local skips the question; remember sets the chat flag; allow-cloud is remembered', async (t) => {
  const forced = await run(t, { flag: true, settings: HYBRID, verdict: 'sensitive', chat: { forceLocal: true } });
  assert.equal(forced.events.some((e) => e.type === 'route_pending'), false);
  assert.ok(forced.upstream[0].url.startsWith(LOCAL)); assert.deepEqual(forced.meta.routing, { route: 'local', reason: 'force-local' });
  assert.equal(forced.sensitivityCalls.length, 0);

  const keep = await run(t, { flag: true, settings: HYBRID, verdict: 'sensitive', answer: { choice: 'local', remember: true } });
  assert.deepEqual(keep.flagsSet, [{ projectId: 'fixture-project', chatId: 'fixture-chat', patch: { forceLocal: true, allowCloud: false } }]);
  assert.ok(keep.events.some((e) => e.type === 'route_remembered' && e.forceLocal === true));
  const send = await run(t, { flag: true, settings: HYBRID, verdict: 'sensitive', answer: { choice: 'cloud', remember: true } });
  assert.deepEqual(send.flagsSet[0].patch, { allowCloud: true });

  const remembered = await run(t, { flag: true, settings: HYBRID, verdict: 'sensitive', chat: { allowCloud: true } });
  assert.equal(remembered.events.some((e) => e.type === 'route_pending'), false);
  assert.ok(remembered.upstream[0].url.startsWith(CLOUD)); assert.deepEqual(remembered.meta.routing, { route: 'cloud', reason: 'remembered' });
});

test('an explicit model is respected; hard bans win over cloud and over a remembered allow', async (t) => {
  const explicit = await run(t, { flag: true, settings: { ...HYBRID, mode: 'local' }, project: { routing: 'manual', provider: 'cloud-x', model: 'picked-model' } });
  assert.ok(explicit.upstream[0].url.startsWith(CLOUD)); assert.equal(explicit.upstream[0].body.model, 'picked-model');
  assert.equal(explicit.meta.routing, undefined, 'not an Auto chat: no routing');
  const diaryHistory = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'tool', name: 'diary_search', content: 'synthetic diary text' }];
  for (const settings of [{ ...HYBRID, mode: 'cloud' }, HYBRID]) {
    const r = await run(t, { flag: true, settings, history: diaryHistory, chat: { allowCloud: true }, answer: { choice: 'cloud' } });
    assert.equal(r.events.some((e) => e.type === 'route_pending'), false);
    assert.ok(r.upstream[0].url.startsWith(LOCAL)); assert.deepEqual(r.meta.routing, { route: 'local', reason: 'sensitive-rule' });
  }
});

test('project images present on disk are stripped on the cloud route', async (t) => {
  const r = await (async () => {
    const realMkdtemp = fs.mkdtempSync;
    let made;
    fs.mkdtempSync = (p) => { made = realMkdtemp(p); fs.writeFileSync(path.join(made, 'synthetic-asset'), Buffer.from([0x89, 0x50, 0x4e, 0x47])); return made; };
    try { return await run(t, { flag: true, settings: { ...HYBRID, mode: 'cloud' }, project: { assets: [{ id: 'synthetic-asset', name: 'pic.png', mime: 'image/png' }] } }); }
    finally { fs.mkdtempSync = realMkdtemp; }
  })();
  assert.ok(r.upstream[0].url.startsWith(CLOUD));
  const body = JSON.stringify(r.upstream[0].body);
  assert.equal(body.includes('image_url'), false);
  assert.match(body, /were not sent/);
});

test('the routing answer is bound to the requesting user', async () => {
  const gate = createApprovals();
  const scope = { user: 'owner' };
  const route = createApprovalRoutes({ json: (r, status, body) => { r.status = status; r.body = body; return true; },
    readBody: async (req) => req.raw, pendingApprovals: gate.pendingApprovals, requestScope: { getStore: () => ({ workspace: { userId: scope.user } }) } });
  const ctl = new AbortController();
  const waiting = gate.awaitRouteChoice({ id: 'r1', userId: 'owner', chatId: 'c1', abortSignal: ctl.signal });
  const post = async (raw) => { const res = {}; await route({ method: 'POST', raw }, res, { path: '/api/tool-approvals/r1' }); return res; };
  scope.user = 'intruder';
  assert.equal((await post('{"decision":"cloud"}')).status, 404);
  scope.user = 'owner';
  assert.equal((await post('{"decision":"approve_all"}')).status, 400, 'a write answer is not a routing answer');
  assert.equal((await post('{"decision":"cloud","remember":true}')).status, 200);
  assert.deepEqual(await waiting, { choice: 'cloud', remember: true });
  assert.equal(gate.chatWideApproved('owner', 'c1', 'space:free'), false, 'never grants writes');
  assert.equal((await post('{"decision":"local"}')).status, 404, 'single use');
});

test('logs and the decision log hold codes only, never content', async (t) => {
  const secretMessage = `Synthetic private note ${SYN_SECRET} ${SYN_IBAN}`;
  for (const answer of [{ choice: 'local' }, { choice: 'cloud' }]) {
    const r = await run(t, { flag: true, settings: HYBRID, message: secretMessage, answer });
    const all = JSON.stringify(r.logs) + r.consoleLines.join('\n');
    for (const needle of ['Synthetic private note', 'Hunter2', SYN_IBAN, 'cloud-smart']) assert.equal(all.includes(needle), false, needle);
    assert.ok(r.logs.every((e) => Object.keys(e).every((k) => ['mode', 'route', 'reason', 'flag'].includes(k))));
    assert.ok(r.consoleLines.some((l) => /^\[routing\] mode=hybrid route=(local|cloud) reason=user-choice flag=secret$/.test(l)));
  }
  const seen = [];
  const check = rm.createSensitivity({ decide: async () => { throw Error(secretMessage); }, log: (e) => seen.push(e) });
  await check(secretMessage);
  assert.equal(JSON.stringify(seen).includes('Synthetic'), false);
});

test('chat-lists merge: forceLocal / allowCloud survive a save that leaves them out, like frame', () => {
  const { mergeChats } = require('./chat-lists.cjs');
  const stored = [{ id: 'c1', title: 't', updatedAt: 1, forceLocal: true, allowCloud: false }];
  assert.equal(mergeChats(stored, [{ id: 'c1', title: 't2', updatedAt: 2 }])[0].forceLocal, true, 'an older tab keeps it');
  assert.equal(mergeChats(stored, [{ id: 'c1', title: 't2', updatedAt: 2, forceLocal: false }])[0].forceLocal, false, 'a boolean replaces it');
  assert.equal(mergeChats(stored, [{ id: 'c1', title: 't2', updatedAt: 2, forceLocal: 'yes' }])[0].forceLocal, true, 'junk is ignored');
  assert.equal('forceLocal' in mergeChats([], [{ id: 'c2', title: 't', updatedAt: 1, forceLocal: 'yes' }])[0], false);
});

test('GET/PUT /api/routing-mode: own account, admin allow-list, flag off refuses', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-routing-route-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kv = new Map(); const store = { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) };
  let on = true;
  const routes = require('./routes/routing-mode.cjs').createRoutingModeRoutes({ json: (r, status, body) => { r.status = status; r.body = body; return true; },
    readBody: async (req) => req.raw, enabled: () => on, currentWorkspace: () => ({ dir }), store });
  const call = async (method, p, raw, role = 'member') => { const res = {}; const handled = await routes({ method, raw }, res, { path: p, authn: { user: { id: 'u1', role } } }); return { handled, ...res }; };
  assert.deepEqual((await call('GET', '/api/routing-mode')).body.mode, null);
  assert.equal((await call('PUT', '/api/routing-mode', JSON.stringify({ mode: 'cloud' }))).status, 400, 'cloud needs a target');
  const saved = await call('PUT', '/api/routing-mode', JSON.stringify({ mode: 'hybrid', whenSensitive: 'local', cloud: { providerId: 'cloud-x', smart: 'm1' } }));
  assert.equal(saved.status, 200); assert.equal(rm.read(dir).whenSensitive, 'local');
  assert.equal((await call('PUT', '/api/routing-mode/allowed', JSON.stringify({ allowed: ['local'] }))).status, 403);
  assert.deepEqual((await call('PUT', '/api/routing-mode/allowed', JSON.stringify({ allowed: ['local'] }), 'admin')).body.allowed, ['local']);
  assert.equal((await call('PUT', '/api/routing-mode', JSON.stringify({ mode: 'hybrid', cloud: { providerId: 'cloud-x', smart: 'm1' } }))).status, 403);
  assert.equal(rm.effectiveMode(rm.read(dir), rm.allowedModes(store)), 'local', 'a stored mode an admin later disallowed acts as local');
  // #779 F5: GET shows the mode replies actually use, with the stored choice beside it.
  const shown = (await call('GET', '/api/routing-mode')).body;
  assert.equal(shown.mode, 'local'); assert.equal(shown.storedMode, 'hybrid');
  on = false;
  assert.deepEqual((await call('GET', '/api/routing-mode')).body, { enabled: false });
  assert.equal((await call('PUT', '/api/routing-mode', JSON.stringify({ mode: 'local' }))).status, 409);
  assert.equal((await call('GET', '/api/other')).handled, false);
});

test('linked brain context stays local: dropped on a cloud route and from the router input, kept on a local route (#815)', async (t) => {
  const { CONTEXT_INTRO } = require('./chat-brain.cjs');
  const brain = { brain_schema: 1, summary: 'Synthetic linked summary marker.', decisions: [], facts: [], open_questions: [], entities: [] };
  const frame = { kind: 'question', tags: [], links: ['linked-a'], confirmed: true, source: 'user' };
  const chats = () => [{ id: 'fixture-chat', title: 't', updatedAt: 1, frame }, { id: 'linked-a', title: 'Linked', updatedAt: 1 }];
  const brainContext = { enabled: () => true, maxChars: () => 2000, chats, read: (id) => (id === 'linked-a' ? { brain } : null) };
  const opts = { chat: { frame }, project: { chats: chats() }, brainContext };
  const cloud = await run(t, { ...opts, flag: true, settings: { ...HYBRID, mode: 'cloud' } });
  assert.ok(cloud.upstream[0].url.startsWith(CLOUD));
  assert.doesNotMatch(JSON.stringify(cloud.upstream), /Synthetic linked summary marker|chat brain/, 'cloud mode: no brain text');
  const hybrid = await run(t, { ...opts, flag: true, settings: HYBRID, verdict: 'clear' });
  assert.ok(hybrid.upstream[0].url.startsWith(CLOUD));
  assert.doesNotMatch(JSON.stringify(hybrid.upstream), /Synthetic linked summary marker/, 'hybrid cloud route: no brain text');
  assert.doesNotMatch(JSON.stringify(hybrid.sensitivityCalls), /Synthetic linked summary marker/, 'the router never weighs a brain');
  const local = await run(t, { ...opts, flag: true, settings: { ...HYBRID, mode: 'local' } });
  assert.ok(local.upstream[0].url.startsWith(LOCAL));
  const system = local.upstream[0].body.messages.find((m) => m.role === 'system').content;
  assert.ok(system.includes(CONTEXT_INTRO) && system.includes('Synthetic linked summary marker.'), 'a local route keeps it');
});

test('#1007: a project override replaces mode and sensitive handling, keeps the account cloud, and stays under the allowed list', () => {
  const rm = require('./routing-modes.cjs');
  const account = { mode: 'local', whenSensitive: 'ask', cloud: { providerId: 'prov-1', fast: 'f', smart: 's', code: '' } };
  assert.equal(rm.withProjectOverride(account, null), account);
  assert.equal(rm.withProjectOverride(account, { routingMode: { mode: 'bogus' } }), account, 'a malformed stored override is ignored');
  const merged = rm.withProjectOverride(account, { routingMode: { mode: 'hybrid', whenSensitive: 'local' } });
  assert.deepEqual(merged, { mode: 'hybrid', whenSensitive: 'local', cloud: account.cloud });
  assert.equal(rm.effectiveMode(merged, ['local']), 'local', 'a disallowed project mode falls back to local');
  assert.deepEqual(rm.projectOverride({ mode: 'cloud' }), { mode: 'cloud', whenSensitive: 'ask' });
  assert.throws(() => rm.projectOverride([], true), /object or null/);
});
