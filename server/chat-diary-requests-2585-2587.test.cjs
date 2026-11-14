'use strict';
// Two hand-made or legacy request shapes the chat handler mishandled. Synthetic QA data only.
// #2585: with the Diary add-on off, a project whose stored toolboxes name `diary` twice still offered the Diary tools
//        (only the first `diary` was taken out).
// #2587: a `diary` space request that also names a projectId threw (the grant holder read the id of a project the
//        Diary space never loads) instead of running as a Diary turn.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');

const USER = { id: 'qa-user', role: 'member' };

async function turn(t, { project, diaryEnabled, body }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-diary-requests-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter();
  res.writeHead = () => {}; res.setHeader = () => {};
  res.write = (line) => { if (String(line).startsWith('data: ')) events.push(JSON.parse(String(line).slice(6))); return true; };
  res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(String(url));
    return { ok: true, status: 200, headers: new Map(), body: (async function* () { yield Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'QA ok' } }] }) + '\n\ndata: [DONE]\n\n'); })() };
  };
  // diary-stream.cjs asks the companion with the global fetch: a stub answering its plain JSON reply, so nothing
  // leaves the test.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(JSON.stringify({ reply: 'QA diary ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const selections = [];
  const answered = [];
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'qa-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {}, diaryEnabled: () => diaryEnabled }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange: () => async () => 'unused',
    currentWorkspace: () => ({ userId: USER.id, dir, assetDir: () => path.join(dir, 'qa-assets') }),
    getProject: (id) => (project && id === project.id ? structuredClone(project) : null),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://qa-engine.invalid' }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: async () => ({ supported: false, reason: 'qa' }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'ask' }, requestScope: { getStore: () => ({ authn: { user: USER }, workspace: { userId: USER.id } }) },
    // The selection each resolution is asked for (the turn's boxes, after the Diary and sign-in filters).
    resolveTools: (selection) => { selections.push([...(selection.toolboxes || [])]); return { tools: [], dropped: [] }; }, isWriteTool: () => true,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://qa-diary.invalid', TOOL_RESULT_CAP: 8000, json: (r, status, payload) => { answered.push({ status, payload }); r.end(); }, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => 'qa-model', classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], grantContext: async (raw) => require('../tests/server/chat-grant-fixture.cjs').context(raw, { holder: { kind: 'absent' } }), chatWideApproved: () => false, recordUsage() {}, recordToolUse() {}, executeToolCall: async () => 'unused', awaitApproval: async () => 'deny',
  });
  await handleChat({ headers: {} }, res, body, { user: USER });
  return { events, fetched, selections, answered, ended: res.writableEnded === true };
}

test('#2585: with the Diary add-on off, no `diary` box survives, however often the project names it', async (t) => {
  const project = { id: 'qa-project', name: 'QA Project', model: 'qa-model', toolboxes: ['diary', 'diary', 'core'], files: [], chats: [{ id: 'qa-chat', title: 'QA chat' }] };
  const { selections, fetched } = await turn(t, { project, diaryEnabled: false, body: { projectId: 'qa-project', chatId: 'qa-chat', message: 'QA hello' } });
  assert.ok(selections.length >= 1, 'the turn resolved its tools');
  for (const ids of selections) assert.ok(!ids.includes('diary'), `no diary box in ${JSON.stringify(ids)}`);
  assert.ok(fetched.some((u) => u.startsWith('http://qa-engine.invalid')), 'the turn reached the engine');
});

test('#2585: with the Diary add-on on, the project keeps its `diary` box', async (t) => {
  const project = { id: 'qa-project', name: 'QA Project', model: 'qa-model', toolboxes: ['diary', 'core'], files: [], chats: [{ id: 'qa-chat', title: 'QA chat' }] };
  const { selections } = await turn(t, { project, diaryEnabled: true, body: { projectId: 'qa-project', chatId: 'qa-chat', message: 'QA hello' } });
  assert.ok(selections.some((ids) => ids.includes('diary')));
});

test('#2587: a diary space request naming a projectId runs as a Diary turn instead of throwing', async (t) => {
  const project = { id: 'qa-project', name: 'QA Project', model: 'qa-model', files: [], chats: [] };
  const { fetched, answered, events, ended } = await turn(t, { project, diaryEnabled: true, body: { spaceId: 'diary', projectId: 'qa-project', chatId: 'qa-diary-chat', message: 'QA hello' } });
  assert.ok(fetched.some((u) => u === 'http://qa-diary.invalid/v1/chat/completions'), `the Diary companion was asked (${JSON.stringify({ fetched, answered })})`);
  assert.ok(!fetched.some((u) => u.startsWith('http://qa-engine.invalid')), 'not the chat engine');
  assert.ok(!answered.some((a) => a.status >= 500), JSON.stringify(answered));
  assert.ok(ended, 'the Diary stream ended the response');
  assert.ok(events.some((e) => e.type === 'done'), `the Diary turn completed (${JSON.stringify(events).slice(0, 300)})`);
});
