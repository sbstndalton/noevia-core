'use strict';
// Result polling keeps long OCR/refresh requests below reverse-proxy timeouts. Built on the
// durable job store, so a poll after a restart gets a clear answer instead of "no such job".
// Source originals and results still live in the existing store; jobs hold status only.
const { createJobs } = require('./jobs.cjs');
const stores = new WeakMap();
function storeFor(workspace) {
  let store = stores.get(workspace);
  if (!store) {
    store = createJobs({ dir: workspace.dir, retainMs: 15 * 60000, maxJobs: 16, kinds: ['source'], assertActive: () => workspace.assertActive?.() });
    store.recover();
    stores.set(workspace, store);
  }
  return store;
}
// In-process record of the file-bearing jobs still running, so a chat turn can wait for them (#1441).
// Names are kept in memory only (never in the journal); results are re-read from the job store.
const registries = new WeakMap();
const registryFor = (workspace) => { let r = registries.get(workspace); if (!r) { r = new Map(); registries.set(workspace, r); } return r; };
function start(workspace, projectId, operation, { name = null } = {}) {
  const jobs = storeFor(workspace);
  if (jobs.list({ kind: 'source', active: true }).length >= 2) throw Object.assign(new Error('Source processing is busy; wait for the current operation and retry.'), { status: 429 });
  const id = jobs.create({ kind: 'source', projectId, capabilities: ['project.sources.write'] });
  const running = jobs.run(id, async (ctx) => {
    try { return await operation((stage) => ctx.progress(stage)); }
    catch (err) { throw Object.assign(new Error('Source processing failed; refresh or re-upload to retry.'), { result: { status: err.status || 500 } }); }
  }).catch(() => undefined);
  if (typeof name === 'string' && name) {
    const registry = registryFor(workspace);
    const entry = { projectId, name: name.slice(0, 200), outcome: null };
    entry.finished = running.then(() => {
      let job = null; try { job = jobs.get(id); } catch { /* unreadable journal: treated as failed */ }
      entry.outcome = job && job.status === 'completed' && !(job.result?.status >= 400) ? 'ready' : 'failed';
    }).finally(() => registry.delete(id));
    registry.set(id, entry);
  }
  return id;
}

// A chat turn sent right after an upload was accepted (202) must see that file (#1441): wait for the
// project's running file jobs, at most `timeoutMs`, ending early if `signal` aborts (the client left).
// Resolves { notReady: [{ name, reason: 'failed' | 'timeout' }], aborted } for the jobs it waited on.
async function settle(workspace, projectId, { timeoutMs = 30000, signal } = {}) {
  const waiting = [...registryFor(workspace).values()].filter((e) => e.projectId === projectId);
  if (!waiting.length) return { notReady: [], aborted: false };
  let timer, onAbort;
  const stop = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    if (signal) { onAbort = () => resolve('aborted'); if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  });
  try {
    const result = await Promise.race([Promise.all(waiting.map((e) => e.finished)).then(() => 'done'), stop]);
    if (result === 'aborted') return { notReady: [], aborted: true };
    return { notReady: waiting.filter((e) => e.outcome !== 'ready').map((e) => ({ name: e.name, reason: e.outcome === 'failed' ? 'failed' : 'timeout' })), aborted: false };
  } finally { clearTimeout(timer); if (signal && onAbort) signal.removeEventListener('abort', onAbort); }
}
function read(workspace, projectId, id) {
  let job;
  try { job = storeFor(workspace).get(id); } catch { return null; }
  if (!job || job.kind !== 'source' || job.projectId !== projectId) return null;
  if (job.status === 'completed') return { done: true, status: job.result?.status, body: job.result?.body };
  if (job.status === 'failed') return { done: true, status: job.result?.status || 500, body: { error: job.error } };
  if (job.status === 'interrupted' || job.status === 'cancelled') return { done: true, status: 503, body: { error: 'The server restarted before processing finished; refresh or re-upload to retry.' } };
  return { done: false, ...(job.stage ? { stage: job.stage } : {}) };
}
module.exports = { start, read, settle };
