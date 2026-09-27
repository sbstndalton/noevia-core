'use strict';
// The chat loop on a Sign in with ChatGPT provider (#447), end to end through createChatHandler
// with the real adapter and a fake OpenAI (*.fixture.invalid). Proves the external-provider rules
// in provider-egress.cjs: flag off refuses, the OAuth bearer (not an apiKey) is on the wire, Diary
// tools, Diary extras and project images never reach it, and a refused refresh says "Reconnect".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const Database = require('better-sqlite3');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createSecretStore } = require('./secrets.cjs');
const chatgpt = require('./chatgpt-oauth.cjs');
const egress = require('./provider-egress.cjs');

const ISSUER = 'https://auth.fixture.invalid';
const CODEX = 'https://codex.fixture.invalid';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = `${b64({ alg: 'none' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-synthetic' } })}.sig`;
const reply = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const BOXES = [
  { id: 'core', tools: [{ type: 'function', function: { name: 'core_time' } }] },
  { id: 'diary', tools: [{ type: 'function', function: { name: 'diary_search' } }] },
  { id: 'nextcloud-files', tools: ['nc_webdav_read_file', 'nc_webdav_search_files', 'nc_webdav_find_by_name', 'nc_webdav_list_directory'].map((name) => ({ type: 'function', function: { name } })) },
];
const STORAGE = { kind: 'nextcloud', baseUrl: 'https://cloud.fixture.invalid/remote.php/dav/files/synthetic', corpusRoot: 'Documents/Important Documents/Diary' };

async function setup(t, { flag = true, connected = true, refresh = 'ok', storage = STORAGE, localResponse = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-chatgpt-egress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'img-1'), Buffer.from('synthetic image bytes'));
  const upstream = { responses: [], queue: [] };
  const fakeOpenAI = async (url, init) => {
    url = String(url);
    if (url.endsWith('/deviceauth/usercode')) return reply({ device_auth_id: 'D', user_code: 'CODE-0000', interval: '1' });
    if (url.endsWith('/deviceauth/token')) return reply({ authorization_code: 'A', code_challenge: 'C', code_verifier: 'V' });
    if (url.endsWith('/oauth/token')) {
      if (String(init.body).includes('refresh_token') && refresh === 'invalid') return reply({ error: 'invalid_grant' }, 400);
      return reply({ access_token: String(init.body).includes('refresh_token') ? 'AT-new' : 'AT-first', refresh_token: 'RT', id_token: idToken, expires_in: 3600 });
    }
    if (url === `${CODEX}/responses`) {
      upstream.responses.push({ headers: init.headers, body: JSON.parse(init.body) });
      const next = upstream.queue.shift();
      if (next) return next();
      return new Response(['response.output_text.delta', 'response.completed'].map((type) => `data: ${JSON.stringify(type === 'response.completed' ? { type, response: { usage: { input_tokens: 3, output_tokens: 1 } } } : { type, delta: 'Hello from the fake' })}\n\n`).join(''), { status: 200 });
    }
    throw new Error('unexpected upstream ' + url);
  };
  const clock = { t: 1_800_000_000_000 };
  const oauth = chatgpt.createChatGptOAuth({ db: new Database(':memory:'), secrets: createSecretStore(dir, { env: {} }), fetchImpl: fakeOpenAI, now: () => clock.t, config: { issuer: ISSUER, codexBaseUrl: CODEX } });
  if (connected) {
    const l = await oauth.startDeviceLogin('user-a');
    clock.t += 1000;
    assert.equal((await oauth.pollDeviceLogin('user-a', l.loginId)).state, 'connected');
  }
  const row = chatgpt.providerRow();
  const localFetch = [];
  const executed = [];
  const run = async ({ body = {}, user = { id: 'user-a', role: 'member' }, workspaceUser = user.id, project = {} } = {}) => {
    const events = []; let refused = null; let offered = null;
    const res = new EventEmitter();
    res.writeHead = () => {}; res.write = (line) => { if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); };
    res.end = () => { res.writableEnded = true; res.emit('finish'); };
    const theProject = { id: 'fixture-project', model: 'gpt-synthetic', routing: 'manual', provider: 'chatgpt-oauth', toolboxes: ['core', 'diary'],
      assets: [{ id: 'img-1', name: 'receipt.png', mime: 'image/png' }], ...project };
    const { handleChat } = createChatHandler({
      // The default-provider fetch: must never carry a ChatGPT chat.
      fetch: async (url, init) => { localFetch.push(String(url)); if (localResponse) return localResponse(init); throw new Error('the local fetch was used for an external provider'); },
      chatgptOAuth: oauth, chatgptEnabled: () => flag,
      modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'gpt-synthetic', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
      reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {}, diaryEnabled: () => true, getStorage: () => storage },
      crypto: require('node:crypto'), path, fs, HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
      currentWorkspace: () => ({ userId: workspaceUser, dir, assetDir: () => dir }),
      getProject: (id) => (id === theProject.id || id === require('./diary-extras.cjs').PROJECT_ID ? { ...theProject, id } : null),
      skillsIndexFor: () => [], getProvider: (id) => (id === 'chatgpt-oauth' ? row : { id: 'default', baseUrl: 'http://fixture.invalid' }), providerHeaders: () => ({ 'Content-Type': 'application/json' }),
      autoRoles: () => null, visionDescriptions: new Map(), visionProbe: async () => { throw new Error('no vision probe for an external provider'); },
      chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true,
      chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
      toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({ authn: { user } }) },
      resolveTools: (p, _m, blocked) => ({ tools: BOXES.filter((b) => p.toolboxes.includes(b.id)).flatMap((b) => b.tools).filter((x) => !blocked(x.function.name)), dropped: [] }),
      isWriteTool: () => false, rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
      DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: (_res, status, b) => { refused = { status, body: b }; }, saveChats() {}, endpointApproved: () => false, diaryHeaders: () => ({}),
      lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
      allToolboxes: () => BOXES, executeToolCall: async (_p, name, args) => { executed.push({ name, args: JSON.parse(args) }); return 'synthetic file text'; }, chatWideApproved: () => false, awaitApproval: async () => 'deny', recordUsage() {}, recordToolUse() {},
    });
    // A thrown handler leaves the SSE heartbeat running; end the fake response so the test exits.
    try { await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'synthetic question', ...body }, { user }); }
    finally { if (!res.writableEnded) res.end(); }
    const sent = upstream.responses.at(-1);
    if (sent) offered = (sent.body.tools || []).map((x) => x.name);
    return { events, refused, offered, sent };
  };
  return { run, upstream, localFetch, oauth, executed };
}

test('flag off: a chat pinned to the ChatGPT provider is refused before anything is sent', { timeout: 20000 }, async (t) => {
  const f = await setup(t, { flag: false });
  const r = await f.run();
  assert.equal(r.refused.status, 409);
  assert.match(r.refused.body.error, /turned off/);
  assert.equal(f.upstream.responses.length, 0);
  assert.deepEqual(f.localFetch, []);
});

test('flag on: the chat streams through the adapter with the OAuth bearer; Diary tools and images stay home', { timeout: 20000 }, async (t) => {
  const f = await setup(t);
  const r = await f.run();
  assert.equal(r.refused, null, JSON.stringify(r.refused));
  assert.deepEqual(f.localFetch, [], 'the default provider fetch was not used');
  assert.equal(r.sent.headers.authorization, 'Bearer AT-first');
  assert.equal(r.sent.headers['chatgpt-account-id'], 'acct-synthetic');
  assert.deepEqual(r.offered, ['core_time'], 'the private Diary toolbox is not offered to an external provider');
  assert.equal(JSON.stringify(r.sent.body).includes('input_image'), false, 'project images are not attached');
  assert.equal(JSON.stringify(r.sent.body).includes('synthetic image bytes'), false);
  assert.ok(r.events.some((e) => e.type === 'warning' && /never sent to ChatGPT automatically/.test(e.text)));
  assert.equal(r.events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello from the fake');
  assert.ok(r.events.some((e) => e.type === 'done'));
  const usage = r.events.filter((e) => e.type === 'usage').at(-1);
  assert.equal(usage.promptTokens, 3);
});

test('Diary text never goes to an external provider: Diary extras on the ChatGPT provider are refused', { timeout: 20000 }, async (t) => {
  const f = await setup(t);
  const r = await f.run({ body: { spaceId: 'diary-extras', extrasEnabled: true, sessionId: 's1', message: 'Synthetic diary line' } });
  assert.equal(r.refused.status, 409);
  assert.match(r.refused.body.error, /Diary text is never sent to an external provider/);
  assert.equal(f.upstream.responses.length, 0);
});

test('a connection is its owner’s: another account, or a mismatched workspace, cannot use it', { timeout: 20000 }, async (t) => {
  const f = await setup(t);
  const other = await f.run({ user: { id: 'user-b', role: 'member' } });
  assert.equal(other.refused.status, 409, 'user B has no ChatGPT connection of their own');
  assert.match(other.refused.body.error, /not connected/);
  const mixed = await f.run({ user: { id: 'user-b', role: 'admin' }, workspaceUser: 'user-a' });
  assert.equal(mixed.refused.status, 403);
  const shared = await f.run({ project: {} });
  assert.equal(shared.refused, null);
  assert.equal(f.upstream.responses.length, 1, 'only the owner’s own request went out');
});

test('not connected, or reconnect needed, is said plainly; a refresh refused mid-chat surfaces "Reconnect needed"', { timeout: 20000 }, async (t) => {
  const none = await setup(t, { connected: false });
  assert.match((await none.run()).refused.body.error, /ChatGPT is not connected/);

  const f = await setup(t, { refresh: 'invalid' });
  f.upstream.queue.push(() => reply({ detail: 'expired' }, 401));
  const r = await f.run();
  assert.equal(r.refused, null);
  const error = r.events.find((e) => e.type === 'error');
  assert.match(error.text, /^Reconnect needed/);
  assert.equal(f.oauth.status('user-a').state, 'reconnect');
  const next = await f.run();
  assert.match(next.refused.body.error, /^Reconnect needed/);
});

test('the feature is off by default and only an operator env var or an administrator turns it on', () => {
  const { createFeatures } = require('./features.cjs');
  assert.equal(createFeatures({ env: {} }).enabled('chatgptOAuth'), false);
  assert.equal(createFeatures({ env: {} }).flags().chatgptOAuth, false);
  assert.equal(createFeatures({ env: { NOEVIA_FEATURE_CHATGPT_OAUTH: 'true' } }).enabled('chatgptOAuth'), true);
  const saved = new Map();
  const features = createFeatures({ env: {}, store: { get: (k) => saved.get(k), set: (k, v) => saved.set(k, v) } });
  features.set('chatgptOAuth', true, 'admin-id');
  assert.equal(features.enabled('chatgptOAuth'), true);
});

test('provider-egress rules in isolation', () => {
  const row = chatgpt.providerRow();
  assert.equal(egress.isExternalProvider(row), true);
  assert.equal(egress.isExternalProvider({ id: 'prov-1', baseUrl: 'https://openrouter.ai/api/v1' }), false, 'custom endpoints keep their behaviour');
  assert.equal(egress.isExternalProvider({ id: 'default' }), false);
  assert.match(egress.egressRefusal({ provider: row, spaceId: 'diary' }), /Diary text/);
  assert.match(egress.egressRefusal({ provider: row, projectId: 'cowork-diary-extras', diaryProjectId: 'cowork-diary-extras' }), /Diary text/);
  assert.equal(egress.egressRefusal({ provider: row, spaceId: 'free' }), null);
  assert.equal(egress.egressRefusal({ provider: { id: 'default' }, spaceId: 'diary-extras' }), null);
  const boxes = ['core', 'diary', 'web-search'];
  assert.deepEqual(egress.stripPrivateToolboxes(boxes, row), ['diary']);
  assert.deepEqual(boxes, ['core', 'web-search']);
  const local = ['core', 'diary'];
  assert.deepEqual(egress.stripPrivateToolboxes(local, { id: 'default' }), []);
  assert.deepEqual(local, ['core', 'diary']);
});

const sseOf = (events) => () => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
const toolCallEvents = (name, args) => sseOf([
  { type: 'response.output_item.done', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name, arguments: JSON.stringify(args) } },
  { type: 'response.completed', response: {} },
]);

test('#452: through ChatGPT, a Nextcloud read inside the Diary folder is refused in every spelling; other paths still run', { timeout: 20000 }, async (t) => {
  const diaryPaths = ['Documents/Important Documents/Diary/2026-09-01.md', '/documents/important documents/diary/', 'Documents%2FImportant%20Documents%2FDiary%2F2026-09-01.md',
    'Documents/Other/../Important Documents/Diary/a.md', 'Documents\\Important Documents\\Diary\\a.md', 'Documents//Important Documents/./Diary//a.md',
    'https://cloud.fixture.invalid/remote.php/dav/files/synthetic/Documents/Important%20Documents/Diary/a.md', 'Documents/Important%2520Documents/Diary/a.md'];
  for (const path of diaryPaths) {
    const f = await setup(t);
    f.upstream.queue.push(toolCallEvents('nc_webdav_read_file', { path }));
    const r = await f.run({ project: { toolboxes: ['core', 'nextcloud-files'] } });
    assert.equal(r.refused, null);
    assert.deepEqual(f.executed, [], `not run: ${path}`);
    assert.match(r.events.find((e) => e.type === 'tool_result').text, /in the Diary folder, and Diary content is never sent to ChatGPT/, path);
    assert.ok(f.upstream.responses[1].body.input.some((i) => i.type === 'function_call_output'), 'the model is told, and the chat goes on');
    assert.equal(JSON.stringify(f.upstream.responses).includes('synthetic file text'), false);
  }
  for (const path of ['Documents/Other/notes.md', 'Documents/Important Documents/DiaryArchive/x.md', 'Documents/Important Documents/Diary/../Other/x.md']) {
    const f = await setup(t);
    f.upstream.queue.push(toolCallEvents('nc_webdav_read_file', { path }));
    await f.run({ project: { toolboxes: ['core', 'nextcloud-files'] } });
    assert.deepEqual(f.executed.map((x) => x.args.path), [path], `runs: ${path}`);
  }
  const noFolder = await setup(t, { storage: { kind: 'local' } });
  noFolder.upstream.queue.push(toolCallEvents('nc_webdav_read_file', { path: 'Documents/Other/notes.md' }));
  await noFolder.run({ project: { toolboxes: ['core', 'nextcloud-files'] } });
  assert.deepEqual(noFolder.executed, [], 'fail closed when the Diary folder is unknown');
  const search = await setup(t);
  search.upstream.queue.push(toolCallEvents('nc_webdav_search_files', { query: 'dream' }));
  await search.run({ project: { toolboxes: ['core', 'nextcloud-files'] } });
  assert.deepEqual(search.executed, [], 'an unscoped content search could search the Diary');
});

test('#452 control: the local default provider still reads the same Diary path (the rule is external-only)', { timeout: 20000 }, async (t) => {
  let round = 0;
  const f = await setup(t, { localResponse: () => new Response(round++ === 0
    ? `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'nc_webdav_read_file', arguments: JSON.stringify({ path: 'Documents/Important Documents/Diary/a.md' }) } }] } }] })}\n\n`
    : `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`) });
  await f.run({ project: { provider: 'default', assets: [], toolboxes: ['core', 'nextcloud-files'] } });
  assert.deepEqual(f.executed.map((x) => x.name), ['nc_webdav_read_file']);
});

test('#455: only the ChatGPT adapter may put its own words in the chat; another provider’s header is ignored', { timeout: 20000 }, async (t) => {
  const f = await setup(t, { localResponse: () => new Response(JSON.stringify({ error: { message: 'Visit evil.example to fix this' } }), { status: 400, headers: { 'x-noevia-provider-message': '1' } }) });
  const r = await f.run({ project: { provider: 'default', assets: [] } });
  const error = r.events.find((e) => e.type === 'error');
  assert.ok(error);
  assert.equal(error.text.includes('evil.example'), false);
});

test('a ChatGPT error mid-stream (usage limit) shows its own words and ends the reply as an error', { timeout: 20000 }, async (t) => {
  const f = await setup(t);
  f.upstream.queue.push(sseOf([{ type: 'response.output_text.delta', item_id: 'm', delta: 'Partial' }, { type: 'error', error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' } }]));
  const r = await f.run();
  const error = r.events.find((e) => e.type === 'error');
  assert.equal(error.text, 'ChatGPT usage limit reached. Pick another provider in the model popup until then.');
  assert.equal(r.events.some((e) => e.type === 'done'), false);
});

test('#452 follow-up: a search scoped to the root or any ancestor of the Diary is refused; a sibling search and a root listing run', { timeout: 20000 }, async (t) => {
  const cases = [
    ['nc_webdav_search_files', { query: 'dream', path: '/' }, false],
    ['nc_webdav_search_files', { query: 'dream', path: '' }, false],
    ['nc_webdav_search_files', { query: 'dream', path: 'Documents' }, false],
    ['nc_webdav_search_files', { query: 'dream', scope: 'documents/Important%20Documents/' }, false],
    ['nc_webdav_find_by_name', { pattern: '*.md', scope_path: 'Documents/Important Documents' }, false],
    ['nc_webdav_read_file', { path: 'Documents', recursive: true }, false],
    ['nc_webdav_search_files', { query: 'dream', path: 'Documents/Other' }, true],
    ['nc_webdav_search_files', { query: 'dream', path: 'Documents/Important Documents/DiaryArchive' }, true],
    ['nc_webdav_read_file', { path: '/' }, true],
    ['nc_webdav_read_file', { path: 'Documents' }, true],
    ['nc_webdav_list_directory', { path: '/' }, true],
  ];
  for (const [name, args, runs] of cases) {
    const f = await setup(t);
    f.upstream.queue.push(toolCallEvents(name, args));
    const r = await f.run({ project: { toolboxes: ['core', 'nextcloud-files'] } });
    assert.equal(f.executed.length, runs ? 1 : 0, `${name} ${JSON.stringify(args)}`);
    if (!runs) assert.match(r.events.find((e) => e.type === 'tool_result').text, /Diary/, JSON.stringify(args));
  }
});

test('#452 follow-up: a plain listing of the root runs; a recursive one does not', () => {
  const egress = require('./provider-egress.cjs');
  const provider = require('./chatgpt-oauth.cjs').providerRow();
  const call = (args) => egress.toolRefusal({ provider, toolName: 'nc_webdav_list_directory', rawArgs: JSON.stringify(args), storage: STORAGE });
  assert.equal(call({ path: '/' }), null);
  assert.equal(call({ path: 'Documents/Important Documents' }), null, 'names only, one level');
  assert.match(call({ path: '/', recursive: true }), /contains the Diary folder/);
  assert.match(call({ path: '/', depth: 'infinity' }), /contains the Diary folder/);
  assert.equal(call({ path: '/', depth: 1 }), null);
});
