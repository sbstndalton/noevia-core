'use strict';
// #1726: what the chat model gets for a retrieved image. A model that can see gets the image; one that
// cannot gets the image's own text, else a caption made once by the Vision role model, else its name
// (said plainly); a cloud route gets nothing derived from it. Flag off: exactly the pre-#1726 path.
// Synthetic bytes, a stubbed retrieval and a fake inference server only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { createChatHandler } = require('./chat.cjs');

const contextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-1726-'));
test.after(() => fs.rmSync(contextDir, { recursive: true, force: true }));

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const APPLE = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic apple picture')]);
const BANANA = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic banana picture')]);
const b64 = (b) => b.toString('base64');

async function run({ flag = true, probeStatus = 200, visionModel = null, appleText = '', external = false, captions = new Map(), message = 'What fruit is in the picture?' } = {}) {
  const events = [], requests = [];
  const res = new EventEmitter();
  res.writeHead = () => {};
  res.write = (line) => events.push(JSON.parse(line.slice(6)));
  res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const fetch = async (url, opts) => {
    assert.equal(url, 'http://fixture.invalid/v1/chat/completions');
    const body = JSON.parse(opts.body); requests.push(body);
    if (body.stream) return { ok: true, body: (async function* () { yield Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Synthetic answer' } }] }) + '\n\n'); })() };
    if (body.max_tokens === 1) return new Response(probeStatus === 200 ? '{}' : 'provide the mmproj', { status: probeStatus });
    assert.equal(body.model, visionModel);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Caption: one red apple on a plate.' } }] }), { status: 200 });
  };
  const project = { id: 'fixture-project', model: 'answer-model',
    assets: [{ id: 'img-apple', name: 'fruit.png', mime: 'image/png', bytes: APPLE.length, sourceName: 'fruit.png' },
      { id: 'img-banana', name: 'yellow.png', mime: 'image/png', bytes: BANANA.length, sourceName: 'yellow.png' }],
    files: [{ name: 'fruit.png', content: appleText, attachment: { id: sha(APPLE), group: 'Images', state: 'vision' } },
      { name: 'yellow.png', content: '', attachment: { id: sha(BANANA), group: 'Images', state: 'vision' } }] };
  const hit = (asset, bytes, score) => ({ file: asset.sourceName, kind: 'image', meta: { source: asset.sourceName, assetId: asset.id, name: asset.name, mime: 'image/png' }, hash: `img:${sha(bytes)}`, score });
  const filesContextCalls = [];
  const captionWrites = [];
  const rag = {
    filesContext: async (projectId, files, query, userId, onSources, opts) => {
      filesContextCalls.push(opts);
      if (opts && opts.images) opts.onImages({ hits: [hit(project.assets[0], APPLE, 0.71)], indexed: [hit(project.assets[0], APPLE, 0), hit(project.assets[1], BANANA, 0)] });
      return null;
    },
    readCaption: (projectId, userId, hash) => captions.get(JSON.stringify([userId, projectId, hash])) || null,
    writeCaption: (projectId, userId, hash, caption, model) => { captionWrites.push(hash); captions.set(JSON.stringify([userId, projectId, hash]), { caption, model }); return true; },
  };
  const bytesFor = (p) => (p.endsWith('img-apple') ? APPLE : p.endsWith('img-banana') ? BANANA : (() => { throw new Error('missing fixture'); })());
  const { handleChat } = createChatHandler({
    rag, prefill: { recordSample() {} }, reduceToolResult: (text) => ({ text }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], executeToolCall: async () => '', chatWideApproved: () => false, awaitApproval: async () => 'decline', recordUsage() {}, recordToolUse() {},
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: {}, crypto, path, fetch,
    fs: { readFileSync: (p) => bytesFor(String(p)) },
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir: contextDir, assetDir: () => '/synthetic-only' }),
    getProject: () => project, skillsIndexFor: () => [],
    getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid', ...(external ? { external: true, label: 'Synthetic Cloud' } : {}) }),
    providerHeaders: () => ({}), autoRoles: () => (visionModel ? { vision: visionModel } : null),
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false }, chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [],
    CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [], toolPolicy: { mode: (_user, _name, write) => (write ? 'ask' : 'allow') }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => true,
    multimodalEnabled: () => flag,
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message });
  assert.ok(events.some((e) => e.type === 'done'), JSON.stringify(events.filter((e) => e.type === 'error')));
  const answer = requests.find((r) => r.stream);
  return { events, requests, answer, filesContextCalls, captionWrites,
    system: answer.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
    images: (answer.messages.at(-1).content || []).filter?.((c) => c.type === 'image_url') || [],
    captionRequests: requests.filter((r) => !r.stream && r.max_tokens !== 1).length,
    probes: requests.filter((r) => !r.stream && r.max_tokens === 1).length,
    warning: events.filter((e) => e.type === 'warning').map((e) => e.text).join(' ') };
}

test('a model that can see gets the retrieved image, and only that one', async () => {
  const out = await run({ probeStatus: 200 });
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].image_url.url, `data:image/png;base64,${b64(APPLE)}`);
  assert.ok(!JSON.stringify(out.answer).includes(b64(BANANA)), 'an indexed image that was not retrieved is not sent');
  assert.match(out.system, /yellow\.png.*not attached/);
  assert.equal(out.captionRequests, 0);
});

test('a model that cannot see gets the image\'s own extracted text', async () => {
  const out = await run({ probeStatus: 500, appleText: 'Label reads APPLE-42', visionModel: 'vision-model' });
  assert.ok(!JSON.stringify(out.answer).includes('data:image'));
  assert.match(out.system, /image text[\s\S]*APPLE-42/);
  assert.equal(out.captionRequests, 0, 'no caption when the image has text of its own');
});

test('a model that cannot see gets a caption made once by the Vision role model and cached with the source', async () => {
  const captions = new Map();
  const first = await run({ probeStatus: 500, visionModel: 'vision-model', captions });
  assert.equal(first.captionRequests, 1);
  assert.ok(!JSON.stringify(first.answer).includes('data:image'));
  assert.match(first.system, /one red apple on a plate/);
  assert.deepEqual(first.captionWrites, [`img:${sha(APPLE)}`]);
  const second = await run({ probeStatus: 500, visionModel: 'vision-model', captions, message: 'Another question about the fruit picture' });
  assert.equal(second.captionRequests, 0, 'the cached caption is reused, not generated again');
  assert.match(second.system, /one red apple on a plate/);
});

test('without a Vision model, a model that cannot see gets the file name and the user is told', async () => {
  const out = await run({ probeStatus: 500 });
  assert.ok(!JSON.stringify(out.answer).includes('data:image'));
  assert.match(out.system, /"fruit\.png"[\s\S]*only their file names are known/);
  assert.match(out.warning, /no Vision model is configured/);
});

test('a cloud route gets nothing derived from a private image: no bytes, no text read from it, no caption', async () => {
  const captions = new Map([[JSON.stringify(['synthetic-user', 'fixture-project', `img:${sha(APPLE)}`]), { caption: 'CACHED-PRIVATE-CAPTION', model: 'v' }]]);
  const out = await run({ external: true, visionModel: 'vision-model', appleText: 'PRIVATE-OCR-TEXT', captions });
  const sent = JSON.stringify(out.requests);
  assert.ok(!sent.includes('data:image'));
  assert.ok(!sent.includes('PRIVATE-OCR-TEXT'));
  assert.ok(!sent.includes('CACHED-PRIVATE-CAPTION'));
  assert.equal(out.captionRequests, 0); assert.equal(out.probes, 0);
  assert.match(out.system, /never sent to Synthetic Cloud automatically/);
  assert.match(out.warning, /not sent/);
});

test('flag off: no image retrieval is asked for and every project image rides along as before', async () => {
  const out = await run({ flag: false, probeStatus: 200 });
  assert.deepEqual(out.filesContextCalls, [{ attached: false }], 'filesContext is called exactly as before #1726');
  assert.equal(out.images.length, 2, 'both project images ride along, as before');
  assert.ok(!/not attached/.test(out.system));
});
