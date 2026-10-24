'use strict';
// #1793: a project answer drawn from a small knowledge file showed no source chip. Small files are injected
// whole on every turn, and since #1457 a whole file is a source only when the question names it, so "what is the
// QA secret code?" answered from qa-secret-code.txt reported nothing. The finished answer is now checked: an
// injected file whose distinctive content (a token with a digit, or a four-word run) the answer repeats, and
// the question did not, is reported. Synthetic project, files and provider; no network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { usedInjected } = require('./chat-sources.cjs');

const FILES = [
  { name: 'noevia projects/proj-synthetic/Text/qa-secret-code.txt', content: 'The QA secret code is ORCHID-42', attachment: { id: 'a'.repeat(64), state: 'ready' } },
  { name: 'noevia projects/proj-synthetic/Text/qa-fixture-b.md', content: '# Fixture B\nA synthetic heading about lighthouse maintenance schedules.', attachment: { id: 'b'.repeat(64), state: 'ready' } },
];

function realFilesContext() {
  const src = fs.readFileSync(require.resolve('./rag.cjs'), 'utf8');
  const body = src.slice(src.indexOf('async function filesContext('), src.indexOf('\nmodule.exports'));
  const context = { DIRECT_INJECT_MAX: 2400, FILES_CONTEXT_MAX_CHARS: 120000, LARGE_FILE_HEAD: 24000, documentNotice: () => '',
    frameUntrusted: require('./prompt-framing.cjs').frameUntrusted, ...require('./quoted-name.cjs'), ragAvailable: () => false, searchProject: async () => [] };
  vm.createContext(context); vm.runInContext(body, context);
  return context.filesContext;
}

async function ask(t, message, answer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1793-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6))); res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const fetch = async () => ({ ok: true, body: (async function* () { for (const part of answer) yield Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: part } }] }) + '\n\n'); })() });
  const project = { id: 'proj-synthetic', model: 'answer-model', assets: [], files: FILES };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => project,
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: realFilesContext() },
    prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], grantContext: async raw => require('../tests/server/chat-grant-fixture.cjs').context(raw, { holder: { kind: 'absent' } }), chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => 'unused', awaitApproval: async () => 'approve',
  });
  await handleChat({}, res, { projectId: 'proj-synthetic', chatId: 'c-1793', message });
  assert.ok(events.some((e) => e.type === 'done'));
  return events;
}

test('#1793: an answer quoting an unnamed knowledge file reports that file as its source, before done', async (t) => {
  const events = await ask(t, 'QA-1015-T2 what is the QA secret code?', ['The QA secret code for QA-1015-T2 ', 'is ORCHID-42.']);
  const sources = events.filter((e) => e.type === 'sources');
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0].sources.map((s) => [s.file, s.kind, s.id]), [[FILES[0].name, 'file', 'a'.repeat(64)]]);
  assert.equal(sources[0].sources[0].snippet, 'The QA secret code is ORCHID-42');
  assert.ok(events.findIndex((e) => e.type === 'sources') < events.findIndex((e) => e.type === 'done'));
});

test('#1793 keeps #1457: an answer that uses no project file still shows no sources', async (t) => {
  const events = await ask(t, 'Name three colours of the rainbow', ['Red, orange and yellow.']);
  assert.equal(events.some((e) => e.type === 'sources'), false);
});

test('#1793: attribution needs something distinctive the question did not already say', () => {
  const injected = FILES.map((f) => ({ file: f.name, body: f.content, kind: 'file' }));
  assert.deepEqual(usedInjected(injected, [], 'It is ORCHID-42.', 'what is the code?').map((e) => e.file), [FILES[0].name]);
  // Echoing the question's own token is not evidence.
  assert.deepEqual(usedInjected(injected, [], 'You asked about ORCHID-42.', 'is ORCHID-42 the code?'), []);
  // A four-word run from the file counts; scattered common words do not.
  assert.deepEqual(usedInjected(injected, [], 'It is about lighthouse maintenance schedules, in short.', 'what is fixture b about?').map((e) => e.file), [FILES[1].name]);
  assert.deepEqual(usedInjected(injected, [], 'A heading is a synthetic thing.', 'what is a heading?'), []);
  // Already placed (named or retrieved) entries are not repeated; excerpts are not this check's business.
  assert.deepEqual(usedInjected(injected, [injected[0]], 'It is ORCHID-42.', 'q'), []);
  assert.deepEqual(usedInjected([{ ...injected[0], kind: 'excerpt' }], [], 'It is ORCHID-42.', 'q'), []);
  assert.deepEqual(usedInjected(injected, [], '', 'q'), []);
});
