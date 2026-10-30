'use strict';
// sbstndalton/noevia#2191 round 4 (group rust-conversation-import): the Rust front answers Settings →
// Data → Import conversations (noevia-rs crates/server-projects import.rs, served by
// bins/noevia-server project_routes.rs):
//
//   POST /api/import/conversations   planImport, the recovery journal (conversation-imports/<sha256>/),
//                                    projects matched or created, transcripts published through its
//                                    own store, lists merged, the audit row; answer for answer
//
// The journal is the one this process wrote (same files, same shape), so an import left half done by
// an older core is finished by the front's next import. A direct Node POST is refused before
// authentication, whoever asks, so a stale route table cannot make two processes answer. Every other
// method keeps routes/import.cjs's 405.
//
// METHOD path-pattern in routes.toml's spelling, for noevia's deploy/tools/assemble-release.sh.
const OWNED_ROUTES = Object.freeze(new Set([
  'POST /api/import/conversations',
]));
const ROUTE = '/api/import/conversations';
const ROUTE_REFUSAL = Object.freeze({ error: 'Importing conversations is owned by the Rust front.', code: 'RUST_CONVERSATION_IMPORT_OWNED' });

/** True for POST /api/import/conversations (WHATWG pathname, as routes/import.cjs matched it). */
const owned = (method, pathname) => method === 'POST' && pathname === ROUTE;

/** Runs before authentication and the workspace load (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'POST') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
