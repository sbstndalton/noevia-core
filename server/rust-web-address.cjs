'use strict';
// The Rust front owns exactly these read-only web-address GETs (#1071). Node retains POST
// address changes/removal and every other method. A direct Node request cannot answer a GET.
const WEB_ADDRESS_READ_OWNER = 'noevia-web-address-read-rust/1';
const OWNED_GET_PATHS = Object.freeze(['/api/instance', '/.well-known/webauthn', '/api/admin/web-address']);
const ROUTE_REFUSAL = Object.freeze({ error: 'Web address reads are owned by the Rust front.', code: 'RUST_WEB_ADDRESS_READ_OWNED' });

function ownedRead(method, pathname) {
  return method === 'GET' && OWNED_GET_PATHS.includes(pathname);
}
function refuseOwnedRead(req, res, pathname, json) {
  if (!ownedRead(req.method, pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}
module.exports = { WEB_ADDRESS_READ_OWNER, OWNED_GET_PATHS, ROUTE_REFUSAL, ownedRead, refuseOwnedRead };
