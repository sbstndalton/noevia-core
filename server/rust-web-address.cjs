'use strict';
// The Rust front owns the three GETs and both address POST writers (#1071).
// A direct Node request is refused before public/auth route dispatch.
const WEB_ADDRESS_READ_OWNER = 'noevia-web-address-read-rust/1';
const WEB_ADDRESS_WRITE_OWNER = 'noevia-web-address-write-rust/1';
const OWNED_GET_PATHS = Object.freeze(['/api/instance', '/.well-known/webauthn', '/api/admin/web-address']);
const OWNED_POST_PATHS = Object.freeze(['/api/admin/web-address', '/api/admin/web-address/remove']);
const WRITE_REFUSAL = Object.freeze({ error: 'Web address changes are owned by the Rust front.', code: 'RUST_WEB_ADDRESS_WRITE_OWNED' });
const ROUTE_REFUSAL = Object.freeze({ error: 'Web address reads are owned by the Rust front.', code: 'RUST_WEB_ADDRESS_READ_OWNED' });

function ownedRead(method, pathname) {
  return method === 'GET' && OWNED_GET_PATHS.includes(pathname);
}
function refuseOwnedRead(req, res, pathname, json) {
  if (!ownedRead(req.method, pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}
function ownedWrite(method, pathname) {
  return method === 'POST' && OWNED_POST_PATHS.includes(pathname);
}
function refuseOwnedWrite(req, res, pathname, json) {
  if (!ownedWrite(req.method, pathname)) return false;
  json(res, 503, WRITE_REFUSAL);
  return true;
}
function refuseOwned(req, res, pathname, json) {
  return refuseOwnedRead(req, res, pathname, json) || refuseOwnedWrite(req, res, pathname, json);
}
module.exports = { WEB_ADDRESS_READ_OWNER, WEB_ADDRESS_WRITE_OWNER, OWNED_GET_PATHS, OWNED_POST_PATHS, ROUTE_REFUSAL, WRITE_REFUSAL, ownedRead, ownedWrite, refuseOwnedRead, refuseOwnedWrite, refuseOwned };
