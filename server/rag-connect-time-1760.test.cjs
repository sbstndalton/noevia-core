'use strict';
// #1760: the embedding and rerank requests resolve a name at CONNECT time and refuse it unless every
// answer is on this network (service-endpoint.cjs), so a name that answered private when the address was
// set and public when the socket connects (DNS rebinding) is refused. Synthetic names; DNS is stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');

function freshRag() { delete require.cache[require.resolve('./rag.cjs')]; return require('./rag.cjs'); }

// The Rust port is not loaded here: "public" is anything that is not the fixture's loopback address.
const addressesPublic = (list) => list.some((a) => a !== '127.0.0.1');
// Answers 127.0.0.1 (the fixture) to the first lookup of a name and a public address to every later one.
function rebinding() {
  let calls = 0;
  const resolve = (_host, _opts, cb) => { const address = ++calls === 1 ? '127.0.0.1' : '93.184.216.34'; cb(null, [{ address, family: 4 }]); };
  return { resolve, calls: () => calls };
}

async function fixture(t) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    seen.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    const body = JSON.parse(raw);
    if (req.url.endsWith('/rerank')) return res.end(JSON.stringify({ results: body.documents.map((_, index) => ({ index, relevance_score: index })) }));
    res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { port: server.address().port, seen };
}

test('#1760: an embedding request to a rebinding name is refused at connect', async (t) => {
  delete process.env.EMBEDDING_BASE_URL;
  const { port, seen } = await fixture(t);
  const dns = rebinding();
  const rag = freshRag();
  rag._test.setRagFetch(rag._test.makeRagFetch({ resolve: dns.resolve, addressesPublic }));
  rag.init({ dataDir: os.tmpdir(), embedModel: 'nomic', inferenceUrl: `http://embed.rebind.lan:${port}/v1` });
  assert.deepEqual(await rag.embed(['a']), [[1, 0]], 'while the name is private the request goes through');
  await assert.rejects(rag.embed(['b']), (e) => e.code === 'EPUBLICADDR' || /refused/.test(e.message));
  assert.equal(seen.length, 1, 'the refused request never reached a server');
});

test('#1760: a rerank request to a rebinding name is refused at connect', async (t) => {
  const { port, seen } = await fixture(t);
  const dns = rebinding();
  const rag = freshRag();
  rag._test.setRagFetch(rag._test.makeRagFetch({ resolve: dns.resolve, addressesPublic }));
  const backend = rag._test.rerankBackend(`http://rerank.rebind.lan:${port}`);
  const request = { question: 'q', items: [{ id: '0', label: 'x' }, { id: '1', label: 'y' }] };
  assert.deepEqual((await backend.decide(request)).selected, ['1', '0']);
  await assert.rejects(backend.decide(request), (e) => e.code === 'EPUBLICADDR' || /refused/.test(e.message));
  assert.equal(seen.length, 1);
});

test('#1760: the reranker no longer follows a redirect', async (t) => {
  const target = http.createServer((_q, res) => { res.end('{}'); });
  const redirector = http.createServer((_q, res) => { res.statusCode = 307; res.setHeader('Location', `http://127.0.0.1:${target.address().port}/v1/rerank`); res.end(); });
  await Promise.all([target, redirector].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  t.after(() => Promise.all([target, redirector].map((s) => new Promise((r) => s.close(r)))));
  const rag = freshRag();
  rag._test.setRagFetch(rag._test.makeRagFetch({ addressesPublic }));
  await assert.rejects(rag._test.rerankBackend(`http://127.0.0.1:${redirector.address().port}`).decide({ question: 'q', items: [{ id: '0', label: 'x' }] }), /redirect/);
});

test('#1760: embedding and rerank requests to a public or link-local literal are refused without a request', async () => {
  const rag = freshRag();
  const f = rag._test.makeRagFetch({ addressesPublic });
  for (const url of ['http://93.184.216.34/v1/embeddings', 'http://169.254.10.20/v1/embeddings', 'http://[fe80::1]/v1/rerank', 'http://100.100.100.200/v1/embeddings']) {
    await assert.rejects(f(url, { method: 'POST', body: '{}' }), (e) => e.code === 'EPUBLICADDR', url);
  }
});
