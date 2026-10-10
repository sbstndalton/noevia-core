'use strict';
// The loopback stand-ins a contract corpus is recorded (and replayed) against: an
// OpenAI-compatible model server with fixed answers and a Diary that always answers 503, plus the
// clean server environment both generate.cjs and serve.cjs give server/index.cjs.
const http = require('node:http');
const path = require('node:path');

const MODEL = 'synthetic-chat-model';
const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server', 'index.cjs');
const GUARD = path.join(__dirname, 'net-guard.cjs');

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const s = Buffer.concat(chunks).toString('utf8');
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

// OpenAI-compatible enough for the chat loop: a model list, streamed and plain completions,
// embeddings. Deterministic text so two runs record the same events.
async function mockInference(req, res) {
  const url = new URL(req.url, 'http://mock');
  const body = await readBody(req);
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (url.pathname.endsWith('/models')) return send(200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'synthetic' }] });
  if (url.pathname.endsWith('/embeddings')) {
    const input = Array.isArray(body.input) ? body.input : [body.input || ''];
    return send(200, { object: 'list', data: input.map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: 8 }, (__, k) => (k + index) / 10) })) });
  }
  if (url.pathname.endsWith('/chat/completions')) {
    const text = 'Hello from the synthetic model.';
    if (!body.stream) return send(200, { id: 'cmpl-synthetic', object: 'chat.completion', model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of ['Hello ', 'from the ', 'synthetic model.']) {
      res.write(`data: ${JSON.stringify({ id: 'cmpl-synthetic', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ id: 'cmpl-synthetic', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } })}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  return send(404, { error: 'not mocked' });
}

// The Diary add-on stays off for both accounts; this only keeps a stray call from hanging.
async function mockDiary(req, res) {
  await readBody(req);
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ detail: 'synthetic diary mock' }));
}


async function startMocks() {
  const inference = await listen(mockInference);
  const diary = await listen(mockDiary);
  return { inference, diary, close() { inference.close(); diary.close(); } };
}

/** The whole environment server/index.cjs gets: nothing is inherited but PATH. */
function serverEnv({ port, dataDir, origin, mocks, record }) {
  const inferenceUrl = `http://127.0.0.1:${mocks.inference.address().port}`;
  return {
    PATH: process.env.PATH, NODE_ENV: 'production', TZ: 'UTC', LANG: 'C.UTF-8',
    UI_PORT: String(port), UI_HOST: '127.0.0.1', UI_DATA_DIR: dataDir, PUBLIC_ORIGIN: origin,
    INFERENCE_BASE_URL: inferenceUrl, MODEL_MANAGER_KIND: 'none', MODEL_MANAGER_BASE_URL: inferenceUrl,
    DIARY_BASE_URL: `http://127.0.0.1:${mocks.diary.address().port}`, MODEL_LOADER_URL: '', MCP_SERVERS: '',
    COWORK_DECISION_URL: '', COWORK_SYSTEM_ONE_URL: '', DIARY_BACKUP_WORKER_INTERVAL_MS: '3600000',
    ...(record ? { NOEVIA_CONTRACT_RECORD: record } : {}),
    NOEVIA_CORPUS_ALLOWED_PORTS: [mocks.inference.address().port, mocks.diary.address().port].join(','),
  };
}

module.exports = { MODEL, SERVER, GUARD, startMocks, serverEnv, readBody };
