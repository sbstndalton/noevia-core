'use strict';

// SigV4 signs the region into its credential scope; AWS rejects a us-east-1
// scope for a bucket elsewhere (AuthorizationHeaderMalformed). MinIO/Garage
// accept any region, so the default stays us-east-1.
const DEFAULT_S3_REGION = 'us-east-1';
const S3_REGION_RE = /^[a-z0-9-]{1,32}$/;

/** The Rust port's region rule (noevia-rs crates/s3-sign), always (since #1071). It fails closed: a
 *  module failure throws, it never falls back to JS (the JS rule is tests/server/oracle/s3-sign.cjs). */
function normalizeS3Region(value) {
  // Required lazily: the wasm loader is heavy and this module is also loaded for its constants.
  const davParseWasm = require('./dav-parse-wasm.cjs');
  try {
    return davParseWasm.s3Region(value);
  } catch (err) {
    const reason = err instanceof davParseWasm.DavParseError ? err.reason : 'unexpected';
    console.warn(`[storage] s3-region failed (${reason})`);
    throw Object.assign(new Error('storage region could not be checked'), { code: 's3_sign_failed', reason, status: 502 });
  }
}

module.exports = { DEFAULT_S3_REGION, S3_REGION_RE, normalizeS3Region };
