'use strict';
// sbstndalton/noevia#2191 round 6 (rust-source-jobs): the Rust front owns the source-job store
// (noevia-rs crates/server-projects source_jobs.rs, users/<id>/jobs/<uuid>.jsonl) and its routes:
// it starts the job, answers the 202 and every poll, and runs the operation by sending the
// synchronous upload or sync to this process with `X-Noevia-Source-Work: 1`
// (routes/projects.cjs). This process no longer reads or writes a source journal.
//
// What stays here is in-process only: the file-bearing operations this process is running for
// the front, so a chat turn sent right after an accepted upload can wait for that file (#1441).
// Names are memory-only, as before; nothing here is persisted.
const STALE_MS = 10 * 60000;
const registries = new WeakMap();
const registryFor = (workspace) => { let r = registries.get(workspace); if (!r) { r = new Map(); registries.set(workspace, r); } return r; };
let next = 0;

/** Runs `operation` (resolving { status, body }) as a tracked file operation of `projectId`
 *  when `name` is a non-empty string; otherwise just runs it. Returns its promise. */
function track(workspace, projectId, operation, { name = null } = {}) {
  const running = Promise.resolve().then(operation);
  if (typeof name === 'string' && name) {
    const registry = registryFor(workspace);
    const id = ++next;
    const entry = { projectId, name: name.slice(0, 200), outcome: null };
    entry.finished = running.then((result) => {
      entry.outcome = result && !(result.status >= 400) ? 'ready' : 'failed';
    }, () => { entry.outcome = 'failed'; }).finally(() => registry.delete(id));
    registry.set(id, entry);
  }
  return running;
}

// A chat turn sent right after an upload was accepted (202) must see that file (#1441): wait for the
// project's running file operations, at most `timeoutMs`, ending early if `signal` aborts (the client
// left). Resolves { notReady: [{ name, reason: 'failed' | 'timeout' }], aborted }.
async function settle(workspace, projectId, { timeoutMs = 30000, signal } = {}) {
  const registry = registryFor(workspace), now = Date.now();
  // An operation that already outlasted one wait is reported as not ready without making every later
  // turn wait the full bound again; one that never settles is forgotten after STALE_MS.
  for (const [id, e] of registry) if (e.timedOutAt && now - e.timedOutAt > STALE_MS) registry.delete(id);
  const mine = [...registry.values()].filter((e) => e.projectId === projectId);
  const waiting = mine.filter((e) => !e.timedOutAt);
  const report = () => mine.filter((e) => e.outcome !== 'ready').map((e) => ({ name: e.name, reason: e.outcome === 'failed' ? 'failed' : 'timeout' }));
  if (!waiting.length) return { notReady: report(), aborted: false };
  let timer, onAbort;
  const stop = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    if (signal) { onAbort = () => resolve('aborted'); if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  });
  try {
    const result = await Promise.race([Promise.all(waiting.map((e) => e.finished)).then(() => 'done'), stop]);
    if (result === 'aborted') return { notReady: [], aborted: true };
    for (const e of waiting) if (!e.outcome && !e.timedOutAt) e.timedOutAt = Date.now();
    return { notReady: report(), aborted: false };
  } finally { clearTimeout(timer); if (signal && onAbort) signal.removeEventListener('abort', onAbort); }
}

module.exports = { track, settle };
