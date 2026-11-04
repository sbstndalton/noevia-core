'use strict';
// GET /api/chats/search?q= (#1450) is the Rust front's (noevia-rs bins/noevia-server project_routes.rs,
// crates/server-projects workspace.rs `search`, capability rust-chat-search): the ids of the caller's own chats
// whose user or assistant text holds the query, free chats first, then each non-internal project, tombstoned chats
// skipped, at most 500 chats read and 100 ids returned. Nothing in it is Node-live: the lists, transcripts and
// tombstones are the front's files.
//
// Node answered only the GET of the exact path; it is refused here before authentication, whoever asks, so a stale
// route table cannot make two processes answer. Other methods and other spellings keep Node's 404.
//
// The route in routes.toml's spelling, for noevia's deploy/tools/assemble-release.sh.
const OWNED_ROUTES = Object.freeze(new Set(['GET /api/chats/search']));
const ROUTE_REFUSAL = Object.freeze({ error: 'Chat search is owned by the Rust front.', code: 'RUST_CHAT_SEARCH_OWNED' });

const owned = (method, pathname) => method === 'GET' && pathname === '/api/chats/search';

/** Runs before authentication and the workspace load (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
