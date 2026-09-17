const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), os = require('node:os');

function server(tag, seen) {
  return http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    seen.push({ tag, url: req.url, auth: req.headers.authorization || null, body: JSON.parse(raw) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: JSON.parse(raw).input.map((_, index) => ({ index, embedding: [tag === 'embed' ? 1 : 2, 0] })) }));
  });
}

async function withServers(fn) {
  const seen = [], chat = server('chat', seen), embed = server('embed', seen);
  await Promise.all([chat, embed].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  try { return await fn({ seen, chat: `http://127.0.0.1:${chat.address().port}/v1`, embed: `http://127.0.0.1:${embed.address().port}/v1` }); }
  finally { chat.close(); embed.close(); }
}

function freshRag() { delete require.cache[require.resolve('./rag.cjs')]; return require('./rag.cjs'); }

test('embeddings use the chat engine with its credentials by default', () => withServers(async ({ seen, chat }) => {
  delete process.env.EMBEDDING_BASE_URL;
  const rag = freshRag();
  rag.init({ dataDir: os.tmpdir(), embedModel: 'nomic', inferenceUrl: chat, headersFn: () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer engine-secret' }) });
  assert.deepEqual(await rag.embed(['a']), [[2, 0]]);
  assert.equal(seen[0].tag, 'chat'); assert.equal(seen[0].url, '/v1/embeddings'); assert.equal(seen[0].auth, 'Bearer engine-secret');
}));

test('EMBEDDING_BASE_URL sends embeddings elsewhere, without the engine credentials', () => withServers(async ({ seen, chat, embed }) => {
  process.env.EMBEDDING_BASE_URL = embed;
  try {
    const rag = freshRag();
    rag.init({ dataDir: os.tmpdir(), embedModel: 'nomic', inferenceUrl: chat, headersFn: () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer engine-secret' }) });
    assert.deepEqual(await rag.embed(['a', 'b']), [[1, 0], [1, 0]]);
    assert.deepEqual(seen.map((s) => s.tag), ['embed']);
    assert.equal(seen[0].auth, null);
    assert.equal(seen[0].body.model, 'nomic');
  } finally { delete process.env.EMBEDDING_BASE_URL; }
}));
