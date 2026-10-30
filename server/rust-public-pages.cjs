'use strict';
// sbstndalton/noevia#2190: the Rust front answers the public pages (noevia-rs bins/noevia-server
// public_pages.rs): GET and HEAD of /about and /privacy (the home page and privacy policy Google
// requires for the app registration behind "Connect Google Drive"), and every method of /device,
// the native-app approval page (a JSON 404 while features.nativeClientAuth is off, the web
// bundle's page when on). A direct Node request for one of them is refused before authentication,
// whoever asks, so a stale route table cannot make two processes answer. The other methods of
// /about and /privacy run Node's ordinary chain, as before.
//
// The list is exactly noevia-rs contracts/http/routes.toml's owner = "rust" pages. Node matched
// the exact pathnames ('/device/' was the approval page too), and so does this.
const PAGE_PATHS = Object.freeze(['/about', '/privacy']);
const DEVICE_PATHS = Object.freeze(['/device', '/device/']);
const ROUTE_REFUSAL = Object.freeze({ error: 'The public pages are owned by the Rust front.', code: 'RUST_PUBLIC_PAGES_OWNED' });

const owned = (method, pathname) => DEVICE_PATHS.includes(pathname) || ((method === 'GET' || method === 'HEAD') && PAGE_PATHS.includes(pathname));

/**
 * Runs before authentication and the workspace load (index.cjs handleRequestInner).
 * `parseRequestUrl` is http.cjs's; an unparseable target falls through to the ordinary 400.
 */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method || 'GET', url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { PAGE_PATHS, DEVICE_PATHS, ROUTE_REFUSAL, owned, refuseOwned };
