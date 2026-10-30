'use strict';
// sbstndalton/noevia#2190: tests stand in for the Rust front, the single writer of the
// `decision:configuration` row (noevia-rs decision_settings_routes.rs). `rustSavesDecision` writes
// the bytes Rust stores for a validated save ({url: the service origin, timeoutMs, model?}, in that
// key order); `rustResetsDecision` deletes the row. Pass a plain {get,set} store, or a better-sqlite3
// connection (raw, not Node's guarded one, which refuses the key as it does in production).
const KEY = 'decision:configuration';

function encode({ url, timeoutMs, model }) {
  const origin = new URL(String(url).trim()).origin;
  return JSON.stringify({ url: origin, timeoutMs, ...(model ? { model: String(model).trim().toLowerCase() } : {}) });
}

function rustSavesDecision(target, value) {
  const encoded = encode(value);
  if (typeof target.prepare === 'function') target.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(KEY, encoded);
  else target.set(KEY, encoded);
  return encoded;
}

function rustResetsDecision(target) {
  if (typeof target.prepare === 'function') target.prepare('DELETE FROM settings WHERE key=?').run(KEY);
  else if (typeof target.delete === 'function') target.delete(KEY);
  else target.set(KEY, undefined);
}

module.exports = { rustSavesDecision, rustResetsDecision, KEY };
