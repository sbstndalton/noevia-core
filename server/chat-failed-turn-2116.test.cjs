'use strict';
// #2116: a reply that failed is saved with the transcript as an assistant turn that carries its failure sentence (and
// any text that had streamed in before it). It is a record for the person, never something the model said: the chat
// handler does not replay it, also when it comes back through a conversations export and import. Synthetic fixtures
// only; no model is loaded.

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { planImport } = require('./chat-import.cjs');
const { FORMAT } = require('./chat-export.cjs');
const { isFailedTurn } = require('./chat-sources.cjs');

const PARTIAL = 'PARTIAL-TEXT-OF-A-FAILED-REPLY';
const FAILURE = 'The model took too long to unload, so the reply was ended. Try again.';

test('isFailedTurn: only an assistant entry with a non-empty failure sentence', () => {
  assert.equal(isFailedTurn({ role: 'assistant', content: '', failure: FAILURE }), true);
  for (const e of [null, undefined, 'x', { role: 'user', content: 'q', failure: FAILURE }, { role: 'assistant', content: 'a' },
    { role: 'assistant', content: 'a', failure: '' }, { role: 'assistant', content: 'a', failure: '  ' }, { role: 'assistant', content: 'a', failure: 5 }]) {
    assert.equal(isFailedTurn(e), false, JSON.stringify(e));
  }
});

async function modelRequestFor(t, history, message) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-failed-turn-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message, history });
  assert.equal(requests.length, 1, 'one model request');
  assert.ok(events.some((e) => e.type === 'done'), 'the new reply completes');
  return requests[0].body.messages;
}

const asSeen = (messages) => JSON.stringify(messages);

test('the model request carries neither the text of a failed reply nor its failure sentence', async (t) => {
  const messages = await modelRequestFor(t, [
    { role: 'user', content: 'Summarise the synthetic notes.' },
    { role: 'assistant', content: PARTIAL, failure: FAILURE },
    { role: 'user', content: 'Then just list the headings.' },
    { role: 'assistant', content: 'Two headings.' },
  ], 'And the third?');
  assert.ok(!asSeen(messages).includes(PARTIAL), 'partial text of a failed reply reached the model');
  assert.ok(!asSeen(messages).includes('took too long'), 'the failure sentence reached the model');
  assert.deepEqual(messages.filter((m) => m.role === 'user').map((m) => m.content), ['Summarise the synthetic notes.', 'Then just list the headings.', 'And the third?']);
  assert.ok(messages.some((m) => m.content === 'Two headings.'), 'real answers are still replayed');
});

test('a failed turn that went through a conversations export and import stays out of the model request', async (t) => {
  // What the export writes for a chat with a failed reply (it keeps every field but reasoning) is what import reads.
  const exported = { format: FORMAT, chats: [{ id: 'c-round', title: 'Round trip', updatedAt: 1, history: [
    { role: 'user', content: 'Summarise the synthetic notes.' }, { role: 'assistant', content: PARTIAL, failure: FAILURE }] }] };
  const plan = planImport(JSON.parse(JSON.stringify(exported)), { existingChatIds: new Set(), tombstones: new Set(), projects: [], newId: () => 'c-new' });
  const imported = plan.histories['c-round'];
  assert.equal(isFailedTurn(imported[1]), true, 'the failed turn is still a failed turn after import');
  const messages = await modelRequestFor(t, imported, 'Try again, shorter.');
  assert.ok(!asSeen(messages).includes(PARTIAL));
  assert.ok(!asSeen(messages).includes('took too long'));
});
