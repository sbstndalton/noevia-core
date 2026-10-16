'use strict';
// #1885: a large file read from storage (storage-client.cjs readFile, over 25 MiB) sits in a
// SharedArrayBuffer so the page-range workers can read it in place. Node 22's fetch (undici) refuses a
// body backed by one ("ArrayBuffer: SharedArrayBuffer is not allowed"), so every upload of such bytes
// failed before reaching the worker. Such bytes are sent as a stream instead, copied out ~1 MiB at a time
// into ordinary memory (at most a couple of slices alive at once, never a second copy of the file), with
// an explicit Content-Length: the sidecars refuse a chunked body, and undici sends the given length (no
// Transfer-Encoding) when one is set. Ordinary bytes are passed through exactly as before.
const SLICE = 1024 * 1024;
const isShared = (bytes) => typeof SharedArrayBuffer !== 'undefined' && ArrayBuffer.isView(bytes) && bytes.buffer instanceof SharedArrayBuffer;
/** A ReadableStream over `bytes`, each chunk a fresh (non-shared) copy of at most `slice` bytes. */
function sliceStream(bytes, slice = SLICE) {
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= view.byteLength) { controller.close(); return; }
      const end = Math.min(view.byteLength, offset + slice);
      const chunk = new Uint8Array(end - offset);
      chunk.set(view.subarray(offset, end));
      offset = end;
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
}
/**
 * The fetch init for sending `bytes` as the body of `init`. Call it once per request (a stream is read
 * once), e.g. inside a retry's factory.
 */
function uploadInit(bytes, init = {}) {
  if (!isShared(bytes)) return { ...init, body: bytes };
  const headers = new Headers(init.headers || {});
  headers.set('content-length', String(bytes.byteLength));
  return { ...init, headers, body: sliceStream(bytes), duplex: 'half' };
}
module.exports = { uploadInit, isShared, sliceStream, SLICE };
