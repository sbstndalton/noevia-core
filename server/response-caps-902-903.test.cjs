'use strict';
// #902 / #903: bodies from storage hosts and model providers are read with a byte cap, so a
// remote that streams an endless reply cannot make the web process buffer it. Every fake reply
// below is a pull-based stream far larger than the cap; each test asserts the reader stopped
// after about the cap instead of draining it. Synthetic hosts and fixtures only; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { readCappedText, readCappedJson } = require('./http.cjs');

const CHUNK = 64 * 1024;
const MB = 1024 * 1024;

/** A body of `total` bytes (far past any cap) that counts what was actually pulled. */
function hugeBody(total = 64 * MB, prefix = '') {
  const meter = { pulled: 0, cancelled: false };
  let first = Buffer.from(prefix);
  const stream = new ReadableStream({
    pull(controller) {
      if (meter.pulled >= total) return controller.close();
      const chunk = first.length ? first : Buffer.alloc(CHUNK, 0x61);
      first = Buffer.alloc(0);
      meter.pulled += chunk.length;
      controller.enqueue(new Uint8Array(chunk));
    },
    cancel() { meter.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, meter };
}

test('readCappedText stops after the cap and reports it; a short body reads whole', async () => {
  const { stream, meter } = hugeBody();
  const out = await readCappedText(new Response(stream), 256 * 1024);
  assert.equal(out.capped, true);
  assert.equal(Buffer.byteLength(out.text), 256 * 1024);
  assert.ok(meter.pulled <= 256 * 1024 + 2 * CHUNK, `pulled ${meter.pulled} bytes`);
  assert.equal(meter.cancelled, true);
  assert.deepEqual(await readCappedText(new Response('{"a":1}'), 1024), { text: '{"a":1}', capped: false });
  assert.deepEqual(await readCappedText({ text: async () => 'stub' }, 1024), { text: 'stub', capped: false });
});

test('readCappedText on a clone settles, and the original still reads afterwards (teed body)', async () => {
  const { stream, meter } = hugeBody();
  const response = new Response(stream, { status: 400 });
  const first = await readCappedText(response.clone(), 64 * 1024);
  const second = await readCappedText(response, 64 * 1024);
  assert.equal(first.capped && second.capped, true);
  assert.equal(second.text, first.text);
  assert.ok(meter.pulled <= 64 * 1024 + 4 * CHUNK, `pulled ${meter.pulled} bytes`);
});

test('readCappedJson refuses an oversized reply instead of parsing part of it', async () => {
  const { stream, meter } = hugeBody(64 * MB, '{"choices":[');
  await assert.rejects(() => readCappedJson(new Response(stream), 64 * 1024), (e) => e.code === 'too_large' && e.status === 502);
  assert.ok(meter.pulled <= 64 * 1024 + 2 * CHUNK, `pulled ${meter.pulled} bytes`);
  assert.deepEqual(await readCappedJson(new Response('{"ok":true}'), 1024), { ok: true });
  assert.deepEqual(await readCappedJson({ json: async () => ({ stub: 1 }) }, 1024), { stub: 1 }, 'a json-only stub keeps working');
});

// ── #902: storage-client ────────────────────────────────────────────────────
const LIST_CAP = 4 * MB;
const conn = { kind: 'webdav', baseUrl: 'https://dav.invalid/dav', username: 'synthetic', secret: 'synthetic' };
function withFakeFetch(t, handler) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), method: init?.method }); return handler(url, init); };
  t.after(() => { globalThis.fetch = real; });
  return seen;
}

test('#902: fileVersion stops reading an endless 207 after ~4 MB and answers 502', async (t) => {
  const { fileVersion } = require('./storage-client.cjs');
  const { stream, meter } = hugeBody(64 * MB, '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/Docs/a.md</d:href><d:getetag>"e1"</d:getetag>');
  withFakeFetch(t, async () => new Response(stream, { status: 207 }));
  await assert.rejects(() => fileVersion(conn, 'Docs/a.md'), (e) => e.status === 502 && e.code === 'too_large');
  assert.ok(meter.pulled <= LIST_CAP + 2 * CHUNK, `pulled ${meter.pulled} bytes`);
});

test('#902: fileVersion still reads a normal 207', async (t) => {
  const { fileVersion } = require('./storage-client.cjs');
  withFakeFetch(t, async () => new Response('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/Docs/a.md</d:href><d:propstat><d:prop><d:resourcetype/><d:getetag>&quot;e1&quot;</d:getetag></d:prop></d:propstat></d:response></d:multistatus>', { status: 207 }));
  assert.deepEqual(await fileVersion(conn, 'Docs/a.md'), { exists: true, etag: '"e1"' });
});

test('#902: removeEmptyFolder stops reading an endless 207 after ~4 MB and never deletes', async (t) => {
  const { removeEmptyFolder } = require('./storage-client.cjs');
  const { stream, meter } = hugeBody(64 * MB, '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/Docs/empty/</d:href><d:resourcetype><d:collection/></d:resourcetype><d:getetag>"dir"</d:getetag></d:response><!--');
  const seen = withFakeFetch(t, async () => new Response(stream, { status: 207 }));
  assert.deepEqual(await removeEmptyFolder(conn, 'Docs/empty'), { removed: false, reason: 'too-large' });
  assert.ok(meter.pulled <= LIST_CAP + 2 * CHUNK, `pulled ${meter.pulled} bytes`);
  assert.deepEqual(seen.map((s) => s.method), ['PROPFIND'], 'no DELETE after a cut-off listing');
});

// ── #902: the Nextcloud login flow replies ─────────────────────────────────
function storageRoutes(network) {
  const { createStorageRoutes } = require('./routes/storage.cjs');
  const sent = [];
  const routes = createStorageRoutes({
    json: (_res, status, body) => { sent.push({ status, body }); },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    authService: { getStorage: () => ({ kind: 'local' }), saveStorage: (_id, body) => ({ ok: true, kind: body.kind }) },
    storageClient: { isBrowsable: () => false },
    endpointApproved: () => true,
    fetch: async (url, init) => network(String(url), init),
    crypto: { randomUUID: () => 'flow-1' },
  });
  const call = (p, body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST';
    return routes(req, {}, { path: p, authn: { user: { id: 'u1', role: 'member' } } });
  };
  return { call, sent };
}

test('#902: an endless Nextcloud login/v2 reply is cut at 64 KB and answered 502', async () => {
  const { stream, meter } = hugeBody(64 * MB, '{"login":"');
  const f = storageRoutes(async () => new Response(stream, { status: 200 }));
  await f.call('/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.invalid' });
  assert.equal(f.sent.at(-1).status, 502);
  assert.ok(meter.pulled <= 64 * 1024 + 2 * CHUNK, `pulled ${meter.pulled} bytes`);
});

test('#902: an endless Nextcloud poll reply is cut at 64 KB and answered 502', async () => {
  const { stream, meter } = hugeBody(64 * MB, '{"server":"');
  const f = storageRoutes(async (url) => (url.endsWith('/index.php/login/v2')
    ? new Response(JSON.stringify({ login: 'https://cloud.invalid/login/flow/x', poll: { endpoint: 'https://cloud.invalid/login/v2/poll', token: 'synthetic' } }), { status: 200 })
    : new Response(stream, { status: 200 })));
  await f.call('/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.invalid' });
  assert.equal(f.sent.at(-1).status, 200);
  await f.call('/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
  assert.deepEqual(f.sent.at(-1), { status: 502, body: { error: 'Nextcloud reply too large' } });
  assert.ok(meter.pulled <= 64 * 1024 + 2 * CHUNK, `pulled ${meter.pulled} bytes`);
});

// ── #903: chat.cjs provider bodies ──────────────────────────────────────────
async function chatWith(t, fetch, reqBody) {
  const { createChatHandler } = require('./chat.cjs');
  const { createToolExchange } = require('./tool-exchange.cjs');
  const { createVisionProbe } = require('./vision.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-caps-903-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [];
  const res = new EventEmitter(); res.writeHead = () => {}; res.write = (c) => { events.push(String(c)); }; res.end = () => { res.emit('finish'); };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'synthetic-local-model', loaded: true }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {}, diaryEnabled: () => false },
    crypto: require('node:crypto'), path, fs, fetch, HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', routing: 'manual', assets: [], toolboxes: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', label: 'Local', baseUrl: 'http://fixture.invalid' }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => false,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' },
    requestScope: { getStore: () => ({ authn: { user: { id: 'synthetic-user', role: 'member' } }, workspace: { userId: 'synthetic-user' } }) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (r) => ({ text: String(r) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => 'synthetic-local-model', classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], chatWideApproved: () => false, awaitApproval: async () => 'deny', recordUsage() {}, recordToolUse() {}, executeToolCall: async () => '',
    json: (_res, status, body) => { events.push(JSON.stringify({ status, body })); },
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', ...reqBody });
  return events.join('');
}

test('#903: an endless non-OK provider body is read to ~64 KB and the error still surfaces', async (t) => {
  const { stream, meter } = hugeBody(64 * MB, '{"error":{"message":"synthetic overload"},"pad":"');
  const out = await chatWith(t, async () => new Response(stream, { status: 500 }), { message: 'hello' });
  assert.match(out, /"type":"error"/);
  assert.ok(meter.pulled <= 64 * 1024 + 2 * CHUNK, `pulled ${meter.pulled} bytes`);
});

test('#903: an endless 4xx provider body is checked to ~64 KB by the effort retry and the chat error path', async (t) => {
  const { stream, meter } = hugeBody(64 * MB, '{"error":{"message":"synthetic bad request"},"pad":"');
  const out = await chatWith(t, async () => new Response(stream, { status: 400 }), { message: 'hello' });
  assert.match(out, /"type":"error"/);
  assert.ok(meter.pulled <= 64 * 1024 + 4 * CHUNK, `pulled ${meter.pulled} bytes`);
});

test('#903: an endless summary reply during compaction stops at ~4 MB with a clear error', async (t) => {
  const { stream, meter } = hugeBody(64 * MB, '{"choices":[{"message":{"content":"');
  const history = [];
  for (let i = 0; i < 6; i++) history.push({ role: i % 2 ? 'assistant' : 'user', content: `synthetic turn ${i}` });
  const out = await chatWith(t, async (_url, init) => {
    const sent = JSON.parse(init.body);
    assert.equal(sent.stream, false, 'only the summary request is sent');
    return new Response(stream, { status: 200 });
  }, { message: 'continue', history, compactOnly: true });
  assert.match(out, /Compaction reply from the model provider was too large/);
  assert.ok(meter.pulled <= 4 * MB + 2 * CHUNK, `pulled ${meter.pulled} bytes`);
});

// ── review follow-up: replaced replies are released ─────────────────────────
test('requestWithEffort cancels the rejected 4xx reply it replaces with a retry', async () => {
  const { requestWithEffort } = require('./reasoning-effort.cjs');
  const { stream, meter } = hugeBody(64 * MB, '{"error":"reasoning_effort unsupported","pad":"');
  const provider = { id: 'fixture-caps', baseUrl: 'https://cloud.fixture.invalid/v1', apiKey: 'synthetic-caps-discard', capabilities: { reasoningEffortParam: true, reasoningEffortModels: ['synthetic-model'], tokenBudgetField: 'max_completion_tokens' } };
  let calls = 0;
  const result = await requestWithEffort(async () => (++calls === 1 ? new Response(stream, { status: 400 }) : new Response('{}')),
    'https://cloud.fixture.invalid/v1/chat/completions', {}, { model: 'synthetic-model', messages: [{ role: 'user', content: 'hi' }] }, provider, 'synthetic-model', 'high', () => {});
  assert.equal(calls, 2);
  assert.equal(result.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(meter.cancelled, true, 'the original body was cancelled, so its socket can close');
  assert.ok(meter.pulled <= 64 * 1024 + 4 * CHUNK, `pulled ${meter.pulled} bytes`);
});

// ── #918: provider failures reach the browser as mapped text ───────────────
test('#918: a non-streaming fallback 502 with an HTML body sends providerError text, no markup', async (t) => {
  const { providerError } = require('./chat-context.cjs');
  const html = '<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>';
  const out = await chatWith(t, async (_url, init) => (JSON.parse(init.body).stream
    ? new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    : new Response(html, { status: 502, headers: { 'content-type': 'text/html' } })), { message: 'hello' });
  const errors = out.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((e) => e.type === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].text, providerError(html));
  assert.doesNotMatch(errors[0].text, /</);
  assert.doesNotMatch(errors[0].text, /Unexpected token|JSON/);
});

test('#918: a stream that breaks mid-read sends mapped text, not the runtime error', async (t) => {
  const { providerError } = require('./chat-context.cjs');
  const internal = 'terminated: other side closed <synthetic socket 10.0.0.1:443>';
  const broken = () => new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')); },
    pull(c) { c.error(new TypeError(internal)); },
  });
  const out = await chatWith(t, async () => new Response(broken(), { status: 200, headers: { 'content-type': 'text/event-stream' } }), { message: 'hello' });
  const errors = out.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((e) => e.type === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].text, providerError(internal));
  assert.doesNotMatch(errors[0].text, /other side closed|</);
});
