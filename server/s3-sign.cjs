'use strict';

// Minimal AWS SigV4 request signer for S3-compatible object storage.
//
// Used by the storage-connection test probe in index.cjs so a user can verify
// their S3 credentials before saving them. The diary sidecar has its own
// signer (services/diary/agent/s3_storage.py) for actual corpus traffic; the
// two must agree on the canonical request format. Deliberately dependency-free
// (node:crypto only), matching the server's stdlib discipline.

const crypto = require('node:crypto');

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
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  // SigV4 string-to-sign: algorithm, timestamp, scope, hashed canonical request.
  const stringToSign = [algorithmHeader(), amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  let key = hmac(Buffer.from(`AWS4${secretKey}`), dateStamp);
  key = hmac(key, region);
  key = hmac(key, 's3');
  key = hmac(key, 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');

  const out = { ...headers, Authorization: `${algorithmHeader()} Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
  return out;
}

function algorithmHeader() {
  return 'AWS4-HMAC-SHA256';
}

module.exports = { signS3Request, sha256Hex, uriEncode };
