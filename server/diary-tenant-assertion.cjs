'use strict';
// ── Per-request Diary tenant assertion (spec-service-boundaries §6.2 M2) ─────
// The shared DIARY_AUTH_TOKEN says "this is the web server"; it does not say
// which user a request acts for. With DIARY_TENANT_KEY set, web signs every
// tenant-scoped Diary request with an HMAC that binds the tenant id, a
// timestamp, a single-use nonce, the method and path, and the exact tenant
// headers (storage descriptor, legacy-owner and blocked markers). The sidecar
// (services/diary/agent/tenant_assertion.py) verifies the same canonical string.
//
// Header: X-Cowork-Tenant-Assertion: v2.<unix seconds>.<nonce hex>.<base64url sig>
// Canonical string (newline-joined):
//   "cowork-diary-tenant-v2", user id (lower case), ts, nonce, METHOD, path,
//   "query=" + sha256(raw query, no "?"), "body=" + (sha256(body bytes) | "stream"),
//   sha256(X-Cowork-Storage or ""), X-Cowork-Legacy-Owner or "",
//   X-Cowork-Storage-Blocked or ""
//
// Path invariant: both sides sign the percent-ENCODED path as it goes on the
// wire (URL.pathname here, ASGI raw_path in the sidecar), never a decoded form.
// Body: a JSON (or Content-Type-less) request signs sha256 of the exact bytes
// fetch sends, so pass the same buffered string/Buffer to diaryHeaders() and
// to fetch. Other media types (ZIP import) sign "stream"; their bodies are not
// covered (docs/spec-managed-diary.md, threat model). v1 was never deployed and
// is not accepted.
//
// storageSecretRef() names a remote storage credential without carrying it
// (#292): the sidecar keys its cached tenant state by this reference and only
// needs the secret itself when it has no state for it (HTTP 428, see diary.cjs).

const crypto = require('node:crypto');

const ASSERTION_HEADER = 'X-Cowork-Tenant-Assertion';
const LABEL = 'cowork-diary-tenant-v2';
const STREAM = 'stream';

const sha256 = (data) => crypto.createHash('sha256').update(data ?? '').digest('hex');

/** True when the sidecar hashes this Content-Type's body (JSON or none); otherwise the body signs STREAM. */
function bodyIsHashed(contentType) {
  const media = String(contentType || '').split(';')[0].trim().toLowerCase();
  return media === '' || media === 'application/json';
}

/** Encoded wire path and raw query (without "?") of the URL fetch will request. */
function targetOf(url) {
  try { const u = new URL(url, 'http://diary.invalid'); return { path: u.pathname, query: u.search.replace(/^\?/, '') }; } catch { return { path: '/', query: '' }; }
}
const pathOf = (url) => targetOf(url).path;

function canonical({ userId, ts, nonce, method, path, queryHash = sha256(''), bodyHash = sha256(''), storage = '', legacyOwner = '', blocked = '' }) {
  return [LABEL, String(userId).toLowerCase(), String(ts), nonce, String(method || 'GET').toUpperCase(), path,
    `query=${queryHash}`, `body=${bodyHash}`, sha256(String(storage)), legacyOwner, blocked].join('\n');
}

/**
 * Sign one request. `headers` are the tenant headers already on the request
 * (their Content-Type decides hashed vs "stream" body); `body` is the exact
 * string or Buffer that will be sent (undefined for none).
 * @param {{ key:string, method:string, url:string, headers:Record<string,string>, body?:string|Buffer, now?:number, nonce?:string }} args
 * @returns {string} the header value
 */
function signTenantAssertion({ key, method, url, headers, body, now = Date.now(), nonce = crypto.randomBytes(16).toString('hex') }) {
  const ts = Math.floor(now / 1000);
  const { path, query } = targetOf(url);
  const bodyHash = bodyIsHashed(headers['Content-Type']) ? sha256(body === undefined || body === null ? '' : body) : STREAM;
  const message = canonical({
    userId: headers['X-Cowork-User-ID'], ts, nonce, method, path, queryHash: sha256(query), bodyHash,
    storage: headers['X-Cowork-Storage'] || '', legacyOwner: headers['X-Cowork-Legacy-Owner'] || '', blocked: headers['X-Cowork-Storage-Blocked'] || '',
  });
  const sig = crypto.createHmac('sha256', key).update(message).digest('base64url');
  return `v2.${ts}.${nonce}.${sig}`;
}

/** A stable, non-reversible name for a storage credential, scoped to one tenant. */
function storageSecretRef(key, userId, secret) {
  return crypto.createHmac('sha256', key).update(`${LABEL}:storage-secret\n${String(userId).toLowerCase()}\n${secret}`).digest('hex').slice(0, 32);
}

module.exports = { ASSERTION_HEADER, STREAM, signTenantAssertion, storageSecretRef, canonical, pathOf, targetOf, bodyIsHashed };
