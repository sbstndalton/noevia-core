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

// #1647: the sensitivity check's mechanics below run against a synthetic model on a test-only qualified
// list. The shipped list (no model qualified) and the gate itself: sensitivity-qualification-1647.test.cjs.
const SYN_IDENTITY = Object.freeze({ model: 'synthetic/sensitivity-test', revision: 'a'.repeat(40) });
const SYN_QUALIFIED = [{ ...SYN_IDENTITY, evidence: { set: 'synthetic', sensitiveRecall: 1, measured: '2026-10-13' } }];
const withIdentity = (r) => (r && typeof r === 'object' ? { ...r, metadata: { ...(r.metadata || {}), identity: SYN_IDENTITY } } : r);
const qualifiedSensitivity = ({ decide, ...opts }) => rm.createSensitivity({ qualified: SYN_QUALIFIED, ...opts,
  decide: typeof decide === 'function' ? async (r) => withIdentity(await decide(r)) : decide });

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
  const check = qualifiedSensitivity({ decide: async (r) => { calls.push(r.context.stateText); return { selected: 'not_sensitive', scores: { not_sensitive: 0.9 }, confidence: 0.9 }; } });
  assert.deepEqual(await check(rm.routerChunks(big, { maxChunks: rm.routerMaxChunks({}) })), { flagged: false, flag: null });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith('Message:\nM') && /h199 /.test(calls[0]));
  calls.length = 0;
  await check(rm.routerChunks(big, { maxChunks: rm.routerMaxChunks({ NOEVIA_ROUTER_CHUNKS: '3' }) }));
  assert.equal(calls.length, 3);
});

test('sensitivity: no further chunk is sent once the deadline budget is spent, and that fails closed', async () => {
  const calls = [];
  const check = qualifiedSensitivity({ deadlineMs: () => 300, decide: (r) => { calls.push(r.constraints.deadlineMs); return new Promise((res) => setTimeout(() => res({ selected: 'not_sensitive', scores: { not_sensitive: 0.9 }, confidence: 0.9 }), 200)); } });
  assert.deepEqual(await check(['a', 'b', 'c', 'd']), { flagged: true, flag: 'unavailable', cause: 'deadline' });
  assert.equal(calls.length, 2, 'the third chunk is never sent');
  assert.ok(calls[1] < 300, 'the second call only gets what is left');
});

test('sensitivity over chunks: chunks are asked one at a time; any sensitive or failed chunk flags the turn', async () => {
  const answer = (sel) => ({ selected: sel, scores: { [sel]: 0.9 }, confidence: 0.9 });
  const seen = [];
  const byText = (map) => qualifiedSensitivity({ decide: async (r) => { seen.push(r.context.stateText); const v = map(r.context.stateText); if (v instanceof Error) throw v; return answer(v); } });
  assert.deepEqual(await byText(() => 'not_sensitive')(['a', 'b', 'c', 'd']), { flagged: false, flag: null });
  assert.deepEqual(seen.sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(await byText((t) => (t === 'c' ? 'sensitive' : 'not_sensitive'))(['a', 'b', 'c', 'd']), { flagged: true, flag: 'router' });
  assert.deepEqual(await byText((t) => (t === 'b' ? Error('over budget') : 'not_sensitive'))(['a', 'b', 'c']), { flagged: true, flag: 'unavailable', cause: 'error' });
  assert.deepEqual(await byText(() => 'not_sensitive')([]), { flagged: true, flag: 'unavailable', cause: 'no-input' }, 'nothing to ask is not a clear verdict');
  // Sequential: a sensitive chunk stops the rest.
  seen.length = 0;
  assert.deepEqual(await byText((t) => (t === 'a' ? 'sensitive' : 'not_sensitive'))(['a', 'b']), { flagged: true, flag: 'router' });
  assert.deepEqual(seen, ['a']);
  // A backend that ignores the deadline is cut off by the overall one, and that fails closed.
  const hung = qualifiedSensitivity({ deadlineMs: () => 100, decide: () => new Promise(() => {}) });
  assert.deepEqual(await hung(['a']), { flagged: true, flag: 'unavailable', cause: 'deadline' });
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
  const sensitive = qualifiedSensitivity({ decide: async (r) => { seen.push(r); return layer(async () => ({ selected: 'sensitive', scores: { sensitive: 0.9, not_sensitive: 0.1 }, confidence: 0.9 }))(r); } });
  assert.deepEqual(await sensitive('text'), { flagged: true, flag: 'router' });
  assert.equal(seen[0].context.cloud, 'forbidden');
  assert.deepEqual(seen[0].options.map((o) => o.id), ['sensitive', 'not_sensitive']);
  const clear = qualifiedSensitivity({ decide: layer(async () => ({ selected: 'not_sensitive', scores: { sensitive: 0.1, not_sensitive: 0.9 }, confidence: 0.9 })) });
  assert.deepEqual(await clear('text'), { flagged: false, flag: null });
});

test('sensitivity fails closed: error, timeout, unavailable, low confidence, outside the options', async () => {
  const cases = {
    error: qualifiedSensitivity({ decide: layer(async () => { throw Error('boom'); }) }),
    thrown: qualifiedSensitivity({ decide: () => { throw Error('Decision service unavailable'); } }),
    unavailable: qualifiedSensitivity({ decide: undefined }),
    timeout: qualifiedSensitivity({ deadlineMs: () => 100, decide: layer(() => new Promise((r) => setTimeout(() => r({ selected: 'not_sensitive', scores: { not_sensitive: 1 } }), 400))) }),
    lowConfidence: qualifiedSensitivity({ decide: layer(async () => ({ selected: 'not_sensitive', scores: { sensitive: 0.45, not_sensitive: 0.55 }, confidence: 0.55 })) }),
    outside: qualifiedSensitivity({ decide: layer(async () => ({ selected: 'maybe', scores: { maybe: 1 } })) }),
    nullAnswer: qualifiedSensitivity({ decide: async () => ({ selected: 'not_sensitive', scores: {}, source: 'fallback' }) }),
  };
  const causes = { error: 'exception', thrown: 'no-service', unavailable: 'no-service', timeout: 'deadline', lowConfidence: 'low-confidence', outside: 'invalid-result', nullAnswer: 'no-answer' };
  for (const [name, check] of Object.entries(cases)) {
    const out = await check('text');
    assert.equal(out.flagged, true, name); assert.equal(out.flag, 'unavailable', name);
    assert.equal(out.cause, causes[name], name);
  }
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
  assert.deepEqual(await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, whenSensitive: 'local', check: async () => ({ flagged: true, flag: 'unavailable' }), ask: never }), { route: 'local', reason: 'check-unavailable', flag: 'unavailable' });
  // #1421: a check that could not answer never asks, never goes to cloud, and says why.
  assert.deepEqual(await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: async () => ({ flagged: true, flag: 'unavailable', cause: 'deadline' }), ask: never }), { route: 'local', reason: 'check-unavailable', flag: 'unavailable', cause: 'deadline' });
  assert.deepEqual(await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: async () => undefined, ask: never }), { route: 'local', reason: 'check-unavailable', flag: 'unavailable' });
  assert.deepEqual(await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, hasLocal: false, check: async () => ({ flagged: true, flag: 'unavailable' }), ask: never }), { cancel: true, reason: 'check-unavailable' });
  assert.deepEqual(await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: flagged, ask: async () => ({ choice: 'cloud', remember: true }) }), { route: 'cloud', reason: 'user-choice', flag: 'router', remember: 'cloud' });
  assert.deepEqual(await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: flagged, ask: async () => ({ choice: 'local' }) }), { route: 'local', reason: 'user-choice', flag: 'router' });
  for (const answer of [{ choice: 'timeout' }, { choice: 'aborted' }, null, { choice: 'approve' }]) {
    assert.equal((await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: flagged, ask: async () => answer })).route, 'local', JSON.stringify(answer));
  }
  assert.equal((await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: flagged, ask: async () => { throw Error('x'); } })).route, 'local');
  assert.deepEqual(await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, hasLocal: false, check: flagged, ask: async () => ({ choice: 'timeout' }) }), { cancel: true, reason: 'fail-closed' });
  // A check that does not answer `flagged: false` explicitly is not clear (it stays local, see above).
  let asked = 0;
  await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: async () => ({ flagged: true, flag: 'router' }), ask: async () => { asked++; return { choice: 'local' }; } });
  assert.equal(asked, 1);
});

// ── handleChat end to end ────────────────────────────────────────────────────
const LOCAL = 'http://local.invalid', CLOUD = 'http://cloud.invalid';
const sse = (...frames) => ({ ok: true, status: 200, body: (async function* () { for (const f of frames) yield Buffer.from(`data: ${JSON.stringify(f)}\n\n`); })() });
const fnTool = (name) => ({ type: 'function', function: { name, description: 'Synthetic tool', parameters: { type: 'object', properties: {} } } });
const PROVIDERS = { default: { id: 'default', baseUrl: LOCAL }, 'cloud-x': { id: 'cloud-x', baseUrl: CLOUD, label: 'Synthetic cloud', shared: true },
  'cloud-gpt': { id: 'cloud-gpt', kind: 'chatgpt-oauth', baseUrl: 'http://chatgpt.invalid', label: 'Synthetic ChatGPT' } };

async function run(t, { freeChatId = null, ragOverride = null, flag, settings = null, chat = {}, project: projectOver = {}, message = 'Tell me about synthetic widgets', history = [], verdict = 'clear', answer = null, approvals = null, userId = 'synthetic-user', withRouting = true, toolResult = null, brainContext = null, localRoles = { fast: 'local-fast', smart: 'local-smart' }, sensitivity = null, toolBoxes = null, toolName = 'synthetic_read', historyCap = 20, turnToolboxes = undefined, offerAll = false, gateTool = null, connected = [], defaultToolboxes = [], skillsIndex = [], chatgptOAuth = null }) {
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
      return sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: toolName, arguments: '{}' } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    }
    return sse({ choices: [{ delta: { content: 'ok' } }] });
  };
  const project = { id: freeChatId ? `cowork-chat-context-${freeChatId}` : 'fixture-project', name: 'Fixture', routing: 'auto', assets: [], chats: [{ id: 'fixture-chat', title: 't', updatedAt: 1, ...chat }], ...projectOver };
  // 'fail-cause' is a check that could not answer and says why, as createSensitivity reports it (#1438).
  const verdicts = { clear: { flagged: false, flag: null }, sensitive: { flagged: true, flag: 'router' }, fail: { flagged: true, flag: 'unavailable' },
    'fail-cause': { flagged: true, flag: 'unavailable', cause: 'deadline' } };
  const sensitivityCalls = [], sensitivityInputs = [], gateCalls = [];
  const { handleChat } = require('./chat.cjs').createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: ['local-fast', 'local-smart'].map((n) => ({ model_name: n, loaded: true, recipe_options: { ctx_size: 32768 } })) } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {}, diaryEnabled: () => false },
    crypto: require('node:crypto'), path, fs, fetch, HISTORY_CAP: historyCap, DEFAULT_PROVIDER_ID: 'default', createToolExchange: require('./tool-exchange.cjs').createToolExchange,
    currentWorkspace: () => ({ userId, dir, assetDir: () => dir }),
    getProject: (id) => (id === project.id ? project : null),
    skillsIndexFor: () => skillsIndex, getProvider: (id) => PROVIDERS[id] || PROVIDERS.default, providerHeaders: () => ({}), autoRoles: () => localRoles,
    visionDescriptions: new Map(), visionProbe: async () => ({ supported: true }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => false,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: defaultToolboxes, CONNECTOR_BOXES: new Set(connected), connectedBoxes: () => connected,
    toolPolicy: { mode: () => 'allow' },
    requestScope: { getStore: () => ({ authn: { user: { id: userId, role: 'member' } }, workspace: { userId } }) },
    // #1646: with `toolBoxes` ({ id, tools: [name] }) the fixture offers the named boxes' tools, minus what `skip` refuses.
    resolveTools: (selection, _model, skip = () => false) => ({ dropped: [], boxes: [], routes: new Map(), tools: toolBoxes
      ? toolBoxes.filter((b) => offerAll || (selection?.toolboxes || []).includes(b.id)).flatMap((b) => b.tools).filter((n) => offerAll || !skip(n)).map(fnTool)
      : toolResult === null ? [] : [fnTool('synthetic_read')] }), isWriteTool: () => false,
    rag: ragOverride || { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (r) => ({ text: String(r) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://diary.invalid', TOOL_RESULT_CAP: 8000, json: (r, status, body) => { errors.push({ status, body }); r.end(); }, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'smart', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => (toolBoxes || []).map((b) => ({ id: b.id, label: b.id, tools: b.tools.map(fnTool) })), chatWideApproved: () => false, awaitApproval: async () => 'deny', recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => (toolResult === null ? 'SYNTHETIC' : toolResult), freeChats: () => [],
    // #1646: a gate that, like the real one, picks only from the tools it is shown: `gateTool` when offered.
    ...(gateTool ? { toolGate: { record() {}, evaluate: async (_message, offered) => {
      gateCalls.push(offered.map((x) => x.function.name));
      return offered.some((x) => x.function.name === gateTool) ? { decision: { tool: gateTool, mode: 'require' }, source: 'rule' } : { decision: 'none', source: 'none' };
    } } } : {}),
    ...(chatgptOAuth ? { chatgptOAuth, chatgptEnabled: () => true } : {}),
    ...(brainContext ? { chatFramingEnabled: () => true, brainContext } : {}),
    ...(withRouting ? { routingModes: {
      enabled: () => flag === true,
      settings: () => rm.normalize(settings),
      // `sensitivity`: a real createSensitivity check (#1640) in place of the fixture verdict.
      // chat.cjs sends routerInput's { chunks, complete } (#1640 review); the calls record the chunks.
      sensitivity: async (digest) => { sensitivityCalls.push(Array.isArray(digest) ? digest : digest?.chunks); sensitivityInputs.push(digest); return sensitivity ? sensitivity(digest) : verdicts[verdict]; },
      awaitChoice: gate.awaitRouteChoice,
      log: (entry) => logs.push(entry),
      setChatFlags: (projectId, chatId, patch) => { flagsSet.push({ projectId, chatId, patch }); return true; },
    } } : {}),
  });
  const origLog = console.log, origWarn = console.warn, origInfo = console.info;
  const consoleLines = [];
  console.log = (...a) => consoleLines.push(a.join(' ')); console.warn = (...a) => consoleLines.push(a.join(' ')); console.info = (...a) => consoleLines.push(a.join(' '));
  try {
    await handleChat({}, res, freeChatId ? { spaceId: 'free', chatId: freeChatId, message, history } : { projectId: 'fixture-project', chatId: 'fixture-chat', message, history, ...(turnToolboxes ? { turnToolboxes } : {}) }, ...(chatgptOAuth ? [{ user: { id: userId, role: 'member' } }] : []));
  } finally { console.log = origLog; console.warn = origWarn; console.info = origInfo; }
  const upstream = calls.filter((c) => c.url);
  const meta = events.find((e) => e.type === 'meta');
  return { events, calls, upstream, meta, logs, flagsSet, errors, consoleLines, sensitivityCalls, sensitivityInputs, gateCalls };
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

test('hybrid: pre-rules and router verdicts land on the card, never on cloud', async (t) => {
  for (const c of [{ message: `pay ${SYN_IBAN}`, flag: 'iban' }, { message: `my card ${SYN_CARD}`, flag: 'card' }, { message: SYN_SECRET, flag: 'secret' },
    { verdict: 'sensitive', flag: 'router' }]) {
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

// ── #1646: tool results that read the person's own data ──────────────────────
// The router role reads the conversation, not what a tool fetches later, and a tool result is screened by
// the regex pre-rule alone. The marker below is invisible to that rule, as a medical letter without a
// diagnosis-plus-condition phrase would be. On a hybrid cloud route with no allowCloud grant no box that
// reads private data is offered; a turn that carries one goes local.
const LETTER = `Letter from the clinic: ${'ZEBRA-PRIVATE-MARKER-4471'} follow-up scheduled.`;
const FILES_BOX = [{ id: 'nextcloud-files', tools: ['files_read_synthetic'] }];
const PRIVATE_ROUTING = { route: 'local', reason: 'sensitive-rule', detail: 'private-tools' };
const reachedCloud = (r, text) => r.upstream.some((u) => u.url.startsWith(CLOUD) && JSON.stringify(u.body).includes(text));
function assertPrivateToolsStayLocal(r, label, { marker = 'ZEBRA-PRIVATE-MARKER-4471' } = {}) {
  assert.equal(r.upstream.some((u) => u.url.startsWith(CLOUD)), false, `${label}: nothing reached the cloud URL`);
  assert.equal(reachedCloud(r, marker), false, `${label}: the marker never reached the cloud`);
  assert.ok(r.upstream.length >= 1 && r.upstream.every((u) => u.url.startsWith(LOCAL)), `${label}: the turn ended local`);
  assert.deepEqual(r.meta.routing, PRIVATE_ROUTING, `${label}: the routing detail says why`);
  assert.equal(r.events.some((e) => e.type === 'route_pending'), false, `${label}: no card, nothing was flagged`);
  assert.ok(r.events.some((e) => e.type === 'done'), label);
}

test('#1646: a cleared hybrid turn that needs a private-data box (the tool gate would use it) ends local', async (t) => {
  for (const id of ['nextcloud-files', 'nextcloud-notes', 'project-docs', 'gdrive', 'some-future-connector']) {
    const r = await run(t, { flag: true, settings: HYBRID, verdict: 'clear', message: 'Summarize my latest letter.', project: { toolboxes: [id] },
      toolBoxes: [{ id, tools: ['private_read'] }], toolName: 'private_read', toolResult: LETTER, gateTool: 'private_read' });
    assertPrivateToolsStayLocal(r, id);
    assert.equal(r.upstream.length, 2, `${id}: the local model got the tool result and answered`);
    assert.ok(r.upstream[0].body.tools.some((x) => x.function.name === 'private_read'), `${id}: the local model is offered the box`);
  }
});

test('#1646: a private box the project merely carries is not offered to the cloud, and the turn stays there when it does not need it', async (t) => {
  // No gate, or a gate that picks nothing: the cloud model gets no private tool, and if it asks for one anyway it gets a refusal.
  for (const gateTool of [null, 'a_tool_nobody_offers']) {
    const r = await run(t, { flag: true, settings: HYBRID, message: 'Summarize my latest letter.', project: { toolboxes: ['core', 'nextcloud-files'] },
      toolBoxes: [...FILES_BOX, { id: 'core', tools: ['get_current_time'] }], toolName: 'files_read_synthetic', toolResult: LETTER, gateTool });
    assert.deepEqual(r.meta.routing, { route: 'cloud', reason: 'mode' }, String(gateTool));
    assert.ok(r.upstream.every((u) => u.url.startsWith(CLOUD)));
    for (const u of r.upstream) assert.deepEqual((u.body.tools || []).map((x) => x.function.name), ['get_current_time']);
    assert.equal(reachedCloud(r, 'ZEBRA-PRIVATE-MARKER-4471'), false, 'the file never reached the cloud');
    assert.match(JSON.stringify(r.upstream[0].body.messages), /not available in this reply/);
  }
});

test('#1646: Drive connected and Project documents defaulted: "hello" stays on the cloud with no private tool, a Drive request goes local', async (t) => {
  const boxes = [{ id: 'core', tools: ['get_current_time'] }, { id: 'project-docs', tools: ['project_read_file'] }, { id: 'gdrive', tools: ['drive_search_files'] }];
  // The gate here, like the real one, only picks a Drive tool for a message about Drive.
  const common = { flag: true, settings: HYBRID, project: { toolboxes: ['core', 'project-docs'] }, connected: ['gdrive'], toolBoxes: boxes };
  const hello = await run(t, { ...common, message: 'hello', gateTool: 'never_offered' });
  assert.deepEqual(hello.meta.routing, { route: 'cloud', reason: 'mode' });
  assert.ok(hello.upstream[0].url.startsWith(CLOUD));
  assert.deepEqual(hello.upstream[0].body.tools.map((x) => x.function.name), ['get_current_time'], 'no private tool is offered');
  assert.deepEqual([...hello.gateCalls[0]].sort(), ['drive_search_files', 'get_current_time', 'project_read_file'], 'the gate was first shown everything the chat carries');
  assert.deepEqual(hello.gateCalls[1], ['get_current_time'], 'and then what the cloud may offer');
  const drive = await run(t, { ...common, message: 'Summarize my latest letter in Drive.', gateTool: 'drive_search_files', toolName: 'drive_search_files', toolResult: LETTER });
  assertPrivateToolsStayLocal(drive, 'a Drive request');
  assert.ok(drive.upstream[0].body.tools.some((x) => x.function.name === 'drive_search_files'), 'the local model is offered Drive');
  // With no gate at all the same Drive message cannot be told apart from "hello": it stays on the cloud with no Drive tool.
  const noGate = await run(t, { ...common, message: 'Summarize my latest letter in Drive.' });
  assert.deepEqual(noGate.meta.routing, { route: 'cloud', reason: 'mode' });
  assert.deepEqual(noGate.upstream[0].body.tools.map((x) => x.function.name), ['get_current_time']);
});

test('#1646: a box a turn picks, or one Automatic would add for the message, sends the turn local', async (t) => {
  const picked = await run(t, { flag: true, settings: HYBRID, message: 'Summarize my latest letter.', toolBoxes: FILES_BOX, project: { toolboxes: ['core'] },
    turnToolboxes: ['nextcloud-files'], toolName: 'files_read_synthetic', toolResult: LETTER });
  assertPrivateToolsStayLocal(picked, 'turn pick');
  const auto = await run(t, { flag: true, settings: HYBRID, message: 'List my Nextcloud files.', toolBoxes: FILES_BOX, project: { toolsMode: 'auto', toolboxes: ['core'] },
    toolName: 'files_read_synthetic', toolResult: LETTER });
  assertPrivateToolsStayLocal(auto, 'automatic tools');
  // Automatic adds nothing for a message that names no private data: that turn stays on the cloud.
  const plain = await run(t, { flag: true, settings: HYBRID, message: 'Tell me about synthetic widgets', toolBoxes: FILES_BOX, project: { toolsMode: 'auto', toolboxes: ['core'] } });
  assert.deepEqual(plain.meta.routing, { route: 'cloud', reason: 'mode' });
  assert.ok(plain.upstream[0].url.startsWith(CLOUD));
});

test('#1646: the check unavailable (503, timeout, low confidence) keeps a private-data turn local too', async (t) => {
  const failing = [
    ['503', qualifiedSensitivity({ decide: async () => { throw Object.assign(Error('decision service unavailable'), { status: 503 }); } })],
    ['timeout', qualifiedSensitivity({ decide: () => new Promise(() => {}), deadlineMs: () => 100 })],
    ['low confidence', qualifiedSensitivity({ decide: async () => ({ selected: 'not_sensitive', scores: { sensitive: 0.4, not_sensitive: 0.6 }, confidence: 0.5, source: 'model' }) })],
  ];
  for (const [label, sensitivity] of failing) {
    const r = await run(t, { flag: true, settings: HYBRID, message: 'Summarize my latest letter.', project: { toolboxes: ['nextcloud-files'] }, toolBoxes: FILES_BOX,
      toolName: 'files_read_synthetic', toolResult: LETTER, sensitivity, gateTool: 'files_read_synthetic' });
    assert.equal(r.upstream.some((u) => u.url.startsWith(CLOUD)), false, `${label}: nothing reached the cloud`);
    assert.equal(reachedCloud(r, 'ZEBRA-PRIVATE-MARKER-4471'), false, label);
    assert.ok(r.upstream.length >= 1 && r.upstream.every((u) => u.url.startsWith(LOCAL)), `${label}: answered locally`);
    assert.equal(r.meta.routing.route, 'local', label);
    assert.equal(r.meta.routing.reason, 'check-unavailable', label);
    assert.equal(r.events.some((e) => e.type === 'route_pending'), false, label);
  }
});

test('#1646: web search results are not private data: a cloud route offers the box and sends the result on', async (t) => {
  const r = await run(t, { flag: true, settings: HYBRID, message: 'Search the web for synthetic widgets.', project: { toolboxes: ['core', 'web-search'] },
    toolBoxes: [{ id: 'web-search', tools: ['tavily_search'] }], toolName: 'tavily_search', toolResult: 'Public headline: synthetic widgets are in season.' });
  assert.deepEqual(r.meta.routing, { route: 'cloud', reason: 'mode' });
  assert.equal(r.upstream.length, 2);
  assert.ok(r.upstream.every((u) => u.url.startsWith(CLOUD)));
  assert.ok(r.upstream[0].body.tools.some((x) => x.function.name === 'tavily_search'));
  assert.match(JSON.stringify(r.upstream[1].body), /synthetic widgets are in season/);
  assert.equal(r.events.some((e) => e.type === 'paused'), false);
});

test('#1646: an explicit allowCloud chat is unchanged: the private box is offered to the cloud model', async (t) => {
  const r = await run(t, { flag: true, settings: HYBRID, message: 'Summarize my latest letter.', chat: { allowCloud: true }, project: { toolboxes: ['nextcloud-files'] },
    toolBoxes: FILES_BOX, toolName: 'files_read_synthetic', toolResult: LETTER });
  assert.deepEqual(r.meta.routing, { route: 'cloud', reason: 'mode' });
  assert.equal(r.upstream.length, 2);
  assert.ok(r.upstream.every((u) => u.url.startsWith(CLOUD)));
  assert.ok(r.upstream[0].body.tools.some((x) => x.function.name === 'files_read_synthetic'));
  assert.ok(reachedCloud(r, 'ZEBRA-PRIVATE-MARKER-4471'), 'the grant is the owner\'s: the result goes on');
  // A pre-rule hit is still held, as before.
  const held = await run(t, { flag: true, settings: HYBRID, message: 'Summarize my latest letter.', chat: { allowCloud: true }, project: { toolboxes: ['nextcloud-files'] },
    toolBoxes: FILES_BOX, toolName: 'files_read_synthetic', toolResult: `Account on file: ${SYN_IBAN}` });
  assert.equal(held.events.find((e) => e.type === 'paused')?.reason, 'sensitive-tool-result');
  assert.equal(JSON.stringify(held.upstream).includes(SYN_IBAN), false);
});

test('#1646: a mode other than hybrid is unchanged (cloud mode keeps its boxes; local mode is local anyway)', async (t) => {
  const r = await run(t, { flag: true, settings: { ...HYBRID, mode: 'cloud' }, message: 'Summarize my latest letter.', project: { toolboxes: ['nextcloud-files'] },
    toolBoxes: FILES_BOX, toolName: 'files_read_synthetic', toolResult: LETTER });
  assert.deepEqual(r.meta.routing, { route: 'cloud', reason: 'mode' });
  assert.ok(r.upstream[0].body.tools.some((x) => x.function.name === 'files_read_synthetic'));
});

test('#1646: with no local model to move to, the cloud route keeps going without any private-data box, and the model is told', async (t) => {
  const r = await run(t, { flag: true, settings: HYBRID, message: 'Summarize my latest letter.', localRoles: {}, project: { toolboxes: ['core', 'web-search', 'nextcloud-files'] },
    toolBoxes: [...FILES_BOX, { id: 'web-search', tools: ['tavily_search'] }], toolName: 'files_read_synthetic', toolResult: LETTER, gateTool: 'files_read_synthetic' });
  assert.ok(r.upstream.length >= 1 && r.upstream.every((u) => u.url.startsWith(CLOUD)));
  for (const u of r.upstream) assert.equal(JSON.stringify(u.body.tools || []).includes('files_read_synthetic'), false, 'the private tool is not offered');
  assert.ok(r.upstream[0].body.tools.some((x) => x.function.name === 'tavily_search'), 'the public box still is');
  assert.equal(reachedCloud(r, 'ZEBRA-PRIVATE-MARKER-4471'), false, 'a model that asks for the stripped tool anyway gets a refusal, not the file');
  assert.match(JSON.stringify(r.upstream[0].body.messages), /not available in this reply/);
  assert.match(JSON.stringify(r.upstream[1].body.messages), /not enabled for this project/);
  // The backstop: even if a tool list were wrongly built with the private tool in it, the call is refused before it runs.
  const wrong = await run(t, { flag: true, settings: HYBRID, message: 'Summarize my latest letter.', localRoles: {}, project: { toolboxes: ['core'] },
    toolBoxes: FILES_BOX, offerAll: true, toolName: 'files_read_synthetic', toolResult: LETTER });
  assert.ok(wrong.upstream[0].body.tools.some((x) => x.function.name === 'files_read_synthetic'), 'the fixture offered it');
  assert.equal(reachedCloud(wrong, 'ZEBRA-PRIVATE-MARKER-4471'), false);
  assert.match(JSON.stringify(wrong.upstream[1].body.messages), /reads private data and is not available/);
});

test('#1646: the project-file reader is taken out of a cloud route and stays on a local one', async (t) => {
  const core = [{ id: 'core', tools: ['get_current_time', 'read_project_file'] }];
  const cloud = await run(t, { flag: true, settings: HYBRID, message: 'Tell me about synthetic widgets', project: { toolboxes: ['core'], files: [{ name: 'notes.md', content: 'synthetic' }] }, toolBoxes: core });
  assert.deepEqual(cloud.meta.routing, { route: 'cloud', reason: 'mode' });
  assert.deepEqual(cloud.upstream[0].body.tools.map((x) => x.function.name), ['get_current_time']);
  assert.match(JSON.stringify(cloud.upstream[0].body.messages), /not available in this reply/);
  const local = await run(t, { flag: true, settings: { ...HYBRID, mode: 'local' }, message: 'Tell me about synthetic widgets', project: { toolboxes: ['core'], files: [{ name: 'notes.md', content: 'synthetic' }] }, toolBoxes: core });
  assert.deepEqual(local.upstream[0].body.tools.map((x) => x.function.name), ['get_current_time', 'read_project_file']);
  assert.doesNotMatch(JSON.stringify(local.upstream[0].body.messages), /not available in this reply/);
});

test('#1646: a ChatGPT cloud provider is left behind with the route: a private-tool turn never reaches its fetch, even with an unreadable catalogue', async (t) => {
  const chatgptCalls = [];
  // Like fetchFor: accepts any /chat/completions URL (an unreadable catalogue lets the request go ahead) and sends it to the cloud.
  const chatgptOAuth = { status: () => ({ state: 'connected' }),
    fetchFor: () => async (url, init) => { chatgptCalls.push({ url: String(url), body: JSON.parse(init.body) }); return sse({ choices: [{ delta: { content: 'from the cloud' } }] }); } };
  const settings = { mode: 'hybrid', cloud: { providerId: 'cloud-gpt', smart: 'gpt-smart', fast: 'gpt-fast' } };
  const r = await run(t, { flag: true, settings, verdict: 'clear', message: 'Summarize my latest letter.', project: { toolboxes: ['nextcloud-files'] },
    toolBoxes: FILES_BOX, toolName: 'files_read_synthetic', toolResult: LETTER, gateTool: 'files_read_synthetic', chatgptOAuth });
  assertPrivateToolsStayLocal(r, 'chatgpt cloud');
  assert.equal(chatgptCalls.length, 0, 'nothing went through the ChatGPT fetch');
  assert.ok(r.upstream.every((u) => u.url.startsWith(LOCAL)));
  // And the same provider on a turn that stays on the cloud does use it.
  const stays = await run(t, { flag: true, settings, verdict: 'clear', message: 'Tell me about synthetic widgets', chatgptOAuth });
  assert.deepEqual(stays.meta.routing, { route: 'cloud', reason: 'mode' });
  assert.equal(chatgptCalls.length, 1);
  assert.equal(stays.upstream.length, 0, 'the plain fetch was not used');
});

test('#1646: a one-off "Send to cloud" on the sensitive card is a grant for that turn: the private box is offered', async (t) => {
  const r = await run(t, { flag: true, settings: HYBRID, verdict: 'sensitive', answer: { choice: 'cloud' }, message: 'Summarize my latest letter.',
    project: { toolboxes: ['nextcloud-files'] }, toolBoxes: FILES_BOX, toolName: 'files_read_synthetic', toolResult: LETTER, gateTool: 'files_read_synthetic' });
  assert.deepEqual(r.meta.routing, { route: 'cloud', reason: 'user-choice' });
  assert.equal(r.flagsSet.length, 0, 'nothing was remembered');
  assert.ok(r.upstream.every((u) => u.url.startsWith(CLOUD)));
  assert.ok(r.upstream[0].body.tools.some((x) => x.function.name === 'files_read_synthetic'));
  assert.ok(reachedCloud(r, 'ZEBRA-PRIVATE-MARKER-4471'), 'the person chose cloud for this turn');
  // The choice is not kept: the next turn, cleared by the check, is ungranted again.
  const next = await run(t, { flag: true, settings: HYBRID, verdict: 'clear', message: 'Summarize my latest letter.', project: { toolboxes: ['nextcloud-files'] },
    toolBoxes: FILES_BOX, toolName: 'files_read_synthetic', toolResult: LETTER, gateTool: 'files_read_synthetic' });
  assertPrivateToolsStayLocal(next, 'the next turn');
});

test('#1646: where the project-file reader is taken out, the prompt no longer sends the model to it', async (t) => {
  const hint = require('./rag.cjs').READ_FILE_HINT;
  const ragOverride = { filesContext: async (_p, _f, _q, _u, onSources) => { onSources([], [{ file: 'notes.md', body: 'x'.repeat(100), kind: 'file' }]); return `Sources (1): "notes.md"\nSource completeness: none.\nContext may contain excerpts only.${hint} Do not guess.`; } };
  const skillsIndex = [{ file: 'skills/a.md', name: 'A', description: 'd', version: '1' }];
  const common = { flag: true, message: 'Tell me about synthetic widgets', ragOverride, skillsIndex, project: { toolboxes: ['core'], files: [{ name: 'notes.md', content: 'x'.repeat(5000) }] },
    toolBoxes: [{ id: 'core', tools: ['get_current_time', 'read_project_file'] }] };
  const text = (r) => JSON.stringify(r.upstream[0].body.messages);
  const cloud = await run(t, { ...common, settings: HYBRID });
  assert.deepEqual(cloud.meta.routing, { route: 'cloud', reason: 'mode' });
  assert.match(text(cloud), /Context may contain excerpts only\. Do not guess/);
  assert.match(text(cloud), /Available skills \(their files cannot be loaded in this reply/);
  assert.match(text(cloud), /Source text was truncated for this reply.*say which part you read\./, 'the truncation note is still there');
  assert.equal(/read_project_file/.test(text(cloud)), false, 'neither the skills index, the coverage line nor the truncation note names the reader');
  const local = await run(t, { ...common, settings: { ...HYBRID, mode: 'local' } });
  assert.match(text(local), /Use read_project_file with PDF startPage/);
  assert.match(text(local), /load the full file with the read_project_file tool/);
  assert.match(text(local), /read_project_file with an offset can read more of a file/);
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
  const r = await run(t, { flag: true, settings: { ...HYBRID, whenSensitive: 'local' }, verdict: 'sensitive' });
  assert.equal(r.events.some((e) => e.type === 'route_pending'), false);
  assert.ok(r.upstream[0].url.startsWith(LOCAL)); assert.deepEqual(r.meta.routing, { route: 'local', reason: 'sensitive-rule' });
});

test('#1421: a failing sensitivity check does not hold the turn: local, no card, reason in the notice', async (t) => {
  for (const whenSensitive of ['ask', 'local']) {
    const r = await run(t, { flag: true, settings: { ...HYBRID, whenSensitive }, message: 'Reply with the word ok.', verdict: 'fail' });
    assert.equal(r.events.some((e) => e.type === 'route_pending'), false, `${whenSensitive}: no card`);
    assert.equal(r.upstream.length, 1); assert.ok(r.upstream[0].url.startsWith(LOCAL), 'answered by the local model');
    assert.equal(r.upstream.some((u) => u.url.startsWith(CLOUD)), false, 'nothing reached the cloud');
    assert.equal(r.meta.routing.route, 'local'); assert.equal(r.meta.routing.reason, 'check-unavailable');
    assert.ok(r.events.some((e) => e.type === 'done'));
  }
  // A real sensitive verdict still asks; a pre-rule hit still asks.
  const asked = await run(t, { flag: true, settings: HYBRID, verdict: 'sensitive', answer: { choice: 'local' } });
  assert.ok(asked.events.some((e) => e.type === 'route_pending'));
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
  const check = qualifiedSensitivity({ decide: async () => { throw Error(secretMessage); }, log: (e) => seen.push(e) });
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

// #1441: a free chat's attached files ride with the user's turn, and the hybrid sensitivity check reads
// the same text the model gets, so a file's sensitive content still decides the route.
test('hybrid routing: the sensitivity check reads the attached file text of a free chat (#1441)', async (t) => {
  const MARKER = 'SYNTHETIC-ATTACHED-MARKER-7731';
  const ragOverride = { filesContext: async (_p, files, _q, _u, onSources, opts) => {
    onSources([]);
    return `${opts?.attached ? 'The user attached these files to this chat' : 'Sources'} (1): "a.md"\n<untrusted kind="file">${MARKER}</untrusted>`;
  } };
  const r = await run(t, { flag: true, settings: HYBRID, freeChatId: 'c-synthetic', ragOverride, project: { files: [{ name: 'a.md', content: MARKER }] }, message: 'Summarize this file.' });
  assert.equal(r.sensitivityCalls.length, 1);
  assert.ok(r.sensitivityCalls[0].join('\n').includes(MARKER), 'the router saw the attached file text');
});

// ── #1526: a clear health or medical-diagnosis text is a pre-rule (synthetic examples only) ──
test('preRule health (#1526): a diagnosis with a condition, or a personal health record, flags; ordinary text does not', () => {
  for (const text of [
    'Test only: what does a fictional diagnosis of hypertension mean?',
    'Synthetic note: the doctor diagnosed the patient with asthma last week.',
    'Synthetic chart: diagnosed with diabetes in 2019.',
    'Their diagnosis is listed as depression in the synthetic report.',
    'Please summarise my medical history for the synthetic clinic visit.',
  ]) assert.equal(rm.preRule(text), 'health', text);
  for (const text of [
    'What is the capital of Norway?', 'Say hi in one word.',
    'The network diagnosis tool found a DNS fault in the synthetic lab.',
    'The engine diagnosis reports fault code P0301 on the synthetic car.',
    'I was diagnosed with a flat tyre on the synthetic road.',
    'Hypertension is a term that appears in this synthetic history book.',
    'My prescription glasses frame is broken.',
    'Describe the diagnostic chart for synthetic widgets.',
  ]) assert.equal(rm.preRule(text), null, text);
});

test('preRule health (#1526) is linear on adversarial input', () => {
  const cases = { diagnosis: 'diagnosis '.repeat(40000), diagnosisGap: 'diagnosis ' + 'a '.repeat(30000) + 'asthma',
    record: 'my '.repeat(50000) + 'medical', recordSpaces: 'my' + ' '.repeat(200000) + 'medical record' };
  for (const [name, text] of Object.entries(cases)) {
    const t0 = performance.now(); rm.preRule(text); const ms = performance.now() - t0;
    assert.ok(ms < 200, `${name} took ${ms.toFixed(1)} ms`);
  }
});

test('#1526: a health question raises the card even when the check cannot answer, and the service is not asked first', async (t) => {
  const r = await run(t, { flag: true, settings: HYBRID, verdict: 'fail', message: 'Test only: what does a fictional diagnosis of hypertension mean?', answer: { choice: 'local' } });
  assert.equal(r.events.find((e) => e.type === 'route_pending')?.flag, 'health');
  assert.equal(r.sensitivityCalls.length, 0, 'the pre-rule answers the question; the service is not asked');
  assert.equal(r.upstream.some((u) => u.url.startsWith(CLOUD)), false, 'nothing reached the cloud');
});

// ── #1438 follow-ups to #1421 ────────────────────────────────────────────────
test('#1438: the cause of a check that could not answer is kept by resolveRoute and by a real createSensitivity', async () => {
  const never = async () => { throw Error('must not ask'); };
  // A decision call that throws the deadline error: createSensitivity turns it into a cause code.
  const check = qualifiedSensitivity({ decide: () => { throw Object.assign(Error('deadline passed'), { deadline: true }); } });
  assert.deepEqual(await check('text'), { flagged: true, flag: 'unavailable', cause: 'deadline' });
  assert.deepEqual(
    await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: () => check('text'), ask: never }),
    { route: 'local', reason: 'check-unavailable', flag: 'unavailable', cause: 'deadline' },
  );
  // A clear verdict carries no cause at all.
  assert.deepEqual(
    await rm.resolveRoute({ mode: 'hybrid', hasCloud: true, check: async () => ({ flagged: false, flag: null }), ask: never }),
    { route: 'cloud', reason: 'mode' },
  );
});

test('#1438: routing.detail reaches the reply meta through chat.cjs (the fixture verdict carries its cause)', async (t) => {
  const r = await run(t, { flag: true, settings: HYBRID, message: 'Reply with the word ok.', verdict: 'fail-cause' });
  assert.deepEqual(r.meta.routing, { route: 'local', reason: 'check-unavailable', detail: 'deadline' });
  assert.equal(r.upstream.length, 1); assert.ok(r.upstream[0].url.startsWith(LOCAL), 'answered by the local model');
  assert.equal(r.upstream.some((u) => u.url.startsWith(CLOUD)), false, 'nothing reached the cloud');
});

test('#1438: a check that could not answer, with no local model, is refused: 409, no card, zero upstream requests', async (t) => {
  const r = await run(t, { flag: true, settings: HYBRID, message: 'Reply with the word ok.', verdict: 'fail-cause', localRoles: {} });
  assert.equal(r.sensitivityCalls.length, 1, 'the check was asked once');
  assert.equal(r.events.some((e) => e.type === 'route_pending'), false, 'no card for a check that could not answer');
  assert.equal(r.upstream.length, 0, 'no model, local or cloud, was contacted');
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].status, 409);
  assert.match(r.errors[0].body.error, /Nothing was sent/);
});

// ── #1640: the real decision-service chain inside a chat turn ────────────────
// A synthetic decision service on loopback answering in Laya's shape, wired as server/index.cjs wires
// it (decision settings -> endpoint -> decision layer -> createSensitivity). Before #1640 its
// confidence was null, so every answer fell back as "unavailable (low-confidence)" and no card showed.
async function decisionServiceCheck(t, reply, { log = () => {}, seen = [] } = {}) {
  const server = require('node:http').createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null; try { parsed = JSON.parse(body); } catch { /* recorded as null */ }
      seen.push(parsed);
      const r = typeof reply === 'function' ? reply(parsed) : reply;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(typeof r === 'string' ? r : JSON.stringify(r));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const kv = new Map();
  const settings = require('./decision-settings.cjs').createDecisionSettings({ store: { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) }, env: {} });
  settings.save({ url: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1500 }, 'admin');
  const decisions = createDecisions({ backends: { configured: settings.backend() }, chains: { 'routing.sensitivity': ['configured'] } });
  return rm.createSensitivity({ decide: decisions.decide, log, qualified: SYN_QUALIFIED });
}
// Laya's reply shape, from a synthetic model that reports its identity (#1647) and is on the test-only list.
const layaReply = (selected, sensitive) => ({ selected, scores: { sensitive, not_sensitive: Math.round((1 - sensitive) * 100) / 100 }, model: SYN_IDENTITY.model, model_revision: SYN_IDENTITY.revision, calibrated: false });

test('#1640: through the real decision service, "sensitive" at 0.97 shows the card and "not sensitive" at 0.97 goes to cloud', async (t) => {
  const message = 'Synthetic test: Ada (fictional) keeps her made-up account numbers in a notebook.';
  const flagged = await run(t, { flag: true, settings: HYBRID, message, answer: { choice: 'local' }, sensitivity: await decisionServiceCheck(t, layaReply('sensitive', 0.97)) });
  assert.equal(flagged.events.find((e) => e.type === 'route_pending')?.flag, 'router', 'the "This looks sensitive" card is shown');
  assert.deepEqual(flagged.meta.routing, { route: 'local', reason: 'user-choice' });
  assert.equal(flagged.upstream.some((u) => u.url.startsWith(CLOUD)), false, 'nothing reached the cloud');
  const clear = await run(t, { flag: true, settings: HYBRID, message: 'Reply with the word ok.', sensitivity: await decisionServiceCheck(t, layaReply('not_sensitive', 0.03)) });
  assert.equal(clear.events.some((e) => e.type === 'route_pending'), false);
  assert.deepEqual(clear.meta.routing, { route: 'cloud', reason: 'mode' });
  assert.ok(clear.upstream[0].url.startsWith(CLOUD));
});

test('#1640: through the real decision service, a low score or a garbled reply stays local with no card', async (t) => {
  for (const [reply, detail] of [[layaReply('not_sensitive', 0.45), 'low-confidence'], ['{"selected":"not_sensitive"', 'parse']]) {
    const r = await run(t, { flag: true, settings: HYBRID, message: 'Reply with the word ok.', sensitivity: await decisionServiceCheck(t, reply) });
    assert.equal(r.events.some((e) => e.type === 'route_pending'), false, detail);
    assert.deepEqual(r.meta.routing, { route: 'local', reason: 'check-unavailable', detail }, detail);
    assert.equal(r.upstream.some((u) => u.url.startsWith(CLOUD)), false, `${detail}: nothing reached the cloud`);
  }
});

// ── #1640 review: only a check that saw everything a cloud route sends may clear it ──
// The router reads one 1,000-character chunk by default. A fake decision service that answers
// "sensitive" only when it sees the marker, else "not sensitive" at 0.9: if the marker was past what
// the router could read, the old check cleared the turn and sent the marker to the cloud.
const PRIVATE_MARKER = 'ZEBRA-PRIVATE-MARKER-4471';
const markerAware = (body) => (String(body?.state || '').includes(PRIVATE_MARKER) ? layaReply('sensitive', 0.97) : layaReply('not_sensitive', 0.1));
const padding = (n) => 'Synthetic filler about widgets and gears. '.repeat(Math.ceil(n / 42)).slice(0, n);

async function partialRun(t, options) {
  const logs = [], seen = [];
  const r = await run(t, { flag: true, settings: HYBRID, answer: { choice: 'cloud' }, ...options, sensitivity: await decisionServiceCheck(t, markerAware, { log: (e) => logs.push(e), seen }) });
  return { ...r, checkLogs: logs, seen };
}
function assertKeptLocal(r, label) {
  assert.equal(r.upstream.some((u) => u.url.startsWith(CLOUD)), false, `${label}: nothing reached the cloud`);
  assert.ok(r.upstream.length >= 1 && r.upstream.every((u) => u.url.startsWith(LOCAL)), `${label}: answered locally`);
  assert.deepEqual(r.meta.routing, { route: 'local', reason: 'check-unavailable', detail: 'partial' }, label);
  assert.equal(r.events.some((e) => e.type === 'route_pending'), false, `${label}: no card (#1421)`);
  assert.deepEqual(r.checkLogs.map((e) => [e.verdict, e.cause]), [['unavailable', 'partial']], `${label}: the decision log says partial`);
  assert.equal(r.seen.length, 0, `${label}: a partial view is not asked`);
}

test('#1640 review: a marker past character 1,000 of the message keeps the turn local (partial), never cloud', async (t) => {
  const message = `Synthetic test, please tidy this note. ${padding(1100)} ${PRIVATE_MARKER} ends here.`;
  assert.ok(message.indexOf(PRIVATE_MARKER) > 1000);
  assertKeptLocal(await partialRun(t, { message }), 'long message');
});

test('#1640 review: a marker deep in project excerpts or a free chat\'s attached file keeps the turn local (partial)', async (t) => {
  const excerpt = (opts) => `${opts?.attached ? 'The user attached these files to this chat' : 'Sources'} (1): "notes.md"\n<untrusted kind="file">${padding(1200)} ${PRIVATE_MARKER}</untrusted>`;
  const ragOverride = { filesContext: async (_p, _files, _q, _u, onSources, opts) => { onSources([]); return excerpt(opts); } };
  const files = [{ name: 'notes.md', content: 'synthetic' }];
  // A project's knowledge-file excerpts ride in the system prompt; a free chat's attached file with the turn.
  assertKeptLocal(await partialRun(t, { message: 'Summarize my notes.', ragOverride, project: { files } }), 'project excerpts');
  assertKeptLocal(await partialRun(t, { message: 'Summarize this file.', ragOverride, freeChatId: 'c-synthetic-1640', project: { files } }), 'free-chat attached file');
});

test('#1640 review: a marker in a 1,200-character history entry keeps the turn local (partial), also past the history truncation', async (t) => {
  const entry = (role, content) => ({ role, content });
  // One long entry, the marker past the router's first 1,000 characters.
  const long = [entry('user', `Earlier note. ${padding(1200)} ${PRIVATE_MARKER} end.`), entry('assistant', 'Noted.')];
  assert.ok(long[0].content.length >= 1200 && long[0].content.indexOf(PRIVATE_MARKER) > 1000);
  assertKeptLocal(await partialRun(t, { message: 'Reply with the word ok.', history: long }), 'one 1,200-character history entry');
  // More than 40 entries reach the server (the fixture's cap is raised past it): the router reads the newest 40, so the
  // oldest entry, which carries the marker and is still sent, is not covered.
  const many = [entry('user', `Earliest: ${PRIVATE_MARKER}`), ...Array.from({ length: 44 }, (_, i) => entry(i % 2 ? 'assistant' : 'user', `Short synthetic turn ${i}.`))];
  assertKeptLocal(await partialRun(t, { message: 'Reply with the word ok.', history: many, historyCap: 100 }), '45 history entries');
  // With the fixture's own cap of 20 the oldest entries are dropped before anything is sent, so only what is sent is judged.
  const capped = await partialRun(t, { message: 'Reply with the word ok.', history: many });
  assert.equal(JSON.stringify(capped.upstream.map((u) => u.body)).includes(PRIVATE_MARKER), false, 'a truncated entry is not sent');
});

test('#1640 review: a short turn the router sees whole is still decided by the service: clear goes to cloud, the marker shows the card', async (t) => {
  const clear = await partialRun(t, { message: 'Reply with the word ok.' });
  assert.deepEqual(clear.meta.routing, { route: 'cloud', reason: 'mode' });
  assert.ok(clear.upstream[0].url.startsWith(CLOUD));
  assert.equal(clear.seen.length, 1);
  assert.deepEqual(clear.checkLogs.map((e) => e.verdict), ['clear']);
  const marked = await partialRun(t, { message: `Synthetic: keep ${PRIVATE_MARKER} to yourself.`, answer: { choice: 'local' } });
  assert.equal(marked.events.find((e) => e.type === 'route_pending')?.flag, 'router');
  assert.equal(marked.upstream.some((u) => u.url.startsWith(CLOUD)), false);
});

test('#1640 review: routerInput reports complete only when nothing that is sent was dropped or cut', () => {
  const small = rm.routerInput({ message: 'hi', system: 'short context', history: [{ role: 'user', content: 'earlier' }], attachments: ['a.md'] });
  assert.equal(small.complete, true);
  assert.equal(small.chunks.length, 1);
  assert.deepEqual(rm.routerChunks({ message: 'hi' }), rm.routerInput({ message: 'hi' }).chunks, 'routerChunks is routerInput\'s chunks');
  const cut = (input, label) => assert.equal(rm.routerInput(input).complete, false, label);
  cut({ message: padding(1200) }, 'a long message');
  cut({ message: 'hi', system: padding(1200) }, 'long context');
  cut({ message: 'hi', history: [{ role: 'user', content: padding(1200) }] }, 'a long history entry');
  cut({ message: 'hi', history: Array.from({ length: 41 }, () => ({ role: 'user', content: 'x' })) }, 'more than 40 history entries');
  cut({ message: 'hi', attachments: Array.from({ length: 80 }, (_, i) => `file-${i}-synthetic-name.md`) }, 'many attachment names');
  // Every section that fits is complete, also with several chunks.
  assert.equal(rm.routerInput({ message: padding(1200) }, { maxChunks: 2 }).complete, true);
  // An applied write's target and arguments are sent with it, so the router reads them too.
  const applied = rm.routerInput({ message: 'hi', history: [{ role: 'tool', content: '', name: 'write_file', applied: true, target: 'notes/a.md', args: `{"text":"${PRIVATE_MARKER}"}` }] });
  assert.ok(applied.chunks.join('').includes(PRIVATE_MARKER));
  // Empty input: nothing to ask (the check fails closed on it as no-input).
  assert.deepEqual(rm.routerInput({}), { chunks: [], complete: true });
});

test('#1640 review: createSensitivity does not ask about a partial input, and a plain array keeps its meaning', async () => {
  let asked = 0;
  const decide = async () => { asked += 1; return { selected: 'not_sensitive', scores: { sensitive: 0.1, not_sensitive: 0.9 }, confidence: 0.9 }; };
  const logs = [];
  const check = qualifiedSensitivity({ decide, log: (e) => logs.push(e) });
  assert.deepEqual(await check({ chunks: ['a'], complete: false }), { flagged: true, flag: 'unavailable', cause: 'partial' });
  assert.deepEqual(await check({ chunks: ['a'] }), { flagged: true, flag: 'unavailable', cause: 'partial' }, 'no complete:true is partial');
  assert.equal(asked, 0);
  assert.equal(logs[0].cause, 'partial');
  // More chunks than the check may ask about is partial too.
  const capped = qualifiedSensitivity({ decide, maxChunks: 1 });
  assert.deepEqual(await capped({ chunks: ['a', 'b'], complete: true }), { flagged: true, flag: 'unavailable', cause: 'partial' });
  assert.deepEqual(await check({ chunks: ['a'], complete: true }), { flagged: false, flag: null });
  assert.deepEqual(await check({ chunks: [], complete: true }), { flagged: true, flag: 'unavailable', cause: 'no-input' });
  assert.deepEqual(await check(['a']), { flagged: false, flag: null });
  assert.equal(asked, 2);
});

// #1592: a web search result about a condition is public text, not the user's data, so the health rule does not
// hold it on a cloud route. The user's own files, and any tool not positively public, are still held for health.
const HEALTH_TEXT = 'How diabetes is diagnosed: a fasting glucose test; diagnosis of type 2 diabetes needs two results.';
test('#1592: the health rule does not hold a public web-search result on a cloud route; secrets still are', async (t) => {
  const web = [{ id: 'web-search', tools: ['tavily_search'] }];
  const r = await run(t, { flag: true, settings: { ...HYBRID, mode: 'cloud' }, message: 'How is diabetes diagnosed?', project: { toolboxes: ['web-search'] },
    toolBoxes: web, toolName: 'tavily_search', toolResult: HEALTH_TEXT });
  assert.equal(r.events.some((e) => e.type === 'paused'), false, JSON.stringify(r.events.find((e) => e.type === 'paused')));
  assert.equal(r.upstream.length, 2); assert.ok(r.upstream[1].url.startsWith(CLOUD));
  const secret = await run(t, { flag: true, settings: { ...HYBRID, mode: 'cloud' }, message: 'Search it', project: { toolboxes: ['web-search'] },
    toolBoxes: web, toolName: 'tavily_search', toolResult: `Account on file: ${SYN_IBAN}` });
  assert.equal(secret.events.find((e) => e.type === 'paused')?.flag, 'iban');
});

test('#1592: a private-data or unknown tool result with health text is still held from the cloud', async (t) => {
  const own = await run(t, { flag: true, settings: HYBRID, message: 'Summarize my latest letter.', chat: { allowCloud: true }, project: { toolboxes: ['nextcloud-files'] },
    toolBoxes: FILES_BOX, toolName: 'files_read_synthetic', toolResult: HEALTH_TEXT });
  assert.equal(own.events.find((e) => e.type === 'paused')?.flag, 'health');
  assert.equal(JSON.stringify(own.upstream).includes('fasting glucose'), false);
  const unknown = await run(t, { flag: true, settings: { ...HYBRID, mode: 'cloud' }, toolResult: HEALTH_TEXT });
  assert.equal(unknown.events.find((e) => e.type === 'paused')?.flag, 'health', 'a tool in no known box is not treated as public');
});

test('#1592: preRule skips only the health rule when asked', () => {
  assert.equal(rm.preRule(HEALTH_TEXT), 'health');
  assert.equal(rm.preRule(HEALTH_TEXT, { health: false }), null);
  assert.equal(rm.preRule(`${HEALTH_TEXT} ${SYN_IBAN}`, { health: false }), 'iban');
});
