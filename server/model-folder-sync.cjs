'use strict';
// A GGUF that appears in the models folder becomes a usable model on its own: the server asks the
// model manager for files with no settings, registers each with safe defaults (8K context, the
// file's own chat template and sampling, MTP only when a head exists), and reloads the engine's
// presets once. Tuning and context measurement stay optional and separate.
//
// Deliberately conservative: a file the manager refuses (a draft head, a name already taken, a
// clash) is remembered and never retried, so a broken file cannot cause an endless retry loop.
// Registration never unloads a running model; when the engine is busy the new preset is picked up
// at the next reload.
const fs = require('node:fs');

const RETRY_NEVER = new Set([400, 409, 404]);

function createFolderSync({ listUnregistered, register, reloadPresets, stateFile = null, log = () => {},
  intervalMs = 15 * 60 * 1000, firstDelayMs = 20000, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null, running = false;
  let skip = new Set();
  try { if (stateFile) skip = new Set(JSON.parse(fs.readFileSync(stateFile, 'utf8')).skip || []); } catch { /* first run */ }
  const remember = (stem) => {
    skip.add(stem);
    if (!stateFile) return;
    try { fs.writeFileSync(stateFile, JSON.stringify({ skip: [...skip].slice(-500) }), { mode: 0o600 }); } catch { /* best effort */ }
  };

  async function run() {
    if (running) return { added: [], skipped: [] };
    running = true;
    try {
      const stems = await listUnregistered();
      const fresh = (stems || []).filter((s) => !skip.has(s));
      const added = [], failed = [];
      for (const stem of fresh) {
        try { await register(stem); added.push(stem); }
        catch (e) {
          if (RETRY_NEVER.has(e?.status)) { remember(stem); continue; }
          failed.push(`${stem} (${e?.message || 'error'})`);
        }
      }
      if (added.length) {
        let note = '';
        try { const r = await reloadPresets(); if (!r?.ok) note = ' The engine will offer them after its next reload.'; }
        catch { note = ' The engine will offer them after its next reload.'; }
        log(`[models] set up ${added.length} new model${added.length === 1 ? '' : 's'} from the models folder: ${added.join(', ')}.${note}`);
      }
      if (failed.length) log(`[models] could not set up: ${failed.join(', ')}`);
      return { added, skipped: [...skip], failed, at: now() };
    } catch (e) {
      log(`[models] folder scan failed: ${e?.message || e}`);
      return { added: [], error: String(e?.message || e) };
    } finally { running = false; }
  }

  function start() {
    if (timer) return;
    const tick = async () => { await run().catch(() => {}); timer = setTimer(tick, intervalMs); if (timer.unref) timer.unref(); };
    timer = setTimer(tick, firstDelayMs);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearTimer(timer); timer = null; }
  return { run, start, stop, skipped: () => [...skip] };
}

module.exports = { createFolderSync };
