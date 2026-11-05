'use strict';
// Live router baseline facts only. Idle timer persistence and application are owned by the Rust front.
/** The `[*]` `sleep-idle-seconds` value in a models.ini text, as the model manager writes it
 *  (noevia-rs idle_unload.rs: `ident = value`, optional leading dashes; no key means Never, 0).
 *  null when the text has a value that is not a whole number. */
function globalIdleSeconds(text) {
  let inGlobal = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[') && line.endsWith(']')) { inGlobal = line === '[*]'; continue; }
    if (!inGlobal) continue;
    const at = raw.indexOf('=');
    if (at < 0) continue;
    const key = raw.slice(0, at).trim().replace(/^--?/, '');
    if (key !== 'sleep-idle-seconds') continue;
    const value = raw.slice(at + 1).trim();
    return /^\d+$/.test(value) ? Number(value) : null;
  }
  return 0;
}

function createIdleUnloadSetting({ presetsInRouter = null } = {}) {
  async function effectiveSeconds() {
    if (typeof presetsInRouter !== 'function') return null;
    let text = null;
    try { text = await presetsInRouter(); } catch { text = null; }
    return typeof text === 'string' ? globalIdleSeconds(text) : null;
  }

  return { effectiveSeconds };
}

module.exports = { createIdleUnloadSetting, globalIdleSeconds };
