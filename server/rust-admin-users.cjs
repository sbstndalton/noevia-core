'use strict';
// sbstndalton/noevia#2190, #2191 round 9 (capability rust-admin-users): the Rust front deletes an account
// (noevia-rs bins/noevia-server admin_user_routes.rs, crates/server-account delete.rs):
//
//   DELETE /api/admin/users/{id}   the typed username, the last-administrator rule, the account's rows
//                                  (sessions, passkeys, devices, features, storage connection, tool policies,
//                                  Diary connectors by cascade), its folder, its Google Drive, MCP and ChatGPT
//                                  credentials and its Diary tenant
//
// It was the one account route this process kept, under rust-auth.cjs `exempt()`, because its cleanup spanned
// Node's own stores (the workspace store, the Drive session cache). Those follow the auth database first and the
// folder second: workspaceStore.isRemoved asks `userExists` (kept about a second, because rag asks once per
// chunk; "gone" is latched), so rag stops indexing and makes no users/<id>/rag folder for a deleted account, a
// workspace held for it is revoked at once, and none is made for a user the database no longer has (workspace.cjs
// `userExists`); a workspace held when the folder alone disappears is revoked by the folder check (workspace.cjs
// `revoked`). Core's Drive session cache is keyed to the broker's state file, which the front rewrites when it
// forgets the account (gdrive-broker.cjs).
//
// A direct Node request is refused before authentication, whoever asks, so a stale route table cannot make two
// processes answer: this process no longer has a way to delete an account (auth.cjs `deleteUser` is gone) and
// rust-auth.cjs refuses any Node delete of `users`. Every other method of the path falls through as before.
//
// METHOD path-pattern in routes.toml's spelling, for noevia's deploy/tools/assemble-release.sh.
const OWNED_ROUTES = Object.freeze(new Set([
  'DELETE /api/admin/users/{id}',
]));
// routes/auth.cjs's own matcher (one segment for the id), as it was.
const ONE_USER = /^\/api\/admin\/users\/[^/]+$/;
const ROUTE_REFUSAL = Object.freeze({ error: 'Deleting an account is owned by the Rust front.', code: 'RUST_ADMIN_USERS_OWNED' });

/** True for DELETE /api/admin/users/{id} (WHATWG pathname, as Node's matcher). */
const owned = (method, pathname) => method === 'DELETE' && ONE_USER.test(String(pathname));

/** Runs before authentication and the workspace load (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'DELETE') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
