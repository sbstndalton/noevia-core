'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const source = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
const handler = source.slice(source.indexOf('async function handleChat('), source.indexOf('// ── Routing'));

async function run({ visionModel, probeStatus = 200, descriptionStatus = 200, missingAsset = false } = {}) {
  const events = [], requests = [];
  const res = new EventEmitter();
  res.writeHead = () => {};
  res.write = line => events.push(JSON.parse(line.slice(6)));
  res.end = () => { res.writableEnded = true; };
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/documents/statement.png'));
  const fetch = async (url, opts) => {
    assert.equal(url, 'http://fixture.invalid/v1/chat/completions');
    const body = JSON.parse(opts.body); requests.push(body);
    if (body.stream) return { ok: true, body: (async function* () {
      yield Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Synthetic answer' } }] }) + '\n\n');
    })() };
    if (body.max_tokens === 1) return new Response(probeStatus === 200 ? '{}' : 'provide the mmproj', { status: probeStatus });
    assert.equal(body.model, visionModel);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Fixture image: invoice INV-2042 total 34.95' } }] }), { status: descriptionStatus });
  };
  const context = {
    AbortController, AbortSignal, TextDecoder, console: { ...console, warn: () => {} }, path, fetch,
    fs: { readFileSync: () => { if (missingAsset) throw new Error('missing fixture'); return bytes; } },
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', model: 'answer-model', assets: [
      { id: 'image-a', name: 'statement.png', mime: 'image/png' }, { id: 'image-b', name: 'copy.png', mime: 'image/png' },
    ] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid' }),
    providerHeaders: () => ({}), autoRoles: () => visionModel ? { vision: visionModel } : null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => true,
  };
  vm.createContext(context); vm.runInContext(handler, context);
  await context.handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'Read the synthetic total' });
  assert.ok(events.some(e => e.type === 'done'));
  return { events, requests, answer: requests.find(r => r.stream) };
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
    assert.equal(out.events.some(e => e.type === 'warning'), probeStatus !== 200);
  }
});

test('audit: missing asset bytes currently produce no user-facing image warning', async () => {
  const out = await run({ missingAsset: true });
  assert.equal(out.events.some(e => e.type === 'warning'), false);
  assert.equal(JSON.stringify(out.answer).includes('data:image'), false);
});
