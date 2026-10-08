'use strict';

// Minimal AWS SigV4 request signer for S3-compatible object storage.
//
// Used by the storage-connection test probe in index.cjs so a user can verify
// their S3 credentials before saving them. The diary sidecar has its own
// signer (services/diary/agent/s3_storage.py) for actual corpus traffic; the
// two must agree on the canonical request format. Deliberately dependency-free
// (node:crypto only), matching the server's stdlib discipline.

const crypto = require('node:crypto');
const davParseWasm = require('./dav-parse-wasm.cjs');

// S3_SIGN_IMPL=js|wasm (default js; anything else is js with one warning): wasm signs through
// noevia-rs crates/s3-sign inside dav-parse.wasm (server/dav-parse-wasm.cjs s3Sign). It fails
// closed: a module that is missing, fails its pin or answers oddly throws, never falls back to js.
// When set to wasm, startup verifies the module (dav-parse-wasm.cjs IMPL_FLAGS) and refuses to run.
const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';
const SIGN_FAILURE = 'storage request could not be signed';

/** S3_SIGN_IMPL, read per call so a test (or an owner flip plus restart) takes effect. */
function s3SignImpl(env = process.env) {
  const raw = env.S3_SIGN_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const value = String(raw).trim().toLowerCase();
  if (IMPLS.has(value)) return value;
  if (warnedImpl !== value) {
    warnedImpl = value;
    console.warn(`[storage] S3_SIGN_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}

/** signS3RequestJs through the Rust port. Errors carry a reason only, never an input. */
function signS3RequestWasm(method, url, payload, accessKey, secretKey, opts = {}) {
  try {
    return davParseWasm.s3Sign(method, url, payload, accessKey, secretKey, opts);
  } catch (err) {
    const reason = err instanceof davParseWasm.DavParseError ? err.reason : 'unexpected';
    console.warn(`[storage] s3-sign failed (${reason})`);
    throw Object.assign(new Error(SIGN_FAILURE), { code: 's3_sign_failed', reason, status: 502 });
  }
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function uriEncode(value) {
  // AWS canonical query/URI encoding: RFC3986 unreserved set.
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * SigV4 canonical URI: every path segment URI-encoded once (RFC3986 unreserved set, so
 * ! ' ( ) * are escaped too), matching `_path` in services/diary/agent/s3_storage.py.
 * URL.pathname is already percent-encoded (and leaves ! ' ( ) * alone), so decode first.
 */
function canonicalUri(pathname) {
  return String(pathname || '/').split('/').map((seg) => {
    let raw = seg;
    try { raw = decodeURIComponent(seg); } catch { /* a stray % stays literal */ }
    return uriEncode(raw);
  }).join('/') || '/';
}

/**
 * The JS reference SigV4 computation, every intermediate exposed (the shared fixture table for the
 * Rust port, noevia-rs crates/s3-sign, is generated from this).
 * @returns {{ canonicalRequest: string, stringToSign: string, signature: string, headers: object }}
 */
function signS3Parts(method, url, payload, accessKey, secretKey, opts = {}) {
  const region = opts.region || 'us-east-1';
  const payloadHash = sha256Hex(Buffer.isBuffer(payload) ? payload : Buffer.from(payload || ''));
  const amzDate = opts.amzDate || new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (opts.sessionToken) headers['x-amz-security-token'] = opts.sessionToken;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${headers[k].trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const queryPairs = [];
  for (const [k, v] of url.searchParams.entries()) queryPairs.push([k, v]);
  queryPairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const canonicalQuery = queryPairs.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');

  const canonicalRequest = [
    method,
    canonicalUri(url.pathname),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  // SigV4 string-to-sign: algorithm, timestamp, scope, hashed canonical request.
  const stringToSign = [algorithmHeader(), amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  // Derive the signing key; every intermediate Buffer is zeroed once used.
  let key = Buffer.from(`AWS4${secretKey}`);
  for (const part of [dateStamp, region, 's3', 'aws4_request']) {
    const next = hmac(key, part);
    key.fill(0);
    key = next;
  }
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');
  key.fill(0);

  const out = { ...headers, Authorization: `${algorithmHeader()} Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
  return { canonicalRequest, stringToSign, signature, headers: out };
}

/** The JS reference signer (S3_SIGN_IMPL=js, the default). */
function signS3RequestJs(method, url, payload, accessKey, secretKey, opts = {}) {
  return signS3Parts(method, url, payload, accessKey, secretKey, opts).headers;
}

/**
 * Sign an S3 request (SigV4, path-style).
 * @param {string} method HTTP verb
 * @param {URL} url full target URL (path-style: /bucket[/key][?query])
 * @param {Buffer|string} payload request body
 * @param {string} accessKey
 * @param {string} secretKey
 * @param {object} [opts] { region, sessionToken, amzDate }
 * @returns {object} headers to send (Authorization, x-amz-*)
 */
function signS3Request(method, url, payload, accessKey, secretKey, opts = {}) {
  return s3SignImpl() === 'wasm'
    ? signS3RequestWasm(method, url, payload, accessKey, secretKey, opts)
    : signS3RequestJs(method, url, payload, accessKey, secretKey, opts);
}

function algorithmHeader() {
  return 'AWS4-HMAC-SHA256';
}

module.exports = { signS3Request, signS3RequestJs, signS3RequestWasm, signS3Parts, s3SignImpl, sha256Hex, uriEncode, canonicalUri, SIGN_FAILURE };
