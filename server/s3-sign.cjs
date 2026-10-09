'use strict';

// Minimal AWS SigV4 request signer for S3-compatible object storage.
//
// Used by the storage-connection test probe in index.cjs so a user can verify
// their S3 credentials before saving them. The diary sidecar has its own
// signer (services/diary/agent/s3_storage.py) for actual corpus traffic; the
// two must agree on the canonical request format. The signing itself is Rust (below); this
// module adds no dependencies, matching the server's stdlib discipline.

const davParseWasm = require('./dav-parse-wasm.cjs');

// The Rust port (noevia-rs crates/s3-sign inside dav-parse.wasm, server/dav-parse-wasm.cjs s3Sign)
// signs, always (since #1071; it was S3_SIGN_IMPL=wasm). It fails closed: a module that is missing,
// fails its pin or answers oddly throws, never falls back to JS. Startup verifies the module
// (dav-parse-wasm.cjs verifyAtStartup) and refuses to run without it. The JS reference signer is a
// test oracle only (tests/server/oracle/s3-sign.cjs).
const SIGN_FAILURE = 'storage request could not be signed';

/** The Rust port signs. Errors carry a reason only, never an input. */
function signS3RequestWasm(method, url, payload, accessKey, secretKey, opts = {}) {
  try {
    return davParseWasm.s3Sign(method, url, payload, accessKey, secretKey, opts);
  } catch (err) {
    const reason = err instanceof davParseWasm.DavParseError ? err.reason : 'unexpected';
    console.warn(`[storage] s3-sign failed (${reason})`);
    throw Object.assign(new Error(SIGN_FAILURE), { code: 's3_sign_failed', reason, status: 502 });
  }
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
  return signS3RequestWasm(method, url, payload, accessKey, secretKey, opts);
}

module.exports = { signS3Request, signS3RequestWasm, SIGN_FAILURE };
