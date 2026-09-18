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
const MODES = new Set(['allow', 'ask', 'block']);
const fail = (message) => Object.assign(Error(message), { status: 400, publicMessage: message });

function createToolPolicy({ db, audit = () => {} }) {
  db.exec(`CREATE TABLE IF NOT EXISTS tool_policies(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tool TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('allow','ask','block')), updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, tool));`);
  const stored = (userId) => Object.fromEntries(db.prepare('SELECT tool, mode FROM tool_policies WHERE user_id=?').all(userId).map((r) => [r.tool, r.mode]));

  /** The mode that applies to one call. */
  function mode(userId, tool, isWrite) {
    const m = userId ? db.prepare('SELECT mode FROM tool_policies WHERE user_id=? AND tool=?').get(userId, tool)?.mode : null;
    if (m === 'block') return 'block';
    if (isWrite) return 'ask';
    return m || 'allow';
  }

  function set(userId, tools, value, isWrite) {
    if (!MODES.has(value)) throw fail('Choose allow, ask or block.');
    const list = [].concat(tools);
    if (!list.length) throw fail('Choose a tool.');
    if (value === 'allow' && list.some((t) => isWrite(t))) throw fail('Writes always ask first, so they cannot be set to Always allow.');
    const put = db.prepare(`INSERT INTO tool_policies VALUES(?,?,?,?) ON CONFLICT(user_id, tool) DO UPDATE SET mode=excluded.mode, updated_at=excluded.updated_at`);
    const now = Date.now();
    db.transaction(() => { for (const t of list) put.run(userId, t, value, now); })();
    audit('tool.policy', userId, { tools: list, mode: value });
  }

  return { mode, set, stored };
}

module.exports = { createToolPolicy };
