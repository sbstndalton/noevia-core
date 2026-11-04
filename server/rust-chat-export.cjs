'use strict';
// GET /api/chats/{chatId}/export (#1471) is the Rust front's (noevia-rs bins/noevia-server project_routes.rs,
// crates/server-export markdown.rs `render`, capability rust-chat-export): one chat of the caller's own lists as a
// Markdown file, from the same writer as the conversation export, with Node's headers, file name and 400/404 texts.
// Nothing in it is Node-live: the lists, transcripts and tombstones are the front's files.
//
// Node answered only the GET (other methods fell through to its 404); that GET is refused here before
// authentication, whoever asks, so a stale route table cannot make two processes answer.
//
// The route in routes.toml's spelling, for noevia's deploy/tools/assemble-release.sh.
const OWNED_ROUTES = Object.freeze(new Set(['GET /api/chats/{chatId}/export']));
const ROUTE_REFUSAL = Object.freeze({ error: 'The chat download is owned by the Rust front.', code: 'RUST_CHAT_EXPORT_OWNED' });
// routes/chat-lists.cjs's old matcher, `^\/api\/chats\/([^/]+)\/export$` on the WHATWG pathname.
const EXPORT = /^\/api\/chats\/[^/]+\/export$/;

const owned = (method, pathname) => method === 'GET' && EXPORT.test(String(pathname));

/** Runs before authentication and the workspace load (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
