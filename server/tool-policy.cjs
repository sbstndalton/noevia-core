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
// POLICY_LEAVES_IMPL=js|wasm (default js; auth-tokens.cjs reads it), read on every call: wasm
// decides mode() and set()'s checks in noevia-rs's policy-leaves crate (in dav-parse.wasm); the
// table stays here. Fails closed: the flag is in dav-parse-wasm.cjs IMPL_FLAGS; a fault in mode()
// answers `block` (never weaker than the JS: the port also reads an unknown stored mode as
// `block`), and a fault in set() refuses the change before anything is written.
const MODES = new Set(['allow', 'ask', 'block']);
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

/** `impl`: 'js' or 'wasm' to pin one (the fixture generator pins js); default POLICY_LEAVES_IMPL. */
function createToolPolicy({ db, audit = () => {}, impl, wasmLoader = () => require('./dav-parse-wasm.cjs') }) {
  const useWasm = () => (impl || require('./auth-tokens.cjs').policyLeavesImpl()) === 'wasm';
  const wasm = () => wasmLoader();
  db.exec(`CREATE TABLE IF NOT EXISTS tool_policies(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tool TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('allow','ask','block')), updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, tool));`);
  const stored = (userId) => Object.fromEntries(db.prepare('SELECT tool, mode FROM tool_policies WHERE user_id=?').all(userId).map((r) => [r.tool, r.mode]));

  /** The mode that applies to one call. */
  function mode(userId, tool, isWrite) {
    const m = userId ? db.prepare('SELECT mode FROM tool_policies WHERE user_id=? AND tool=?').get(userId, tool)?.mode : null;
    if (useWasm()) {
      try { return wasm().toolPolicyMode(m, !!isWrite); } catch (err) {
        warnFault(err);
        return 'block';
      }
    }
    if (m === 'block') return 'block';
    if (isWrite) return 'ask';
    return m || 'allow';
  }

  function set(userId, tools, value, isWrite) {
    const list = [].concat(tools);
    if (useWasm()) {
      let r;
      // Write flags matter only for allow, so isWrite runs only then, as in the JS.
      const writes = value === 'allow' ? list.map((t) => !!isWrite(t)) : list.map(() => false);
      try { r = wasm().toolPolicySet(value, writes); } catch (err) {
        warnFault(err);
        throw Object.assign(Error('The tool permission could not be checked.'), { status: 500 });
      }
      if (!r.ok) throw fail(SET_MESSAGES[r.reason]);
    } else {
      if (!MODES.has(value)) throw fail('Choose allow, ask or block.');
      if (!list.length) throw fail('Choose a tool.');
      if (value === 'allow' && list.some((t) => isWrite(t))) throw fail('Writes always ask first, so they cannot be set to Always allow.');
    }
    const put = db.prepare(`INSERT INTO tool_policies VALUES(?,?,?,?) ON CONFLICT(user_id, tool) DO UPDATE SET mode=excluded.mode, updated_at=excluded.updated_at`);
    const now = Date.now();
    db.transaction(() => { for (const t of list) put.run(userId, t, value, now); })();
    audit('tool.policy', userId, { tools: list, mode: value });
  }

  return { mode, set, stored };
}

/** The JS reference, whatever POLICY_LEAVES_IMPL says. */
const createToolPolicyJs = (opts) => createToolPolicy({ ...opts, impl: 'js' });

module.exports = { createToolPolicy, createToolPolicyJs };
