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
// Policy leaves (POLICY_LEAVES_IMPL, retired in #1071: Rust is always used): mode() and set()'s
// checks are decided in noevia-rs's policy-leaves crate (in dav-parse.wasm); the table stays here.
// Fails closed: a fault in mode() answers `block` (never weaker than the old JS: the port also
// reads an unknown stored mode as `block`), and a fault in set() refuses the change before
// anything is written. The JS reference is tests/server/oracle/tool-policy.cjs (tests only).
const fail = (message) => Object.assign(Error(message), { status: 400, publicMessage: message });

const SET_MESSAGES = {
  mode: 'Choose allow, ask or block.',
  empty: 'Choose a tool.',
  write: 'Writes always ask first, so they cannot be set to Always allow.',
};
let warned = '';
function warnFault(err) {
  const reason = String(err?.reason || 'unexpected');
  if (warned !== reason) { warned = reason; console.warn(`[tool-policy] the Rust port failed (${reason}); failing closed`); }
}

function createToolPolicy({ db, audit = () => {}, wasmLoader = () => require('./dav-parse-wasm.cjs') }) {
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

  function set(userId, tools, value, isWrite) {
    const list = [].concat(tools);
    // Write flags matter only for allow, so isWrite runs only then, as it always has.
    const writes = value === 'allow' ? list.map((t) => !!isWrite(t)) : list.map(() => false);
    let r;
    try { r = wasm().toolPolicySet(value, writes); } catch (err) {
      warnFault(err);
      throw Object.assign(Error('The tool permission could not be checked.'), { status: 500 });
    }
    // A refusal with a reason this file has no message for (the loader only passes known ones, but a
    // future port could add one) is a fault, not a 400 with no message (#1109): fail closed.
    if (r?.ok === false && Object.hasOwn(SET_MESSAGES, r.reason)) throw fail(SET_MESSAGES[r.reason]);
    if (r?.ok !== true) {
      warnFault({ reason: 'reply' });
      throw Object.assign(Error('The tool permission could not be checked.'), { status: 500 });
    }
    const put = db.prepare(`INSERT INTO tool_policies VALUES(?,?,?,?) ON CONFLICT(user_id, tool) DO UPDATE SET mode=excluded.mode, updated_at=excluded.updated_at`);
    const now = Date.now();
    db.transaction(() => { for (const t of list) put.run(userId, t, value, now); })();
    audit('tool.policy', userId, { tools: list, mode: value });
  }

  return { mode, set, stored };
}

module.exports = { createToolPolicy };
