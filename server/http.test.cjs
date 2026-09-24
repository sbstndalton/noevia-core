'use strict';
// The HTTP helpers on their own: the reply shapes, the body cap, and that fetchJson never
// follows a redirect, times out, honours the caller's abort and hands back text it could
// not parse. Synthetic fetch only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { json, unauthorized, fetchJson, readBody, readJson, authResult, DEFAULT_MAX_RESPONSE_BYTES } = require('./http.cjs');

// A minimal streaming Response.body stand-in: a web ReadableStream-like object exposing
// getReader().read() the same way Node's fetch() Response.body does.
function streamingBody(chunks) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          const value = chunks[i++];
          return { done: false, value };
        },
        releaseLock() {},
        async cancel() { i = chunks.length; },
      };
    },
  };
}

function fakeRes() {
  const res = { head: null, body: null, writeHead(code, headers) { res.head = { code, headers }; }, end(body) { res.body = body; } };
  return res;
}

test('json and unauthorized write the same no-store JSON shape; authResult unwraps auth results', () => {
  const res = fakeRes();
  json(res, 201, { ok: true });
  assert.deepEqual(res.head, { code: 201, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  assert.equal(res.body, '{"ok":true}');
  const denied = fakeRes();
  unauthorized(denied);
  assert.equal(denied.head.code, 401);
  assert.equal(denied.head.headers['WWW-Authenticate'], 'Bearer realm="cowork"');
  assert.equal(denied.body, '{"error":"unauthorized"}');
  const wrapped = fakeRes();
  authResult(wrapped, { status: 403, body: { error: 'nope' } });
  assert.equal(wrapped.head.code, 403);
  assert.equal(wrapped.body, '{"error":"nope"}');
  const bare = fakeRes();
  authResult(bare, { ok: true });
  assert.equal(bare.head.code, 200);
  assert.equal(bare.body, '{"ok":true}');
});

test('readBody enforces its cap with a 413 and readJson treats an empty body as {}', async () => {
  const req = (text) => Readable.from(text ? [Buffer.from(text)] : []);
  assert.equal(await readBody(req('héllo')), 'héllo');
  await assert.rejects(readBody(req('x'.repeat(11)), 10), (e) => e.status === 413 && e.message === 'Request exceeds size limit');
  assert.deepEqual(await readJson(req('')), {});
  assert.deepEqual(await readJson(req('{"a":1}')), { a: 1 });
  await assert.rejects(readJson(req('{')), { status: 400, message: 'invalid JSON' });
  await assert.rejects(readJson(req('12345'), 4), { status: 413 });
});

test('fetchJson parses JSON, keeps text otherwise, refuses redirects and reports status', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    if (url.endsWith('/text')) return { ok: false, status: 502, text: async () => 'bad gateway' };
    return { ok: true, status: 200, text: async () => '{"a":1}' };
  };
  try {
    assert.deepEqual(await fetchJson('http://x/json', { headers: { A: '1' } }, 1000), { ok: true, status: 200, body: { a: 1 } });
    assert.equal(seen[0].init.redirect, 'error');
    assert.deepEqual(seen[0].init.headers, { A: '1' });
    assert.ok(seen[0].init.signal instanceof AbortSignal);
    assert.deepEqual(await fetchJson('http://x/text', {}, 1000), { ok: false, status: 502, body: 'bad gateway' });
  } finally { globalThis.fetch = original; }
});

test('fetchJson caps an oversized response body without buffering it all, and honours an override', async () => {
  const original = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async (url) => {
    // 3 chunks of 4 MB each: over the 8 MB default cap, well under a naive in-memory read.
    const chunk = Buffer.alloc(4 * 1024 * 1024, 'a');
    const body = streamingBody([chunk, chunk, chunk]);
    const realCancel = body.getReader().cancel;
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          const reader = {
            i: 0,
            async read() {
              if (this.i >= 3) return { done: true, value: undefined };
              this.i++;
              return { done: false, value: chunk };
            },
            releaseLock() {},
            async cancel() { cancelled = true; this.i = 3; },
          };
          return reader;
        },
      },
      text: async () => chunk.toString(),
    };
  };
  try {
    const result = await fetchJson('http://x/huge', {}, 1000);
    assert.deepEqual(result, { ok: false, status: 200, error: 'response too large' });
    assert.equal(cancelled, true);

    // A caller-supplied override raises (or could lower) the cap.
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      body: streamingBody([Buffer.alloc(4 * 1024 * 1024, 'b')]),
      text: async () => 'unused',
    });
    const small = await fetchJson('http://x/ok', {}, 1000, 16 * 1024 * 1024);
    assert.equal(small.ok, true);
    assert.equal(small.body.length, 4 * 1024 * 1024);
  } finally { globalThis.fetch = original; }
});

test('fetchJson caps a stub Response without a streaming body (test doubles) too', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(20) });
  try {
    const result = await fetchJson('http://x/huge-stub', {}, 1000, 10);
    assert.deepEqual(result, { ok: false, status: 200, error: 'response too large' });
    const ok = await fetchJson('http://x/small-stub', {}, 1000, 100);
    assert.equal(ok.body, 'x'.repeat(20));
  } finally { globalThis.fetch = original; }
});

test('fetchJson default cap constant is exported and is 8 MB', () => {
  assert.equal(DEFAULT_MAX_RESPONSE_BYTES, 8 * 1024 * 1024);
});

test('fetchJson aborts on its timeout and on the caller\'s signal', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => { if (init.signal.aborted) return reject(new Error('aborted')); init.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
  try {
    await assert.rejects(fetchJson('http://x/slow', {}, 20), /aborted/);
    const external = new AbortController();
    const pending = assert.rejects(fetchJson('http://x/slow', { signal: external.signal }, 10000), /aborted/);
    external.abort();
    await pending;
    const already = new AbortController(); already.abort();
    await assert.rejects(fetchJson('http://x/slow', { signal: already.signal }, 10000), /aborted/);
  } finally { globalThis.fetch = original; }
});
