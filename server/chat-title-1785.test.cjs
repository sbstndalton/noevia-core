'use strict';
// sbstndalton/noevia#1785: a chat kept its first message as its title for good ("QA-1015-T1 Say hello in one short
// sentence." after 15 turns about trains). After the first reply of a local chat, the model that answered is asked
// for a short title (thinking off), the client gets a `title` event, and the title is saved over the derived one only.
// Off-box turns never send the message or reply anywhere for a title. Fake provider and fake lists; no network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const titles = require('./chat-title.cjs');

const FIRST = 'QA-SYNTH-2 Say hello in one short sentence.';

test('#1785: derivedTitle matches the web client (src/chat-title.ts deriveChatTitle)', () => {
  assert.equal(titles.derivedTitle(FIRST), FIRST);
  const long = 'Please compare these two synthetic train timetables and tell me which connection is faster overall today';
  const derived = titles.derivedTitle(long);
  assert.ok(derived.endsWith('…') && derived.length <= 80 && !/\s…$/.test(derived));
  assert.equal(titles.derivedTitle('x'.repeat(100)), 'x'.repeat(79) + '…', 'one long word is cut hard');
  assert.equal(titles.isDerivedTitle(derived, long), true);
  assert.equal(titles.isDerivedTitle(long.slice(0, 80), long), true, 'the old bare 80-character cut');
  assert.equal(titles.isDerivedTitle(undefined, long), true);
  assert.equal(titles.isDerivedTitle('My train plans', long), false, 'a name the person gave');
});

test('#1785: cleanTitle keeps a short title and drops wrappers, thinking and junk', () => {
  assert.equal(titles.cleanTitle('Friendly Greeting'), 'Friendly Greeting');
  assert.equal(titles.cleanTitle('"Lisbon Packing Checklist."\n'), 'Lisbon Packing Checklist');
  assert.equal(titles.cleanTitle('Title: Train Commute Timing'), 'Train Commute Timing');
  assert.equal(titles.cleanTitle('**Octopus Facts** 🐙'), 'Octopus Facts');
  assert.equal(titles.cleanTitle('<think>the user wants a title</think>\nPhotosynthesis Basics'), 'Photosynthesis Basics');
  assert.equal(titles.cleanTitle(''), null);
  assert.equal(titles.cleanTitle('...'), null);
  assert.equal(titles.cleanTitle('<think>still thinking'), null);
  assert.equal(titles.cleanTitle('one two three four five six seven eight nine ten eleven twelve'), null);
  assert.ok(titles.cleanTitle('A'.repeat(30) + ' ' + 'B'.repeat(40)).length <= 60);
  assert.equal(titles.cleanTitle(null), null);
});

async function turn(t, { history = [], provider = { id: 'default', baseUrl: 'http://default.invalid' }, project = {}, titleReply = 'Friendly Greeting', titleStatus = 200, wired = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1785-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], requests = [], saved = [];
  const res = new EventEmitter(); res.writeHead = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  res.write = (chunk) => { for (const line of String(chunk).split('\n')) if (line.startsWith('data:')) { try { events.push(JSON.parse(line.slice(5))); } catch { /* not json */ } } };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body });
    if (body.stream === false) return new Response(JSON.stringify({ choices: [{ message: { content: titleReply } }] }), { status: titleStatus });
    return { ok: true, status: 200, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello there.' } }] })}\n\n`); })() };
  };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', model: 'answer-model', assets: [], ...project }),
    skillsIndexFor: () => [], getProvider: () => provider, providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) }, resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [{ id: 'core' }], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {}, executeToolCall: async () => 'unused', awaitApproval: async () => 'approve',
    ...(wired ? { chatTitles: { save: (...args) => { saved.push(args); return true; } } } : {}),
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: FIRST, history });
  return { events, requests, saved, titleRequests: requests.filter((r) => r.body.stream === false) };
}

test('#1785: after the first local reply the model is asked for a title, the client gets it and it is saved', async (t) => {
  const { events, titleRequests, saved } = await turn(t);
  assert.equal(titleRequests.length, 1, 'one title request');
  const req = titleRequests[0].body;
  assert.equal(titleRequests[0].url, 'http://default.invalid/v1/chat/completions', 'the local engine');
  assert.equal(req.model, 'answer-model', 'the model that answered, already loaded');
  assert.deepEqual(req.chat_template_kwargs, { enable_thinking: false });
  assert.ok(req.max_tokens <= 64);
  assert.match(req.messages[1].content, /Say hello in one short sentence/);
  assert.match(req.messages[1].content, /Hello there\./);
  const titleEvent = events.find((e) => e.type === 'title');
  assert.deepEqual(titleEvent, { type: 'title', chatId: 'fixture-chat', title: 'Friendly Greeting' });
  assert.deepEqual(saved, [['fixture-project', 'fixture-chat', 'Friendly Greeting', FIRST]]);
  const order = events.map((e) => e.type);
  assert.ok(order.indexOf('title') < order.indexOf('done'), 'the title arrives before done');
});

test('#1785: an off-box turn never sends the conversation anywhere for a title', async (t) => {
  const { events, titleRequests, saved } = await turn(t, { provider: { id: 'hosted-fixture', baseUrl: 'https://hosted.invalid' }, project: { provider: 'hosted-fixture' } });
  assert.equal(titleRequests.length, 0);
  assert.equal(events.some((e) => e.type === 'title'), false);
  assert.deepEqual(saved, []);
  assert.ok(events.some((e) => e.type === 'done'));
});

test('#1785: a later turn does not retitle the chat', async (t) => {
  const { titleRequests, events } = await turn(t, { history: [{ role: 'user', content: FIRST }, { role: 'assistant', content: 'Hello there.' }] });
  assert.equal(titleRequests.length, 0);
  assert.equal(events.some((e) => e.type === 'title'), false);
});

test('#1785: a failed or unusable title answer leaves the title alone and the reply still ends normally', async (t) => {
  for (const opts of [{ titleStatus: 500 }, { titleReply: '' }, { titleReply: '<think>hmm' }]) {
    const { events, saved } = await turn(t, opts);
    assert.equal(events.some((e) => e.type === 'title'), false, JSON.stringify(opts));
    assert.deepEqual(saved, []);
    assert.ok(events.some((e) => e.type === 'done'));
  }
});

test('#1785: without the title store wired, no title is generated', async (t) => {
  const { titleRequests } = await turn(t, { wired: false });
  assert.equal(titleRequests.length, 0);
});

test('#1785: setChatTitle replaces only a derived title, in the signed-in workspace only', () => {
  const { createProjectStore } = require('./projects.cjs');
  const make = (userId) => ({ userId, dir: fs.mkdtempSync(path.join(os.tmpdir(), `noevia-1785-${userId}-`)), projects: [], freeChats: [], saves: 0,
    saveProjects() { this.saves++; }, saveFreeChats() { this.saves++; } });
  const alice = make('alice'), bob = make('bob');
  let active = alice;
  const view = (field) => new Proxy([], {
    get(_t, prop) { const v = active[field][prop]; return typeof v === 'function' ? v.bind(active[field]) : v; },
    set(_t, prop, value) { active[field][prop] = value; return true; },
    ownKeys() { return Reflect.ownKeys(active[field]); },
    getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
  });
  const store = createProjectStore({ fs, path, reasoningEffort: { validEffort: () => true }, projectAppearance: () => ({}), rag: {}, storageClient: { isBrowsable: () => false },
    documentSources: {}, authService: {}, currentWorkspace: () => active, PROJECTS: view('projects'), FREE_CHATS: view('freeChats'),
    sanitizeToolboxes: (b) => b, defaultToolboxes: () => ['core'], PROJECT_ROOT_FOLDER: 'root', createProjectFolder: async () => null, projectSweep: { afterDelete: async () => {} } });
  alice.freeChats.push({ id: 'f1', title: FIRST }, { id: 'f2', title: 'Named by me' });
  alice.projects.push({ id: 'p1', name: 'P', chats: [{ id: 'c1', title: FIRST }] });
  bob.freeChats.push({ id: 'f1', title: FIRST });
  try {
    assert.equal(store.setChatTitle(null, 'f1', 'Friendly Greeting', FIRST), true);
    assert.equal(alice.freeChats[0].title, 'Friendly Greeting');
    assert.equal(store.setChatTitle(null, 'f2', 'Friendly Greeting', FIRST), false, 'a renamed chat keeps its name');
    assert.equal(alice.freeChats[1].title, 'Named by me');
    assert.equal(store.setChatTitle('p1', 'c1', 'Friendly Greeting', FIRST), true);
    assert.equal(alice.projects[0].chats[0].title, 'Friendly Greeting');
    assert.equal(store.setChatTitle(null, 'missing', 'Friendly Greeting', FIRST), false);
    assert.equal(store.setChatTitle(null, 'f1', '   ', FIRST), false);
    assert.equal(bob.freeChats[0].title, FIRST, "another account's chat with the same id is untouched");
  } finally { for (const w of [alice, bob]) fs.rmSync(w.dir, { recursive: true, force: true }); }
});
