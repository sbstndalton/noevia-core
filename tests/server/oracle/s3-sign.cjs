'use strict';

// TEST ORACLE (#1071): never required by production code (server/oracle-isolation.test.cjs
// enforces that). The JS reference SigV4 signer and region rule, kept only so
// tools/gen-s3-sign-fixtures.cjs can regenerate tests/fixtures/s3-sign.v1.json and the differential
// tests can compare it with dav-parse.wasm (sbstndalton/noevia-rs crates/s3-sign). Production signs
// with the Rust module alone (server/s3-sign.cjs, server/s3-region.cjs).
// Moved here unchanged from server/s3-sign.cjs and server/s3-region.cjs normalizeS3RegionJs.

const crypto = require('node:crypto');
const { S3_REGION_RE, DEFAULT_S3_REGION } = require('../../../server/s3-region.cjs');

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

/** The JS reference signer . */
function signS3RequestJs(method, url, payload, accessKey, secretKey, opts = {}) {
  return signS3Parts(method, url, payload, accessKey, secretKey, opts).headers;
}

function algorithmHeader() {
  return 'AWS4-HMAC-SHA256';
}

/** The JS reference region rule. */
function normalizeS3RegionJs(value) {
  const region = String(value || '').trim().toLowerCase();
  return S3_REGION_RE.test(region) ? region : DEFAULT_S3_REGION;
}

module.exports = { signS3RequestJs, signS3Parts, normalizeS3RegionJs, sha256Hex, uriEncode, canonicalUri };
