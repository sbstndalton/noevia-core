'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readBinaryFile } = require('./storage-client.cjs');
for (const kind of ['webdav', 's3']) {
  test(`${kind} stops a stream over the cap even with absent or false content length`, async () => {
    const saved = global.fetch;
    try {
      for (const length of [undefined, '1', '100']) {
        let pulls = 0, cancelled = false;
        global.fetch = async (_url, options) => {
          assert.equal(options.redirect, 'error');
          return new Response(new ReadableStream({
            pull(controller) { pulls++; controller.enqueue(Uint8Array.from([255, 128, 1, 2])); },
            cancel() { cancelled = true; },
          }, { highWaterMark: 0 }), { headers: length ? { 'content-length': length } : {} });
        };
        await assert.rejects(readBinaryFile({ kind, baseUrl: 'http://fixture.invalid', bucket: 'b' }, 'f.pdf', { cap: 5 }), e => e.status === 413);
        assert.equal(cancelled, true);
        assert.equal(pulls, length === '100' ? 0 : 2);
      }
    } finally { global.fetch = saved; }
  });
}
