'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { createChatHandler } = require('./chat.cjs');
const contextDir=fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'chat-handler-test-'));
test.after(()=>fs.rmSync(contextDir,{recursive:true,force:true}));

async function run({ visionModel, probeStatus = 200, descriptionStatus = 200, missingAsset = false, finishReason = 'stop', cache = new Map(), headers = {}, replacementBytes, userId = 'synthetic-user', projectId = 'fixture-project', native = false,
  assets = [{ id: 'image-a', name: 'statement.png', mime: 'image/png' }, { id: 'image-b', name: 'copy.png', mime: 'image/png' }], files = [], turnImageIds, expectImages = true, message = 'Read the synthetic total', projectProviderId, history, describeHang = false, stageMs, makeRoomFor } = {}) {
  const events = [], requests = [], urls = [], nativeCalls=[];let nativeLoaded=null;
  const res = new EventEmitter();
  res.writeHead = () => {};
  res.write = line => events.push(JSON.parse(line.slice(6)));
  res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const bytes = replacementBytes || fs.readFileSync(path.join(__dirname, 'fixtures/documents/statement.png'));
  const fetch = async (url, opts) => {
    assert.ok(['http://fixture.invalid/v1/chat/completions', 'http://second.invalid/v1/chat/completions'].includes(url), url);
    const body = JSON.parse(opts.body); requests.push(body); urls.push({ url, model: body.model, headers: opts.headers });nativeLoaded=body.model;
    if (!missingAsset && expectImages) assert.ok(events.some(e => e.type === 'status' && /Reading image/.test(e.text)), 'image preparation must be visible before waiting for inference');
    if (body.stream) return { ok: true, body: (async function* () {
      yield Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Synthetic answer' } }] }) + '\n\n');
    })() };
    if (body.max_tokens === 1) return new Response(probeStatus === 200 ? '{}' : 'provide the mmproj', { status: probeStatus });
    assert.equal(body.model, visionModel);
    if (describeHang) return new Promise((_, reject) => { opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }); });
    return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content: 'Fixture image: invoice INV-2042 total 34.95' } }] }), { status: descriptionStatus });
  };
  const context = {
    modelManager:{enabled:true,health:async()=>({ok:true,body:{all_models_loaded:[{model_name:'answer-model',loaded:true,recipe_options:{ctx_size:32768}}]}})},
    reasoningEffort: require('./reasoning-effort.cjs'),
    authService: {},
    crypto: require('node:crypto'), path, fetch,
    fs: { readFileSync: () => { if (missingAsset) throw new Error('missing fixture'); return bytes; } },
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId, dir:contextDir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: projectId, model: 'answer-model', assets, files, ...(projectProviderId ? { provider: projectProviderId } : {}) }),
    skillsIndexFor: () => [], getProvider: (id) => (id && id !== 'default' ? { id, shared: true, label: 'Second engine', baseUrl: 'http://second.invalid' } : { id: 'default', baseUrl: 'http://fixture.invalid' }),
    providerHeaders: (p) => (p && p.id !== 'default' ? { Authorization: 'Bearer second-key' } : headers), autoRoles: () => visionModel ? { vision: visionModel } : null,
    visionDescriptions: cache, visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false }, chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [],
    CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [], toolPolicy: { mode: (_user, _name, write) => (write ? 'ask' : 'allow') }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => true,
  };
  if (makeRoomFor) context.modelManager = { ...context.modelManager, makeRoomFor };
  if(native)context.modelManager=require('./model-manager.cjs').createModelManager({kind:'llamacpp',baseUrl:'http://fixture.invalid',fetchJson:async(url,options)=>{
    nativeCalls.push(url);
    if(url.endsWith('/models/load'))nativeLoaded=JSON.parse(options.body).model;
    if(url.endsWith('/models/unload'))nativeLoaded=null;
    if(url.includes('/props?'))assert.equal(new URL(url).searchParams.get('autoload'),'false');
    return {ok:true,status:200,body:url.includes('/props?')?{default_generation_settings:{n_ctx:32768},total_slots:1}:{data:['answer-model','vision-model'].map(id=>({id,status:{value:id===nativeLoaded?'loaded':'unloaded'}}))}};
  }});
  const { handleChat } = createChatHandler({
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (text) => ({ text }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], executeToolCall: async () => '', chatWideApproved: () => false, awaitApproval: async () => 'decline', recordUsage() {}, recordToolUse() {},
    ...(stageMs === undefined ? {} : { visionStageTimeoutMs: stageMs }),
    ...context,
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message, ...(history ? { history } : {}), ...(turnImageIds === undefined ? {} : { turnImageIds }) });
  assert.ok(events.some(e => e.type === 'done'));
  return { events, requests, urls, nativeCalls, answer: requests.find(r => r.stream) };
}

test('image rejection explains mmproj, omits bytes and tells answering model not to guess', async () => {
  const out = await run({ probeStatus: 500 });
  assert.match(out.events.find(e => e.type === 'warning').text, /Images were not read.*mmproj/);
  assert.match(out.answer.messages[0].content, /do not guess/);
  assert.equal(JSON.stringify(out.answer).includes('data:image'), false);
});

test('direct vision passes both image sources to the last user message', async () => {
  const out = await run();
  assert.equal(out.answer.messages.at(-1).content.filter(c => c.type === 'image_url').length, 2);
  assert.equal(out.events.some(e => e.type === 'warning'), false);
});

test('configured vision role supplies description text to the answering model', async () => {
  const out = await run({ visionModel: 'vision-model' });
  assert.equal(out.requests[0].messages[0].content.filter(c => c.type === 'image_url').length, 2);
  assert.match(out.answer.messages[0].content, /INV-2042 total 34.95/);
  assert.equal(JSON.stringify(out.answer).includes('data:image'), false);
});

test('failed description falls back to direct vision or an explicit unavailable warning', async () => {
  for (const probeStatus of [200, 500]) {
    const out = await run({ visionModel: 'vision-model', descriptionStatus: 500, probeStatus });
    assert.equal(JSON.stringify(out.answer).includes('data:image'), probeStatus === 200);
    // #1790: the failed description is said on the reply either way; without image input it also says the images were not read.
    const warning = out.events.find(e => e.type === 'warning');
    assert.match(warning.text, /vision model \(vision-model\) could not describe it/);
    assert.equal(/Images were not read/.test(warning.text), probeStatus !== 200);
  }
});

test('missing asset bytes produce a user-facing warning and a no-guess instruction', async () => {
  const out = await run({ missingAsset: true });
  assert.match(out.events.find(e => e.type === 'warning').text, /missing.*statement.png/);
  assert.match(out.answer.messages[0].content, /Do not guess/);
  assert.equal(JSON.stringify(out.answer).includes('data:image'), false);
});

test('truncated descriptions fall back to direct vision instead of presenting partial transcription as complete', async () => {
  const out = await run({ visionModel: 'vision-model', finishReason: 'length' });
  assert.equal(JSON.stringify(out.answer).includes('data:image'), true);
});


test('description cache reuses exact inputs but isolates credential, content, user and project changes', async () => {
  const cache = new Map(); const opts = { cache, visionModel: 'vision-model' };
  const descriptions = out => out.requests.filter(r => !r.stream && r.max_tokens !== 1).length;
  assert.equal(descriptions(await run(opts)), 1);
  assert.equal(descriptions(await run(opts)), 0);
  for (const change of [{ headers: { Authorization: 'synthetic-new-credential' } }, { replacementBytes: Buffer.from('different synthetic bytes') }, { userId: 'other' }, { projectId: 'other' }]) {
    assert.equal(descriptions(await run({ ...opts, ...change })), 1);
  }
});

test('native one-model router can switch from vision description to answer context',async()=>{
 const out=await run({native:true,visionModel:'vision-model'});
 assert.match(out.answer.messages[0].content,/INV-2042 total 34.95/);assert.equal(out.answer.model,'answer-model');assert.ok(out.nativeCalls.some(url=>url.endsWith('/models/load')));assert.equal(out.events.find(e=>e.type==='context').limit,32768);
});

// #1512: text, CSV, JSON and DOCX attachments waited at "Reading image sources" because the PROJECT
// held image sources, and every project image was described on every turn (cache keyed on the
// question, so a new message is always a miss, and a vision model swap). A turn now names the image
// sources it attaches (turnImageIds, like turnToolboxes); the others are named, never described.
// Without the field nothing changes. Synthetic fixtures only.
const CSV_FILE = [{ name: 'qa_sales.csv', content: 'item,qty\nsynthetic widget,3', attachment: { id: 'a'.repeat(64), state: 'ready', group: 'Text', bytes: 28 } }];
const systemText = (out) => out.answer.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
const noVisionWork = (out) => out.requests.filter((r) => !r.stream).length === 0;
const readingImages = (out) => out.events.some((e) => e.type === 'status' && /Reading image/.test(e.text));

test('#1512: a text or CSV attachment in a project with no image sources never enters the image step', async () => {
  const out = await run({ assets: [], files: CSV_FILE, expectImages: false, message: 'Which item has the highest qty?' });
  assert.ok(noVisionWork(out), 'no vision description and no image probe');
  assert.equal(readingImages(out), false);
  assert.ok(out.events.some((e) => e.type === 'status' && e.id === 'preparing'));
});

test('#1512: a text-only follow-up does not describe or send the project images when the turn names none', async () => {
  const out = await run({ visionModel: 'vision-model', turnImageIds: [], expectImages: false, message: 'Summarise the synthetic report in one line.' });
  assert.ok(noVisionWork(out), 'no description call and no probe for the project images');
  assert.equal(readingImages(out), false);
  assert.equal(JSON.stringify(out.answer).includes('data:image'), false);
  assert.match(systemText(out), /image sources \("statement\.png", "copy\.png"\) that are not attached to this message/);
});

test('#1512: a turn that names one image describes only that image and names the other', async () => {
  const out = await run({ visionModel: 'vision-model', turnImageIds: ['image-a'], message: 'Read the synthetic total' });
  const described = out.requests.filter((r) => !r.stream && r.max_tokens !== 1);
  assert.equal(described.length, 1);
  assert.equal(described[0].messages[0].content.filter((c) => c.type === 'image_url').length, 1);
  assert.match(out.answer.messages[0].content, /INV-2042 total 34\.95/);
  assert.match(systemText(out), /image sources \("copy\.png"\) that are not attached/);
});

test('#1512: turnImageIds is a short list of image source ids; anything else is a 400', () => {
  const { requestShapeError } = require('./chat-mode.cjs');
  assert.equal(requestShapeError({ message: 'x' }), null, 'absent is unchanged');
  assert.equal(requestShapeError({ turnImageIds: [] }), null);
  assert.equal(requestShapeError({ turnImageIds: ['image-a'] }), null);
  const tooMany = Array.from({ length: 13 }, (_, i) => `image-${i}`);
  for (const bad of ['image-a', [1], [''], tooMany, ['x'.repeat(81)]]) {
    assert.equal(requestShapeError({ turnImageIds: bad })?.status, 400, JSON.stringify(bad).slice(0, 60));
  }
});

test('#1512: a CSV attached to a turn in a project that holds images does not enter the image step when the turn names none', async () => {
  const out = await run({ visionModel: 'vision-model', files: CSV_FILE, turnImageIds: [], expectImages: false, message: 'Which item in the CSV has the highest qty?' });
  assert.ok(noVisionWork(out), 'the project images are not described for a CSV question');
  assert.equal(readingImages(out), false);
  assert.equal(JSON.stringify(out.answer).includes('data:image'), false);
});

// #1741: the Vision role model lives on the local default provider. A turn answered by another provider must
// not send the images to that provider's address under the local Vision model's name; with no description,
// the answering model gets the images itself if it can see them.
test('a non-default answering provider gets no image description call (#1741)', async () => {
  const out = await run({ visionModel: 'vision-model', projectProviderId: 'second' });
  const describe = out.urls.filter((u) => u.model === 'vision-model');
  assert.deepEqual(describe, [], 'no description request may be made on an off-box turn');
  assert.equal(out.urls.some((u) => u.url.startsWith('http://fixture.invalid')), false, 'the default provider is not called either');
  assert.ok(out.urls.every((u) => u.headers.Authorization === 'Bearer second-key'));
  assert.equal(out.answer.messages.at(-1).content.filter((c) => c.type === 'image_url').length, 2, 'the answering model sees the images natively');
});

test('the description runs on the default provider with its own headers on an on-box turn (#1741)', async () => {
  const out = await run({ visionModel: 'vision-model', headers: { 'X-Local': 'default-only' } });
  const describe = out.urls.filter((u) => u.model === 'vision-model');
  assert.equal(describe.length, 1);
  assert.equal(describe[0].url, 'http://fixture.invalid/v1/chat/completions');
  assert.equal(describe[0].headers['X-Local'], 'default-only');
});

// #1742(b): image-derived text (the Vision description, a retrieved image's caption) is put only into the
// outgoing request's system message; it is never streamed to the client, and the server keeps only a
// compaction summary of user and assistant text, never system notes (chat-context.cjs; the replay is built
// from the client's stored transcript). So an on-box turn's description cannot come back in a later
// off-box replay. What the assistant itself wrote is transcript text, though (next test, #1753).
test('no image-derived text reaches an off-box replay of an on-box image turn (#1742)', async () => {
  const DERIVED = 'INV-2042';
  const first = await run({ visionModel: 'vision-model' });
  assert.ok(JSON.stringify(first.answer).includes(DERIVED), 'the on-box answer got the description');
  assert.equal(JSON.stringify(first.events).includes(DERIVED), false, 'no event carries the description to the client');
  // What the client stores for that turn: its own message and the streamed reply text.
  const reply = first.events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  const history = [{ role: 'user', content: 'Read the synthetic total' }, { role: 'assistant', content: reply }];
  const second = await run({ visionModel: 'vision-model', projectProviderId: 'second', history, message: 'And the date?', turnImageIds: [], expectImages: false });
  assert.equal(second.urls.some((u) => u.model === 'vision-model'), false);
  assert.equal(JSON.stringify(second.answer).includes(DERIVED), false, 'the off-box replay carries no image-derived text');
  assert.equal(JSON.stringify(second.answer).includes('Fixture image'), false);
});

// #1753: an assistant reply that restates image content is user-visible transcript text, not a system note,
// so it is replayed like any other assistant text under the #1703 rules for client-sent history.
test('an assistant reply that restates image content is replayed as transcript text (#1753)', async () => {
  const history = [{ role: 'user', content: 'Read the synthetic total' }, { role: 'assistant', content: 'The synthetic total is INV-2042.' }];
  const second = await run({ visionModel: 'vision-model', projectProviderId: 'second', history, message: 'And the date?', turnImageIds: [], expectImages: false });
  assert.equal(second.urls.some((u) => u.model === 'vision-model'), false);
  assert.ok(JSON.stringify(second.answer).includes('The synthetic total is INV-2042.'), 'the assistant text is replayed');
  assert.equal(JSON.stringify(second.answer).includes('Fixture image'), false, 'no system-note image text rides along');
});

// #1790: an attached PNG sat at "Reading image sources" for minutes. Live logs: the Vision role model (a Qwen3.5
// with thinking on) generated hidden reasoning at ~18 tokens/s against max_tokens 4096 until the 180 s abort, then
// the chat swapped back. The describe call now turns thinking off with a smaller budget, the whole step (swap and
// reply) has one hard deadline, and a miss is told to the user before the answering model takes the image.
test('#1790: the describe call asks for no thinking and a bounded description', async () => {
  const out = await run({ visionModel: 'vision-model' });
  const describe = out.requests.find((r) => !r.stream && r.max_tokens !== 1);
  assert.deepEqual(describe.chat_template_kwargs, { enable_thinking: false });
  assert.ok(describe.max_tokens <= 1536, `max_tokens ${describe.max_tokens}`);
});

test('#1790: a describe that never answers ends at the stage deadline, says so, and the answer still comes', async () => {
  const started = Date.now();
  const out = await run({ visionModel: 'vision-model', describeHang: true, stageMs: 50 });
  assert.ok(Date.now() - started < 5000, 'bounded by the stage deadline');
  assert.ok(out.answer, 'the answering model was still asked');
  assert.equal(out.answer.messages.at(-1).content.filter((c) => c.type === 'image_url').length, 2, 'images handed to the answering model');
  assert.match(out.events.find((e) => e.type === 'warning').text, /vision model \(vision-model\) did not finish within/);
  assert.ok(out.events.some((e) => e.type === 'status' && e.id === 'readingImages' && /did not finish/.test(e.text)), 'the wait moves on visibly');
});

test('#1790: a model swap that never completes is bounded by the same deadline', async () => {
  const makeRoomFor = (model, _keep, signal) => model !== 'vision-model' ? Promise.resolve()
    : new Promise((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  const out = await run({ visionModel: 'vision-model', stageMs: 50, makeRoomFor });
  assert.ok(out.answer);
  assert.match(out.events.find((e) => e.type === 'warning').text, /did not finish within/);
});
