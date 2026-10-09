'use strict';
// #1012: the llama.cpp router reads models.ini at start and on GET /models?reload=1. A reload keeps
// every running model whose effective preset is unchanged and UNLOADS any running model whose
// preset changed or was removed, which would cut off a client using it (Diary and other clients do
// not pass through noevia's maintenance gate). So reloadPresets used to refuse whenever anything
// was loaded, and a newly added model stayed invisible to the engine until a manual restart.
//
// Always on since #1071 (it was PRESET_RELOAD_IMPL=wasm): a reload goes ahead with models loaded
// when all of these hold, and otherwise keeps the old refusal:
//   1. noevia knows what the router last read: the models.ini text recorded right after the last
//      reload noevia made (kept in stateFile so a core restart does not forget it), and
//   2. the router's own view (every model's status.preset) is still exactly what it reported right
//      after that reload, so the router has not re-read the file since (restart, other client), and
//   3. Rust's preset-reload check (dav-parse.wasm) finds every loaded model's own section, the
//      [*] section and the preamble unchanged between that text and the file now.
// Anything unknown, unreadable or ambiguous fails closed (no reload with models loaded).

const fs = require('node:fs');

// Statuses the router counts as running (server-models.h is_running(): loaded, loading, sleeping);
// a reload unloads any of them whose preset changed.
const LIVE = new Set(['loaded', 'loading', 'sleeping']);
const liveIds = (rows) => (Array.isArray(rows) ? rows : []).filter((m) => LIVE.has(m?.status?.value)).map((m) => m.id);

/** The router's view: model id -> its reported preset text, as a canonical string; null (unknown)
 *  when the listing is not an array or any row lacks a string id or status.preset (#1037). */
function engineView(rows) {
  if (!Array.isArray(rows)) return null;
  const out = {};
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || typeof row.status?.preset !== 'string') return null;
    out[row.id] = row.status.preset;
  }
  return JSON.stringify(Object.keys(out).sort().map((id) => [id, out[id]]));
}

function createReloadGuard({ stateFile = null, check = (req) => require('./dav-parse-wasm.cjs').presetReload(req), log = () => {} } = {}) {
  let baseline = null; // { text, view }
  try {
    if (stateFile) {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (typeof saved?.text === 'string' && typeof saved?.view === 'string') baseline = { text: saved.text, view: saved.view };
      // `{}` is the tombstone forget() leaves: unknown.
    }
  } catch { /* first run, or unreadable: unknown */ }
  const persist = () => {
    if (!stateFile) return;
    try {
      // Forgetting writes a tombstone instead of deleting, so a failed delete can never leave an
      // old baseline behind for the next start (#1040).
      fs.writeFileSync(stateFile, JSON.stringify(baseline || {}), { mode: 0o600 });
    } catch (e) { log(`[models] could not save the preset reload baseline: ${e?.message || e}`); }
  };
  return {
    /** After a reload noevia made: the text it read just before and the router's rows just after.
     *  `textAfter` is the file re-read after the rows; if it moved, the router may have read either. */
    record(textBefore, rows, textAfter) {
      const view = engineView(rows);
      baseline = typeof textBefore === 'string' && textBefore === textAfter && view !== null ? { text: textBefore, view } : null;
      persist();
    },
    forget() { baseline = null; persist(); },
    known: () => !!baseline,
    /** May the router reload `currentText` now without unloading any of `loadedIds`? */
    verdict(currentText, rows, loadedIds) {
      if (!baseline) return { safe: false, reason: 'unknown' };
      const view = engineView(rows);
      if (view === null) return { safe: false, reason: 'unknown' };
      if (view !== baseline.view) return { safe: false, reason: 'engine_moved' };
      if (typeof currentText !== 'string') return { safe: false, reason: 'unreadable' };
      try {
        const r = check({ baseline: baseline.text, current: currentText, loaded: loadedIds });
        return r?.safe === true ? { safe: true, reason: 'unchanged' } : { safe: false, reason: r?.reason || 'changed', changed: r?.changed || [] };
      } catch (e) {
        log(`[models] preset reload check failed closed: ${e?.message || e}`);
        return { safe: false, reason: 'check_failed' };
      }
    },
  };
}

module.exports = { createReloadGuard, engineView, liveIds, LIVE };
