'use strict';
// sbstndalton/noevia#2191 close-out: the Rust front answers GET /api/workspace (noevia-rs
// bins/noevia-server project_routes.rs, crates/server-projects workspace.rs, capability
// rust-workspace): the account's projects (sources as metadata, chats sanitized, internal projects
// left out) and free chats, after the delete-old-chats sweep (hourly at most) and the removal of the
// attachments projects of chats deleted before #788 (only provably deleted ones, 10 per list), which
// this route used to run and now run there. Nothing in the list is Node-live: the lists are the front's
// files, and whether a source's text file is gone (textMissing, #1815/#1818) is the front's own scan.
//
// Node answered the path for every method; only the GET is the front's, refused here before
// authentication. Node's workspace is still loaded per request for the routes that remain.
const ROUTE_REFUSAL = Object.freeze({ error: 'The workspace list is owned by the Rust front.', code: 'RUST_WORKSPACE_OWNED' });

const owned = (method, pathname) => method === 'GET' && pathname === '/api/workspace';

function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { ROUTE_REFUSAL, owned, refuseOwned };
