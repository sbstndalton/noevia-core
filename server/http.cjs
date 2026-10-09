'use strict';
// The HTTP helpers every route module is handed: one JSON reply shape, the 401 with its
// challenge, a JSON fetch with a timeout that also honours the caller's abort signal and
// never follows a redirect, a bounded body read, and the { status, body } unwrapping for
// results that auth.cjs returns. fetch is the global, resolved per call, because tests and
// QA swap it at runtime.

function json(res, code, body, headers) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function unauthorized(res) {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'WWW-Authenticate': 'Bearer realm="cowork"',
  });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

// Providers are user-configured base URLs (routes/providers.cjs, auto-router.cjs) and the
// Hugging Face variants lookup can point anywhere, so a misbehaving or malicious endpoint
// must not be able to make us buffer an unbounded response body into memory.
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// Reads a fetch Response body with a byte cap, streaming it so an oversized body never
// gets fully buffered. Falls back to res.text() for stub Response objects (as used in
// tests) that don't expose a streaming .body; those are still cap-checked after the fact.
async function _readCappedText(res, limit) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    let received = 0;
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > limit) {
          reader.cancel().catch(() => {});
          return { overflow: true, text: null };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    return { overflow: false, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8') };
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > limit) return { overflow: true, text: null };
  return { overflow: false, text };
}

/** Reads at most `cap` bytes of a response body as UTF-8, then cancels the rest of the stream,
 *  so a remote host (storage, model provider) streaming an endless body cannot make this
 *  process buffer it (#787, #902, #903). Returns `{ text, capped }`; `capped` is true when
 *  more than `cap` bytes were on offer. A body without a stream reader (a test stub) falls
 *  back to its text(), cut to the cap. */
async function readCappedText(response, cap) {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    if (typeof response?.text !== 'function') return { text: '', capped: false };
    const whole = Buffer.from(String(await response.text()), 'utf8');
    if (whole.length <= cap) return { text: whole.toString('utf8'), capped: false };
    return { text: whole.subarray(0, cap).toString('utf8').replace(/\uFFFD$/, ''), capped: true };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0, capped = false;
  try {
    while (size < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = cap - size;
      const piece = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(Buffer.from(piece));
      size += piece.byteLength;
    }
    if (size >= cap) {
      const next = await reader.read().catch(() => ({ done: true }));
      // Not awaited: cancelling one branch of a cloned (teed) body settles only once the other
      // branch is cancelled or read too, so awaiting it here would hang.
      if (!next.done) { capped = true; reader.cancel().catch(() => {}); }
    }
  } finally { reader.releaseLock(); }
  // A multi-byte character cut at the cap decodes to U+FFFD; drop it.
  let text = Buffer.concat(chunks, size).toString('utf8');
  if (capped) text = text.replace(/\uFFFD$/, '');
  return { text, capped };
}

/** Reads at most `cap` bytes of a response body as raw bytes (for a byte-for-byte comparison).
 *  Returns `{ bytes, capped }`; `capped` is true when more than `cap` bytes were on offer, and
 *  the rest of the stream is cancelled. A stub without a stream reader falls back to
 *  arrayBuffer(), cut to the cap. */
async function readCappedBuffer(response, cap) {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    if (typeof response?.arrayBuffer !== 'function') return { bytes: Buffer.alloc(0), capped: false };
    const whole = Buffer.from(await response.arrayBuffer());
    return whole.length <= cap ? { bytes: whole, capped: false } : { bytes: whole.subarray(0, cap), capped: true };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0, capped = false;
  try {
    while (size < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = cap - size;
      const piece = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(Buffer.from(piece));
      size += piece.byteLength;
    }
    if (size >= cap) {
      const next = await reader.read().catch(() => ({ done: true }));
      if (!next.done) { capped = true; reader.cancel().catch(() => {}); }
    }
  } finally { reader.releaseLock(); }
  return { bytes: Buffer.concat(chunks, size), capped };
}

/** Releases a reply that will not be read (a retry replaced it), so its socket closes instead
 *  of staying open behind a locked, unread body. Never throws; a stub body without cancel is
 *  left alone. */
function discardBody(response) {
  try {
    const body = response?.body;
    if (body && typeof body.cancel === 'function' && !body.locked) body.cancel().catch(() => {});
  } catch { /* nothing to release */ }
}

/** A JSON reply of at most `cap` bytes. A longer one throws (`code: 'too_large'`, status 502)
 *  instead of being parsed from a partial body. A test stub without a stream reader but with
 *  json() keeps using it. */
async function readCappedJson(response, cap) {
  if ((!response?.body || typeof response.body.getReader !== 'function') && typeof response?.json === 'function' && typeof response?.text !== 'function') {
    return response.json();
  }
  const { text, capped } = await readCappedText(response, cap);
  if (capped) throw Object.assign(new Error(`reply exceeded the ${Math.round(cap / 1024)} KB limit`), { status: 502, code: 'too_large' });
  return JSON.parse(text);
}

async function fetchJson(url, opts, timeoutMs, maxResponseBytes) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  // Honor a caller-supplied signal (e.g. client disconnect) in addition to the timeout.
  const external = opts && opts.signal;
  const onAbort = () => ctrl.abort();
  if (external?.aborted) ctrl.abort();
  else external?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { ...opts, redirect: 'error', signal: ctrl.signal });
    const limit = maxResponseBytes || (opts && opts.maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES;
    const { overflow, text } = await _readCappedText(res, limit);
    if (overflow) {
      return { ok: false, status: res.status, error: 'response too large' };
    }
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onAbort);
  }
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw Object.assign(new Error('Request exceeds size limit'), { status: 413 });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new SyntaxError('invalid JSON'), { status: 400 }); }
}

// A JSON request body that is not an object (null, a number, an array) is a client error,
// not a TypeError deep in a route.
function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Wraps a body reader so a body that parses to anything but an object is refused with a 400
// before a route dereferences it (#786). An empty body still reads as {}.
function requireJsonObject(read) {
  return async (...args) => {
    const body = await read(...args);
    if (!isJsonObject(body)) throw Object.assign(new TypeError('request body must be a JSON object'), { status: 400 });
    return body;
  };
}

// The last-resort answer when a request handler rejected outside its own error handling (#781).
// A client gets an HTTP answer (errorResponse: a deliberate 4xx keeps its status, anything else
// is a generic 500) instead of a reset socket. A response already under way is still reset,
// because its client must see it as cut short rather than complete. Never throws.
function answerUnhandled(res, err, log = console.error) {
  try {
    if (!res || res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    const failure = errorResponse(err);
    if (failure.status >= 500) { try { log('[request] unhandled error:', err); } catch { /* logging must not stop the answer */ } }
    json(res, failure.status, failure.body);
  } catch {
    try { res.destroy(); } catch { /* nothing left to do */ }
  }
}

// The request URL, or null when it cannot be parsed (a request target such as `//[` or a
// malformed Host header). A client error, answered 400 without logging a stack per request.
function parseRequestUrl(req, base = 'http://localhost') {
  try { return new URL(req.url, base); } catch { return null; }
}

function badRequestUrl(res) {
  return json(res, 400, { error: 'invalid URL' });
}

// What a failed request tells the client. Only errors that carry a 4xx status were raised
// on purpose for the client; anything else is an internal fault whose message may leak
// paths or internals, so the client gets a generic text and the caller logs the real one.
function errorResponse(err) {
  const status = Number(err && err.status);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return { status, body: { error: String((err && err.message) || 'Request failed') } };
  }
  return { status: Number.isInteger(status) && status >= 500 && status < 600 ? status : 500, body: { error: 'Internal error' } };
}

function authResult(res, result) {
  return json(res, result.status || 200, result.body ?? result);
}

// #812: one URL path segment, percent-decoded; null when the escape is malformed, so a route answers
// 400 instead of letting decodeURIComponent's URIError become a 500.
function decodePathPart(raw) {
  try { return decodeURIComponent(raw); } catch { return null; }
}

module.exports = { json, unauthorized, decodePathPart, fetchJson, readBody, readJson, authResult, isJsonObject, requireJsonObject, answerUnhandled, parseRequestUrl, badRequestUrl, errorResponse, DEFAULT_MAX_RESPONSE_BYTES, readCappedText, readCappedJson, readCappedBuffer, discardBody };
