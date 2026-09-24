'use strict';

// SigV4 signs the region into its credential scope; AWS rejects a us-east-1
// scope for a bucket elsewhere (AuthorizationHeaderMalformed). MinIO/Garage
// accept any region, so the default stays us-east-1.
const DEFAULT_S3_REGION = 'us-east-1';
const S3_REGION_RE = /^[a-z0-9-]{1,32}$/;

function normalizeS3Region(value) {
  const region = String(value || '').trim().toLowerCase();
  return S3_REGION_RE.test(region) ? region : DEFAULT_S3_REGION;
}

module.exports = { DEFAULT_S3_REGION, S3_REGION_RE, normalizeS3Region };
