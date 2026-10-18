'use strict';
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}
// #1448: a prompt whose reply was stopped or failed (no reply kept) is not an open request for the next
// turn. The client sends the empty reply, the server drops it, and the abandoned prompts used to be
// merged into the new message, so the model answered them again. Now the abandoned turn gets a note in
// the model's history and stays its own turn. Synthetic fixtures only; no model is loaded.

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler, normalizeReplayHistory } = require('./chat.cjs');

const NOTE = /^\(No reply was kept for the message above/;

test('two stopped prompts and a new message: each abandoned prompt is its own turn, the new one is not merged into them', () => {
  const result = normalizeReplayHistory(
    [{ role: 'user', content: 'List 3 ocean facts in one line.' }, { role: 'user', content: 'Write a long numbered list of 40 short facts about the sea.' }],
    'What is 2 plus 2? Answer in one word.',
  );
  assert.deepEqual(result.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(result[0].content, 'List 3 ocean facts in one line.');
  assert.equal(result[2].content, 'Write a long numbered list of 40 short facts about the sea.');
  assert.equal(result[4].content, 'What is 2 plus 2? Answer in one word.');
  assert.match(result[1].content, NOTE);
  assert.match(result[3].content, NOTE);
});

test('a stopped prompt followed by the new message is not merged into it', () => {
  const result = normalizeReplayHistory([{ role: 'user', content: 'first' }], 'second');
  assert.deepEqual(result.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(result[2].content, 'second');
});

test('a prompt with a kept reply then a new message is unchanged (no note)', () => {
  const result = normalizeReplayHistory([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], 'again');
  assert.deepEqual(result, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'again' }]);
});

test('compactOnly keeps abandoned prompts separate as well', () => {
  const result = normalizeReplayHistory([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]);
  assert.deepEqual(result.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(result[2].content, 'b');
});

// The chat handler itself: the history the client sends (its stopped reply arrives as an empty assistant
// entry, which the server does not replay) must reach the model as separate turns.
test('the model request carries the abandoned prompts as separate turns, not merged with the new message', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-abandoned-turn-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6))); res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, body: (async function* () { yield Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'four' } }] }) + '\n\n'); })() };
  };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange: () => async () => 'unused',
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', model: 'answer-model', assets: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: async () => ({ supported: false, reason: 'synthetic' }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {}, executeToolCall: async () => 'unused', awaitApproval: async () => 'deny',
  });
  await handleChat({}, res, {
    projectId: 'fixture-project', chatId: 'fixture-chat', message: 'What is 2 plus 2? Answer in one word.',
    history: [
      { role: 'user', content: 'List 3 ocean facts in one line.' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Write a long numbered list of 40 short facts about the sea.' },
      { role: 'assistant', content: '' },
    ],
  });
  assert.equal(requests.length, 1, 'one model request');
  const messages = requests[0].body.messages;
  const users = messages.filter((m) => m.role === 'user').map((m) => m.content);
  assert.deepEqual(users, ['List 3 ocean facts in one line.', 'Write a long numbered list of 40 short facts about the sea.', 'What is 2 plus 2? Answer in one word.']);
  assert.equal(messages.at(-1).role, 'user');
  assert.equal(messages.at(-1).content, 'What is 2 plus 2? Answer in one word.');
  assert.ok(events.some((e) => e.type === 'done'), 'the new reply completes');
});
