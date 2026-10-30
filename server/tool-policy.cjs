'use strict';
// Per-account, per-tool permission: allow, ask or block (Settings → Connectors).
//
//   allow  a read runs without asking.
//   ask    the call waits for the approval card (Allow once / Allow for this chat / Decline).
//   block  the tool is not offered to the model, and a call to it is refused.
//
// Writes can never be `allow`: every write shows a person its arguments first, which is the
// rule the approval gate exists for (agent brief: never add a global "never ask"). A stored
// `allow` on a tool that has since become a write therefore reads back as `ask`.
//
// Policy leaves (POLICY_LEAVES_IMPL, retired in #1071: Rust is always used): mode() is decided in
// noevia-rs's policy-leaves crate (in dav-parse.wasm); the table is created here (Node is the
// migrator) and read here on every call, but since sbstndalton/noevia#2190 round 7 the Rust front is
// its only WRITER (Settings -> Connectors, bins/noevia-server connector_routes.rs; Node's database
// guard refuses every write, rust-auth.cjs FRONT_TABLES). The Nextcloud permissions, which need the
// live MCP tools, are written by the front itself (rust-connectors.cjs: PUT /api/connectors/nextcloud/policy).
// Fails closed: a fault in mode() answers `block` (never weaker than the old JS: the port also
// reads an unknown stored mode as `block`). The JS reference is tests/server/oracle/tool-policy.cjs
// (tests only).
let warned = '';
function warnFault(err) {
  const reason = String(err?.reason || 'unexpected');
  if (warned !== reason) { warned = reason; console.warn(`[tool-policy] the Rust port failed (${reason}); failing closed`); }
}

function createToolPolicy({ db, wasmLoader = () => require('./dav-parse-wasm.cjs') }) {
  const wasm = () => wasmLoader();
  db.exec(`CREATE TABLE IF NOT EXISTS tool_policies(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tool TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('allow','ask','block')), updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, tool));`);
  const stored = (userId) => Object.fromEntries(db.prepare('SELECT tool, mode FROM tool_policies WHERE user_id=?').all(userId).map((r) => [r.tool, r.mode]));

  /** The mode that applies to one call. */
  function mode(userId, tool, isWrite) {
    const m = userId ? db.prepare('SELECT mode FROM tool_policies WHERE user_id=? AND tool=?').get(userId, tool)?.mode : null;
    try { return wasm().toolPolicyMode(m, !!isWrite); } catch (err) {
      warnFault(err);
      return 'block';
    }
  }

  return { mode, stored };
}

module.exports = { createToolPolicy };
