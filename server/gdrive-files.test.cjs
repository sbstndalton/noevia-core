'use strict';
// drive_read_file must never buffer an entire Drive file: it asks for a byte range on alt=media
// reads, and caps + cancels the stream itself in case a server ignores Range. Synthetic fixtures
// only: a fake `call`/`request` pair standing in for gdrive.cjs, never a real Drive connection.
const test = require('node:test'), assert = require('node:assert/strict');
const { driveFiles } = require('./gdrive-files.cjs');

const META = { id: 'f1', name: 'huge.txt', mimeType: 'text/plain' };

// A streaming Response whose body is far larger than MAX_READ (64 KiB); tracks whether the
// reader was cancelled and how many bytes were actually produced before that happened.
function hugeStreamResponse({ ok = true, status = 200, totalBytes = 200 * 1024 * 1024, chunkSize = 64 * 1024 } = {}) {
  const state = { cancelled: false, producedBytes: 0, requestedHeaders: null };
  let sent = 0;
  const reader = {
    read: async () => {
      if (state.cancelled || sent >= totalBytes) return { done: true, value: undefined };
      const size = Math.min(chunkSize, totalBytes - sent);
      const value = Buffer.alloc(size, 'x');
      sent += size;
      state.producedBytes += size;
      return { done: false, value };
    },
    cancel: async () => { state.cancelled = true; },
    releaseLock: () => {},
  };
  const response = { ok, status, body: { getReader: () => reader } };
  return { response, state };
}

function makeDrive({ response, requestedHeaders }) {
  return {
    api: 'https://drive.example/v3', upload: 'https://drive.example/upload',
    call: async () => META,
    request: async (url, init) => { requestedHeaders.push(init && init.headers); return response; },
  };
}

test('drive_read_file caps a multi-GB streaming file and cancels the stream instead of buffering it', async () => {
  const { response, state } = hugeStreamResponse();
  const requestedHeaders = [];
  const files = driveFiles(makeDrive({ response, requestedHeaders }));
  const { text, truncated } = await files.read({ fileId: 'f1' });

  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(text, 'utf8') <= 64 * 1024, 'returned text stays within MAX_READ');
  assert.equal(state.cancelled, true, 'the stream reader was cancelled once the cap was reached');
  // The whole point: memory held is bounded near the cap, nowhere near the 200 MiB source.
  assert.ok(state.producedBytes < 1024 * 1024, `only read a small prefix before cancelling, got ${state.producedBytes}`);
  assert.deepEqual(requestedHeaders, [{ Range: 'bytes=0-65536' }]);
});

test('drive_read_file does not truncate or cancel when the file is under the cap', async () => {
  const { response, state } = hugeStreamResponse({ totalBytes: 100, chunkSize: 100 });
  const requestedHeaders = [];
  const files = driveFiles(makeDrive({ response, requestedHeaders }));
  const { text, truncated } = await files.read({ fileId: 'f1' });

  assert.equal(truncated, false);
  assert.equal(text, 'x'.repeat(100));
  assert.equal(state.cancelled, false);
});

test('drive_read_file still caps a server that ignores Range and returns 200 with the full body', async () => {
  // Some servers answer 200 (not 206) and stream everything anyway; the reader-side cap is the
  // real backstop, not the Range header.
  const { response, state } = hugeStreamResponse({ status: 200, totalBytes: 5 * 1024 * 1024 });
  const requestedHeaders = [];
  const files = driveFiles(makeDrive({ response, requestedHeaders }));
  const { truncated } = await files.read({ fileId: 'f1' });

  assert.equal(truncated, true);
  assert.equal(state.cancelled, true);
});
