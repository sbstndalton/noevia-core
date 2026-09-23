'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-history-route-test-'));
process.env.DIARY_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_DATA_DIR = testDataDir;
process.env.LEGACY_AUTH_COMPAT = 'true';
process.env.PUBLIC_ORIGIN = 'http://localhost';

const { handleRequest } = require('./index.cjs');

test.after(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function request(url, { method = 'GET', headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.url = url;
  req.method = method;
  req.headers = { host: 'localhost', ...headers };

  const chunks = [];
  const responseHeaders = {};
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = (name, value) => { responseHeaders[name] = value; };
  res.writeHead = (status, nextHeaders = {}) => {
    res.statusCode = status;
    res.headersSent = true;
    Object.assign(responseHeaders, nextHeaders);
    return res;
  };

  const finished = new Promise((resolve, reject) => {
    res.once('finish', resolve);
    res.once('error', reject);
  });
  await handleRequest(req, res);
  await finished;
  return { status: res.statusCode, headers: responseHeaders, text: Buffer.concat(chunks).toString('utf8'), bytes: Buffer.concat(chunks) };
}

let cookie = '';
let csrf = '';
test.before(async () => {
  const setupCode = fs.readFileSync(path.join(testDataDir, 'first-run-setup-code'), 'utf8').trim();
  const setup = await request('/api/setup/complete', {
    method: 'POST', headers: { origin: 'http://localhost' },
    body: JSON.stringify({ setupCode, publicOrigin: 'http://localhost', username: 'admin', displayName: 'Admin', password: 'correct horse battery staple' }),
  });
  assert.equal(setup.status, 201);
  const login = await request('/api/auth/login/password', {
    method: 'POST', headers: { origin: 'http://localhost' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }),
  });
  assert.equal(login.status, 200);
  const setCookies = login.headers['set-cookie'] || login.headers['Set-Cookie'] || [];
  cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookie, 'login must set a session cookie');
  const csrfPair = setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('cowork_csrf='));
  assert.ok(csrfPair, 'login must set the CSRF cookie');
  csrf = decodeURIComponent(csrfPair.split('=').slice(1).join('='));
});

const mutationHeaders = () => ({ origin: 'http://localhost', cookie, 'content-type': 'application/json', 'x-csrf-token': csrf });

const post = (url, body, headers = mutationHeaders()) => request(url, { method: 'POST', headers, body: JSON.stringify(body) });
const realFetch = global.fetch;

test('saving a long chat keeps every message, not just the last 40', async () => {
  const history = Array.from({ length: 120 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `synthetic message ${i}` }));
  const saved = await post('/api/chats/c-long-history/history', { history });
  assert.equal(saved.status, 200, saved.text);
  const read = JSON.parse((await request('/api/chats/c-long-history/history', { headers: mutationHeaders() })).text).history;
  assert.equal(read.length, 120);
  assert.equal(read[0].content, 'synthetic message 0');
});

test('a history larger than 1 MB (long reasoning and tool results) still saves', async () => {
  const big = 'x'.repeat(40_000);
  const history = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}`, reasoning: i % 2 ? big : undefined }));
  const saved = await post('/api/chats/c-big-history/history', { history });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(JSON.parse((await request('/api/chats/c-big-history/history', { headers: mutationHeaders() })).text).history.length, 60);
});

test('history saves carry a revision; a save based on a stale revision is refused with the current copy', async () => {
  const first = [{ role: 'user', content: 'phone question' }];
  await post('/api/chats/c-two-devices/history', { history: first });
  const read = JSON.parse((await request('/api/chats/c-two-devices/history', { headers: mutationHeaders() })).text);
  assert.match(read.revision, /^[a-f0-9]{64}$/);
  const laptop = [...first, { role: 'assistant', content: 'laptop answer' }];
  assert.equal((await post('/api/chats/c-two-devices/history', { history: laptop, baseRevision: read.revision })).status, 200);
  const phone = [...first, { role: 'assistant', content: 'phone answer' }];
  const stale = await post('/api/chats/c-two-devices/history', { history: phone, baseRevision: read.revision });
  assert.equal(stale.status, 409);
  const body = JSON.parse(stale.text);
  assert.deepEqual(body.history.map((m) => m.content), ['phone question', 'laptop answer']);
  assert.match(body.revision, /^[a-f0-9]{64}$/);
  assert.equal((await post('/api/chats/c-two-devices/history', { history: phone })).status, 200, 'saves without a base revision still work (older clients)');
});

test('routing details round-trip through history and remain on conflict copies', async () => {
  const routingDecision = { offered: [{ id: 'fast', label: 'Short answer' }, { id: 'smart', label: 'Reasoning' }],
    scores: { fast: 0.2, smart: 0.8 }, selectedRole: 'smart', effectiveRole: 'smart',
    backend: 'decision-service', model: 'convaiinnovations/laya', calibrated: false,
    latencyMs: 37, status: 'accepted', fallbackReason: null };
  const history = [{ role: 'assistant', content: 'Synthetic answer', model: 'Assistant · Auto (smart)', routingDecision }];
  assert.equal((await post('/api/chats/c-routing-details/history', { history })).status, 200);
  const read = JSON.parse((await request('/api/chats/c-routing-details/history', { headers: mutationHeaders() })).text);
  assert.deepEqual(read.history[0].routingDecision, routingDecision);
  const concurrent = [...history, { role: 'user', content: 'Another turn' }];
  assert.equal((await post('/api/chats/c-routing-details/history', { history: concurrent, baseRevision: read.revision })).status, 200);
  const stale = await post('/api/chats/c-routing-details/history', { history, baseRevision: read.revision });
  assert.equal(stale.status, 409);
  assert.deepEqual(JSON.parse(stale.text).history[0].routingDecision, routingDecision);
});

test('a malformed or conflicting routing field never corrupts the saved copy or leaks into another chat', async () => {
  const goodDecision = { offered: [{ id: 'fast', label: 'Short answer' }, { id: 'smart', label: 'Reasoning' }],
    scores: { fast: 0.4, smart: 0.6 }, selectedRole: 'smart', effectiveRole: 'smart',
    backend: 'decision-service', model: 'convaiinnovations/laya', calibrated: false,
    latencyMs: 11, status: 'accepted', fallbackReason: null };
  const base = [{ role: 'assistant', content: 'Sibling chat answer', routingDecision: goodDecision }];
  assert.equal((await post('/api/chats/c-routing-sibling/history', { history: base })).status, 200);

  const target = [{ role: 'assistant', content: 'Target chat answer', routingDecision: goodDecision }];
  assert.equal((await post('/api/chats/c-routing-malformed/history', { history: target })).status, 200);
  const read = JSON.parse((await request('/api/chats/c-routing-malformed/history', { headers: mutationHeaders() })).text);

  // Two concurrent devices race to save the same chat: one carries a malformed
  // routingDecision shape (a bare string instead of the expected object).
  const laptop = [...target, { role: 'assistant', content: 'laptop answer', routingDecision: 'not-an-object' }];
  assert.equal((await post('/api/chats/c-routing-malformed/history', { history: laptop, baseRevision: read.revision })).status, 200);

  const phone = [...target, { role: 'assistant', content: 'phone answer', routingDecision: { selectedRole: 'smart', scores: 'nope', offered: null } }];
  const stale = await post('/api/chats/c-routing-malformed/history', { history: phone, baseRevision: read.revision });
  assert.equal(stale.status, 409);
  const conflictBody = JSON.parse(stale.text);
  // The server returns exactly what won the race (laptop), untouched and not merged
  // with the malformed phone payload, and does not throw handling the bad shape.
  assert.deepEqual(conflictBody.history.map((m) => m.content), ['Target chat answer', 'laptop answer']);
  assert.equal(conflictBody.history.at(-1).routingDecision, 'not-an-object');
  assert.match(conflictBody.revision, /^[a-f0-9]{64}$/);

  // Retrying the phone save against the now-current revision persists the malformed
  // field as data (never crashes, never silently drops the message) but the sibling
  // chat's own routing detail is untouched by any of this.
  const currentRead = JSON.parse((await request('/api/chats/c-routing-malformed/history', { headers: mutationHeaders() })).text);
  const retried = await post('/api/chats/c-routing-malformed/history', { history: phone, baseRevision: currentRead.revision });
  assert.equal(retried.status, 200);
  const final = JSON.parse((await request('/api/chats/c-routing-malformed/history', { headers: mutationHeaders() })).text);
  assert.deepEqual(final.history.at(-1).routingDecision, { selectedRole: 'smart', scores: 'nope', offered: null });

  const sibling = JSON.parse((await request('/api/chats/c-routing-sibling/history', { headers: mutationHeaders() })).text);
  assert.deepEqual(sibling.history[0].routingDecision, goodDecision, 'malformed routing on one chat must never cross-assign into another');
});

test('cross-feature: Laya success, worker timeout falls back safely, later request recovers, and concurrent Auto replies keep separate metadata through SSE and history save/reload', async (t) => {
  const { createChatHandler } = require('./chat.cjs');
  const { createToolboxes } = require('./toolboxes.cjs');
  const { createSystemOneRouter } = require('./system-one-router.cjs');
  const { createToolExchange } = require('./tool-exchange.cjs');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-crossfeature-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const router = createSystemOneRouter({
    enabled: () => true, roles: () => ({ fast: 'fast-model', smart: 'smart-model' }),
    fallback: () => 'fast', log: () => {}, backend: { supports: () => true, locality: 'local',
      decide: async (request) => {
        if (request.context.stateText === 'trigger a worker timeout') {
          throw Error('private synthetic backend error at http://internal-worker.invalid/decide with api-key sk-secret-synthetic');
        }
        const first = request.context.stateText === 'first concurrent turn';
        return { selected: first ? 'smart' : 'fast', scores: first ? { fast: 0.15, smart: 0.85 } : { fast: 0.7, smart: 0.3 },
          metadata: { model: 'convaiinnovations/laya', calibrated: false } };
      } },
  });

  async function runChat({ chatId, message, project }) {
    const user = { id: 'synthetic-user' };
    const store = { workspace: { userId: user.id }, authn: { user } };
    const requestScope = { getStore: () => store, run: (_scope, fn) => fn() };
    const driveTools = { box: { id: 'gdrive', tools: [] }, connected: () => false, execute: async () => 'unused' };
    const toolbox = createToolboxes({
      boxes: [], driveTools, offered: () => false, mcpBoxes: () => [], mcpTools: () => new Map(),
      prefill: { budgetFor: () => null, rateFor: () => 0 }, requestScope, scope: requestScope,
      documentSources: { notice: () => '' }, workspace: () => ({ dir }),
    });
    const events = [];
    const res = new EventEmitter();
    res.writeHead = () => {};
    res.write = (line) => events.push(JSON.parse(line.slice(6)));
    res.end = () => { res.writableEnded = true; res.emit('finish'); };
    const fetch = async () => ({ ok: true, body: (async function* () {
      yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Synthetic reply.' } }] })}\n\n`);
    })() });
    const handler = createChatHandler({
      fs, path, crypto, fetch, reasoningEffort: require('./reasoning-effort.cjs'), createToolExchange,
      rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: require('./tool-result-reduce.cjs').reduceToolResult,
      HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000,
      authService: { audit() {} }, toolPolicy: { mode: () => 'allow' },
      modelManager: { enabled: true, load: async () => ({ ok: true }), health: async () => ({ ok: true, body: { all_models_loaded: ['synthetic-model', 'fast-model', 'smart-model'].map((model_name) => ({ model_name, loaded: true, recipe_options: { ctx_size: 32768 } })) } }) },
      requestScope, currentWorkspace: () => ({ userId: user.id, dir }), json() {}, getProject: () => project,
      getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid', label: 'Mock' }), providerHeaders: () => ({}), saveChats() {}, endpointApproved: () => true,
      diaryHeaders: () => ({}), diaryExtras: require('./diary-extras.cjs'), autoRoles: () => ({ fast: 'fast-model', smart: 'smart-model' }), lastLoadedModel: () => null,
      classifyFastOrSmart: async (msg) => router.classifyWithDetails(msg),
      servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
      visionProbe: async () => ({ supported: false, reason: 'none' }), visionDescriptions: new Map(), skillsIndexFor: () => [],
      chatSkillRouter: { select: async () => ({ loaded: [] }) }, chatToolRouter: { select: async (ids) => ({ ids, routed: false }) },
      ...toolbox, oauthServerIds: () => new Set(), accountReady: () => true,
      chatWideApproved: () => false, awaitApproval: async () => 'approve',
      recordUsage() {}, recordToolUse() {},
    });
    await handler.handleChat({}, res, { message, projectId: project.id, chatId, history: [] });
    return events;
  }

  const project = { id: 'synthetic-project', model: 'synthetic-model', routing: 'auto', toolboxes: [], files: [] };

  // 1) A real Laya decision succeeds.
  const successEvents = await runChat({ chatId: 'c-cross-success', message: 'plain first message', project });
  const successMeta = successEvents.find((e) => e.type === 'meta');
  assert.equal(successMeta.routingDecision.status, 'accepted');

  // 2) A fake worker timeout: the request still completes and reports a bounded,
  // safe fallback — no backend error text, URL, or credentials anywhere in the SSE stream.
  const fallbackEvents = await runChat({ chatId: 'c-cross-fallback', message: 'trigger a worker timeout', project });
  const fallbackMeta = fallbackEvents.find((e) => e.type === 'meta');
  assert.equal(fallbackMeta.routingDecision.status, 'fallback');
  assert.equal(fallbackMeta.routingDecision.fallbackReason, 'no-backend-answered');
  assert.deepEqual(fallbackMeta.routingDecision.scores, {});
  const fallbackDump = JSON.stringify(fallbackEvents);
  assert.ok(!fallbackDump.includes('private synthetic'));
  assert.ok(!fallbackDump.includes('internal-worker.invalid'));
  assert.ok(!fallbackDump.includes('sk-secret-synthetic'));
  assert.equal(fallbackEvents.some((e) => e.type === 'error'), false);

  // 3) A later request succeeds again after the fallback.
  const recoveredEvents = await runChat({ chatId: 'c-cross-recovered', message: 'plain later message', project });
  assert.equal(recoveredEvents.find((e) => e.type === 'meta').routingDecision.status, 'accepted');

  // 4) Concurrent Auto requests keep separate metadata through SSE...
  const [firstEvents, secondEvents] = await Promise.all([
    runChat({ chatId: 'c-cross-concurrent-1', message: 'first concurrent turn', project }),
    runChat({ chatId: 'c-cross-concurrent-2', message: 'second concurrent turn', project }),
  ]);
  const firstMeta = firstEvents.find((e) => e.type === 'meta');
  const secondMeta = secondEvents.find((e) => e.type === 'meta');
  assert.equal(firstMeta.route, 'smart'); assert.deepEqual(firstMeta.routingDecision.scores, { fast: 0.15, smart: 0.85 });
  assert.equal(secondMeta.route, 'fast'); assert.deepEqual(secondMeta.routingDecision.scores, { fast: 0.7, smart: 0.3 });

  // ...and through history save/reload: each chat persists only its own routing detail.
  await post('/api/chats/c-cross-concurrent-1/history', { history: [{ role: 'assistant', content: 'first reply', routingDecision: firstMeta.routingDecision }] });
  await post('/api/chats/c-cross-concurrent-2/history', { history: [{ role: 'assistant', content: 'second reply', routingDecision: secondMeta.routingDecision }] });
  const reload1 = JSON.parse((await request('/api/chats/c-cross-concurrent-1/history', { headers: mutationHeaders() })).text);
  const reload2 = JSON.parse((await request('/api/chats/c-cross-concurrent-2/history', { headers: mutationHeaders() })).text);
  assert.deepEqual(reload1.history[0].routingDecision, firstMeta.routingDecision);
  assert.deepEqual(reload2.history[0].routingDecision, secondMeta.routingDecision);
  assert.notDeepEqual(reload1.history[0].routingDecision, reload2.history[0].routingDecision);
});
