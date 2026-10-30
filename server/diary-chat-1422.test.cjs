'use strict';
// #1422: a Diary companion exchange that fails before anything is saved says so (and the journal
// records `failed`, not `uncertain`); a failure while saving stays uncertain; the companion's model
// being one the local engine does not serve is named; Diary turns never reach routing or a cloud
// provider. Synthetic fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const jobs = require('./diary-jobs.cjs');
const { rows } = require('../tests/server/diary-records.cjs');

const DAY = '2026-10-12';
const sse = (events) => new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
const STARTED = [{ type: 'status', text: 'Opening diary context…' }, { type: 'status', text: 'Reading diary entries and memory…' }, { type: 'status', text: 'Generating companion response…' }];

function setup(t, { diary, health = { ok: true, model: 'configured-model' }, served = ['router-model'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-chat-1422-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetched = [];
  const touched = [];
  const spy = (name) => (...args) => { touched.push(name); throw new Error(`${name} must not be used for a Diary turn`); };
  // The stream proxy calls the global fetch; the handler's own fetch dependency serves the health probe.
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    fetched.push(String(url));
    if (String(url) === 'http://diary.invalid/v1/chat/completions') return diary(init);
    throw new Error(`unexpected global fetch ${url}`);
  });
  const fetch = async (url) => {
    fetched.push(String(url));
    if (String(url).endsWith('/api/health')) return new Response(JSON.stringify(health), { status: health.ok ? 200 : 503, headers: { 'Content-Type': 'application/json' } });
    throw new Error(`unexpected fetch ${url}`);
  };
  const run = async (body = {}) => {
    const events = [];
    const res = new EventEmitter();
    res.writeHead = () => {}; res.write = (line) => { if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); };
    res.end = () => { res.writableEnded = true; res.emit('finish'); };
    let refused = null;
    const user = { id: 'user-a', role: 'member' };
    const { handleChat } = createChatHandler({
      fetch, reasoningEffort: require('./reasoning-effort.cjs'), createToolExchange, fs, path, crypto: require('node:crypto'),
      authService: { audit() {}, diaryEnabled: () => true }, modelManager: { enabled: true, listModels: async () => ({ ok: true, body: { data: served.map((id) => ({ id })) } }) }, HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default',
      currentWorkspace: () => ({ userId: user.id, dir }), requestScope: { getStore: () => ({ authn: { user } }) },
      getProject: () => null, getProvider: spy('getProvider'), providerHeaders: () => ({}), saveChats() {}, endpointApproved: () => false,
      diaryHeaders: () => ({}), diaryExtras: require('./diary-extras.cjs'), DIARY_BASE: 'http://diary.invalid', TOOL_RESULT_CAP: 8000,
      json: (_res, status, b) => { refused = { status, body: b }; },
      autoRoles: spy('autoRoles'), classifyFastOrSmart: spy('classifyFastOrSmart'), servedCatalogue: async () => [], modelsInstalled: async () => { throw new Error('the filtered list is not used for the diagnosis'); },
      lastLoadedModel: () => null, missingRoles: () => [], staleRolesError: () => null, visionDescriptions: new Map(), visionProbe: spy('visionProbe'),
      skillsIndexFor: () => [], chatSkillRouter: { select: async () => ({ loaded: [] }) }, chatToolRouter: { select: spy('chatToolRouter') },
      oauthServerIds: () => new Set(), accountReady: () => true, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
      toolPolicy: { mode: () => 'allow' }, allToolboxes: () => [], resolveTools: spy('resolveTools'), isWriteTool: () => false,
      rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }),
      grantContext: async raw => require('../tests/server/chat-grant-fixture.cjs').context(raw, { holder: { kind: 'absent' } }), chatWideApproved: () => false, awaitApproval: async () => 'deny', recordUsage() {}, recordToolUse() {},
      routingModes: { enabled: spy('routingModes.enabled'), settings: spy('routingModes.settings'), sensitivity: spy('routingModes.sensitivity'), awaitChoice: spy('routingModes.awaitChoice'), setChatFlags: spy('routingModes.setChatFlags'), log() {} },
    });
    try {
      await handleChat({}, res, { spaceId: 'diary', exchangeId: 'exchange-1422-synthetic-a', entryDay: DAY, entryTime: `${DAY}T10:00:00+00:00`, sessionId: 's1', message: 'Synthetic diary line', history: [], ...body }, { user });
    } finally { if (!res.writableEnded) res.end(); }
    return { events, refused, row: rows({ dir }, DAY).find((r) => r.id === (body.exchangeId || 'exchange-1422-synthetic-a')) };
  };
  return { run, fetched, touched };
}

test('the companion failing while it generates: a clear "nothing was saved" error and a failed (not uncertain) record', async (t) => {
  const f = setup(t, { diary: () => sse([...STARTED, { type: 'error', text: 'Diary processing failed. Saving may be incomplete; check the saved entry before sending again.' }]), health: { ok: true, model: 'router-model' }, served: ['router-model'] });
  const r = await f.run();
  const error = r.events.find((e) => e.type === 'error');
  assert.equal(error.code, 'modelFailed');
  assert.equal(error.saved, false);
  assert.match(error.text, /Couldn't reach the local model — nothing was saved\. You can resend\./);
  assert.doesNotMatch(error.text, /uncertain|may be incomplete/);
  assert.equal(r.row.state, 'failed');
  assert.equal(r.row.code, 'modelFailed');
  assert.match(r.row.error, /nothing was saved/);
});

test('the companion set to a model the local engine does not serve: that cause is named', async (t) => {
  const f = setup(t, { diary: () => sse([...STARTED, { type: 'error', text: 'Diary processing failed.' }]), health: { ok: true, model: 'configured-model', model_source: 'configured' }, served: ['router-model', 'other-model'] });
  const r = await f.run();
  const error = r.events.find((e) => e.type === 'error');
  assert.equal(error.code, 'modelNotServed');
  assert.equal(error.model, 'configured-model');
  assert.equal(error.saved, false);
  assert.equal(r.row.state, 'failed');
});

test('a model-list or health failure while diagnosing falls back to the plain model message', async (t) => {
  const f = setup(t, { diary: () => sse([...STARTED, { type: 'error', text: 'x' }]), health: { ok: false } });
  const r = await f.run();
  assert.equal(r.events.find((e) => e.type === 'error').code, 'modelFailed');
  assert.equal(r.row.state, 'failed');
});

test('a failure before the model is reached is worded as a diary read failure and is failed', async (t) => {
  const f = setup(t, { diary: () => sse([{ type: 'status', text: 'Opening diary context…' }, { type: 'error', text: 'Diary processing failed.' }]) });
  const r = await f.run();
  assert.equal(r.events.find((e) => e.type === 'error').code, 'contextFailed');
  assert.equal(r.row.state, 'failed');
});

test('a failure after saving began stays uncertain: the entry may have been written', async (t) => {
  const f = setup(t, { diary: () => sse([...STARTED, { type: 'answer', text: 'Synthetic answer' }, { type: 'status', text: 'Saving diary entry…' }, { type: 'error', text: 'Diary processing failed. Saving may be incomplete; check the saved entry before sending again.' }]) });
  const r = await f.run();
  const error = r.events.find((e) => e.type === 'error');
  assert.equal(error.saved, undefined);
  assert.match(error.text, /Saving may be incomplete/);
  assert.equal(r.row.state, 'uncertain');
  assert.equal(r.row.content, 'Synthetic answer');
});

test('the companion refusing the stream with an HTTP error before it starts: nothing was saved', async (t) => {
  const f = setup(t, { diary: () => new Response(JSON.stringify({ detail: 'refused', code: 'storageLoginRejected' }), { status: 424, headers: { 'Content-Type': 'application/json' } }) });
  const r = await f.run();
  const error = r.events.find((e) => e.type === 'error');
  assert.equal(error.code, 'storageLoginRejected');
  assert.equal(error.saved, false);
  assert.equal(r.row.state, 'failed');
});

test('Diary turns are local-only: no routing check, role router, provider or sensitivity call is made', async (t) => {
  const f = setup(t, { diary: () => sse([...STARTED, { type: 'error', text: 'x' }]) });
  await f.run();
  assert.deepEqual(f.touched, []);
  assert.ok(f.fetched.every((url) => url.startsWith('http://diary.invalid/')), `only the Diary companion is called: ${f.fetched}`);
});

test('a model the companion reports as unreachable or none-served is a model failure, never "not served"', async (t) => {
  for (const model_source of ['unreachable', 'none_served', 'served', 'role']) {
    const f = setup(t, { diary: () => sse([...STARTED, { type: 'error', text: 'x' }]), health: { ok: true, model: 'x', model_source }, served: ['router-model'] });
    const r = await f.run();
    assert.equal(r.events.find((e) => e.type === 'error').code, 'modelFailed', model_source);
  }
  for (const model_source of [undefined, 'configured', 'unverified']) {
    const f = setup(t, { diary: () => sse([...STARTED, { type: 'error', text: 'x' }]), health: { ok: true, model: 'x', ...(model_source ? { model_source } : {}) }, served: ['router-model'] });
    assert.equal((await f.run()).events.find((e) => e.type === 'error').code, 'modelNotServed', String(model_source));
  }
});

test('a served name the filtered model list hides (a -long profile, a hash-ID row) is not reported as not served', async (t) => {
  const hash = 'a'.repeat(32);
  for (const name of ['router-model-long', hash]) {
    const f = setup(t, { diary: () => sse([...STARTED, { type: 'error', text: 'x' }]), health: { ok: true, model: name, model_source: 'configured' }, served: ['router-model', name] });
    assert.equal((await f.run()).events.find((e) => e.type === 'error').code, 'modelFailed', name);
  }
});

test('an empty served list: the diagnosis is skipped, not guessed', async (t) => {
  const f = setup(t, { diary: () => sse([...STARTED, { type: 'error', text: 'x' }]), health: { ok: true, model: 'x', model_source: 'configured' }, served: [] });
  assert.equal((await f.run()).events.find((e) => e.type === 'error').code, 'modelFailed');
});
