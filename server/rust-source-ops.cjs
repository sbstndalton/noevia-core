'use strict';
// sbstndalton/noevia#2191 round 8: Node as a re-reader of the file operations the Rust front is running
// (noevia-rs crates/server-projects source_ops.rs). The front writes users/<id>/source-file-ops.json when an
// upload, a folder import's file or a sync starts and ends; this reads it, with the change signal of
// shared-reread.cjs, for the two things Node still does around those operations:
//
//   - settle(): a chat turn sent right after an upload was accepted must see that file (#1441), so it waits
//     for the project's running file operations, at most `timeoutMs`, ending early if `signal` aborts
//     (the client left). It reports the files that did not become ready.
//   - inFlight(): the source-text collector (source-text.cjs, #1815) removes nothing while a sync or a
//     folder import runs in the workspace.
//
// Names are as the front listed them; nothing here is written. A `running` entry older than STALE_MS is not
// waited for (the front fails a dead process's entries itself at its next write; this bounds a front that
// was never restarted).
const fs = require('node:fs');
const path = require('node:path');
const { createReread, fileSignal } = require('./shared-reread.cjs');

const FILE = 'source-file-ops.json';
const STALE_MS = 6 * 60 * 60 * 1000;
const TIMED_OUT_FORGET_MS = 10 * 60 * 1000;
const POLL_MS = 100;

const readers = new Map();
const readerFor = (file) => {
  let r = readers.get(file);
  if (!r) {
    r = createReread({
      signal: () => fileSignal(file),
      load: () => {
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error && error.code === 'ENOENT') return []; throw error; }
        const doc = JSON.parse(text);
        return Array.isArray(doc && doc.ops) ? doc.ops.filter((o) => o && typeof o === 'object') : [];
      },
      // A file that cannot be read tells nothing: no operation is waited for.
      fallback: () => [],
    });
    readers.set(file, r);
  }
  return r;
};
const opsOf = (dir) => readerFor(path.join(dir, FILE)).current();

// An operation that already outlasted one wait is reported as not ready without making every later turn
// wait the full bound again.
const timedOut = new Map();

/** Whether a sync or a folder import is running for the workspace folder `dir`. */
function inFlight(dir, now = Date.now()) {
  if (!dir) return false;
  try { return opsOf(dir).some((o) => o.state === 'running' && (o.kind === 'sync' || o.kind === 'import') && now - Number(o.at) < STALE_MS); }
  catch { return false; }
}

/** Waits for the project's running file operations. Resolves { notReady: [{ name, reason: 'failed' | 'timeout' }], aborted }. */
async function settle(workspace, projectId, { timeoutMs = 30000, signal, now = Date.now, pollMs = POLL_MS } = {}) {
  const dir = workspace && workspace.dir;
  const t0 = now();
  for (const [id, at] of timedOut) if (t0 - at > TIMED_OUT_FORGET_MS) timedOut.delete(id);
  const running = () => (dir ? opsOf(dir) : []).filter((o) => o.project === projectId && o.name && o.state === 'running' && t0 - Number(o.at) < STALE_MS);
  const mine = running();
  const waiting = mine.filter((o) => !timedOut.has(o.id));
  const outcomes = new Map();
  const report = () => mine.map((o) => ({ o, outcome: outcomes.get(o.id) || (timedOut.has(o.id) ? 'timeout' : null) }))
    .filter(({ outcome }) => outcome !== 'ready').map(({ o, outcome }) => ({ name: String(o.name).slice(0, 200), reason: outcome === 'failed' ? 'failed' : 'timeout' }));
  if (!waiting.length) return { notReady: report(), aborted: false };
  const deadline = now() + timeoutMs;
  for (;;) {
    if (signal && signal.aborted) return { notReady: [], aborted: true };
    const current = new Map((dir ? opsOf(dir) : []).map((o) => [o.id, o]));
    let pending = false;
    for (const o of waiting) {
      if (outcomes.has(o.id)) continue;
      const now1 = current.get(o.id);
      if (!now1) outcomes.set(o.id, 'ready');
      else if (now1.state === 'running') pending = true;
      else outcomes.set(o.id, now1.state === 'ready' ? 'ready' : 'failed');
    }
    if (!pending) return { notReady: report(), aborted: false };
    if (now() >= deadline) {
      for (const o of waiting) if (!outcomes.has(o.id)) timedOut.set(o.id, now());
      return { notReady: report(), aborted: false };
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}

module.exports = { FILE, settle, inFlight, STALE_MS };
