'use strict';

// SigV4 signs the region into its credential scope; AWS rejects a us-east-1
// scope for a bucket elsewhere (AuthorizationHeaderMalformed). MinIO/Garage
// accept any region, so the default stays us-east-1.
const DEFAULT_S3_REGION = 'us-east-1';
const S3_REGION_RE = /^[a-z0-9-]{1,32}$/;

/** The JS reference rule. */
function normalizeS3RegionJs(value) {
  const region = String(value || '').trim().toLowerCase();
  return S3_REGION_RE.test(region) ? region : DEFAULT_S3_REGION;
}

/** normalizeS3RegionJs or its Rust port (noevia-rs crates/s3-sign), by S3_SIGN_IMPL (default js).
 *  The wasm path fails closed: a module failure throws, it never falls back to js. */
function normalizeS3Region(value) {
  // Required lazily: s3-sign.cjs pulls in the wasm loader.
  const { s3SignImpl } = require('./s3-sign.cjs');
  if (s3SignImpl() !== 'wasm') return normalizeS3RegionJs(value);
  const davParseWasm = require('./dav-parse-wasm.cjs');
  try {
    return davParseWasm.s3Region(value);
  } catch (err) {
    const reason = err instanceof davParseWasm.DavParseError ? err.reason : 'unexpected';
    console.warn(`[storage] s3-region failed (${reason})`);
    throw Object.assign(new Error('storage region could not be checked'), { code: 's3_sign_failed', reason, status: 502 });
  }
}

module.exports = { DEFAULT_S3_REGION, S3_REGION_RE, normalizeS3Region, normalizeS3RegionJs };
