'use strict';
// The HTTP helpers every route module is handed: one JSON reply shape, the 401 with its
// challenge, a JSON fetch with a timeout that also honours the caller's abort signal and
// never follows a redirect, a bounded body read, and the { status, body } unwrapping for
// results that auth.cjs returns. fetch is the global, resolved per call, because tests and
// QA swap it at runtime.

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
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

module.exports = { json, unauthorized, fetchJson, readBody, readJson, authResult, isJsonObject, errorResponse, DEFAULT_MAX_RESPONSE_BYTES };
