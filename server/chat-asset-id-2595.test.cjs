'use strict';
// #2595: a project image is read from the project's asset directory by its id. An id that is not a plain file name
// (a path, `..`, `.`, empty, a NUL, a lone surrogate) used to be joined onto that directory, so a hand-edited
// project record could make a turn read a file outside it and send its bytes to the model. Such an image is now a
// missing image, exactly as a file that is gone: never read, logged and named as missing. Synthetic QA data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');

const SECRET = 'QA-OUTSIDE-THE-ASSET-DIRECTORY';
const IMAGE = 'QA-PLAIN-ASSET';
const b64 = (text) => Buffer.from(text).toString('base64');

async function turn(t, assets) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-asset-id-2595-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const assetDir = path.join(dir, 'qa-assets', 'qa-project');
  fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(path.join(assetDir, 'img-0a1b'), IMAGE);
  fs.writeFileSync(path.join(dir, 'qa-secret.png'), SECRET);
  fs.writeFileSync(path.join(dir, 'qa-assets', 'qa-secret.png'), SECRET);
  const events = [], res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => { if (String(line).startsWith('data: ')) events.push(JSON.parse(String(line).slice(6))); return true; };
  res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), body: String(init.body) });
    return { ok: true, body: (async function* () { yield Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'QA seen' } }] }) + '\n\n'); })() };
  };
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => { warned.push(a.map(String).join(' ')); };
  t.after(() => { console.warn = warn; });
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'qa-vision-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange: () => async () => 'unused',
    currentWorkspace: () => ({ userId: 'qa-user', dir, assetDir: () => assetDir }),
    getProject: () => ({ id: 'qa-project', model: 'qa-vision-model', assets, files: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://qa-engine.invalid' }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: async () => ({ supported: true }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://qa-diary.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], grantContext: async (raw) => require('../tests/server/chat-grant-fixture.cjs').context(raw, { holder: { kind: 'absent' } }), chatWideApproved: () => false, recordUsage() {}, recordToolUse() {}, executeToolCall: async () => 'unused', awaitApproval: async () => 'deny',
  });
  await handleChat({}, res, { projectId: 'qa-project', chatId: 'qa-chat', message: 'QA what is in the images?', history: [] });
  return { events, requests, warned };
}

const image = (id, name) => ({ id, name, mime: 'image/png', bytes: 32 });

test('#2595: an asset id that is not a plain file name is a missing image, never a file outside the asset directory', async (t) => {
  const bad = ['../qa-secret.png', '../../qa-secret.png', 'x/../../qa-secret.png', '..\\qa-secret.png', '.', '..', '', 'img-0a1b\u0000', 'img-\ud800', 42, null];
  const { events, requests, warned } = await turn(t, [image('img-0a1b', 'qa-plain.png'), ...bad.map((id, i) => image(id, `qa-bad-${i}.png`))]);
  assert.ok(requests.length >= 1, 'the turn reached the engine');
  const sent = requests.map((r) => r.body).join('\n');
  assert.ok(sent.includes(b64(IMAGE)), 'the plain asset is attached');
  assert.ok(!sent.includes(b64(SECRET)), 'no file outside the asset directory is sent');
  // Each refused id is a missing image, exactly as a file that is gone: logged so, and named to the model as missing.
  assert.equal(warned.filter((l) => l.includes('is listed on project qa-project but its bytes are missing')).length, bad.length, 'each id that is not a file name is refused');
  const texts = JSON.parse(requests[0].body).messages.filter((m) => typeof m.content === 'string').map((m) => m.content);
  const missingNote = texts.find((c) => c.startsWith('Images were not read because their stored files are missing: ')) || '';
  for (let i = 0; i < bad.length; i += 1) assert.ok(missingNote.includes(`qa-bad-${i}.png`), `qa-bad-${i}.png is named as missing`);
  assert.ok(!missingNote.includes('qa-plain.png'), 'the plain image is not named as missing');
  assert.ok(events.some((e) => e.type === 'done'), 'the turn completes');
});

test('#2595: a plain id that names no file is still a missing image', async (t) => {
  const { requests, warned } = await turn(t, [image('img-ffff', 'qa-gone.png')]);
  assert.ok(requests.length >= 1);
  assert.ok(!requests.map((r) => r.body).join('\n').includes('data:image/png;base64,'), 'nothing attached');
  assert.ok(warned.some((l) => l.includes('img-ffff is listed on project qa-project but its bytes are missing')));
});
