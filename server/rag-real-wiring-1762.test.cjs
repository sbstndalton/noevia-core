'use strict';
// #1762: rag.cjs makeRagFetch() with NO arguments wires the real Rust ssrfAddressesPublic (ssrf.cjs ->
// dav-parse.wasm). Every other test stubs addressesPublic, so a renamed export would fail every live
// embedding closed while CI stayed green. Here nothing is stubbed. Synthetic fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rag = require('./rag.cjs');
const ssrf = require('./ssrf.cjs');

test('the real Rust ssrfAddressesPublic export exists and decides', () => {
  assert.equal(typeof ssrf.ssrfWasm().ssrfAddressesPublic, 'function');
  assert.equal(ssrf.ssrfWasm().ssrfAddressesPublic(['8.8.8.8']), true);
  assert.equal(ssrf.ssrfWasm().ssrfAddressesPublic(['127.0.0.1']), false);
});

test('makeRagFetch() with no arguments reaches a loopback server through the real Rust check and refuses a public address', async (t) => {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"data":[]}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const f = rag._test.makeRagFetch();
  const ok = await f(`http://127.0.0.1:${server.address().port}/v1/embeddings`, { method: 'POST', body: '{}' });
  assert.equal(ok.status, 200, 'a renamed or broken ssrfAddressesPublic would refuse this loopback address');
  await assert.rejects(f('http://8.8.8.8/v1/embeddings'), (e) => e.code === 'EPUBLICADDR' || /network|public/i.test(String(e.cause?.message || e.message)));
});

test('the _test seam is only exported under the test runner', () => {
  assert.ok(rag._test, 'present under node --test');
  const env = { ...process.env, NODE_ENV: 'production' };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['-e', `const rag = require(${JSON.stringify(path.join(__dirname, 'rag.cjs'))}); process.stdout.write(String(rag._test))`], { env, encoding: 'utf8' });
  assert.equal(r.stdout, 'undefined', r.stderr);
});
