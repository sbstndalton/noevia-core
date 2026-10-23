'use strict';
// Source processing keeps its existing in-process operation and chat wait registry, while the
// Rust internal store is the only writer/reader of the persisted source-kind job journal.
const crypto = require('node:crypto');
const { START_ID } = require('./chat-partial.cjs');
// Linux /proc field 22 is THIS process's boot-relative start tick, captured once at module load.
// Ticks are ordered across processes; equal ticks with different owners fail closed in Rust.
const stat = require('node:fs').readFileSync('/proc/self/stat', 'utf8');
const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
const BORN = fields[19];
if (!/^[0-9]+$/.test(BORN || '')) throw Error('Cannot establish source-job process birth');
const OWNER = Object.freeze({ start: START_ID, born: BORN, owner: crypto.randomUUID() });
const stores = new WeakMap();
async function storeFor(workspace) {
  let ready = stores.get(workspace);
  if (!ready) {
    if (!workspace.sourceJobs) throw Object.assign(Error('The source job store is unavailable; retry shortly.'), { status: 503 });
    ready = Promise.resolve().then(async () => {
      workspace.assertActive?.();
      await workspace.sourceJobs.recover(OWNER);
      workspace.assertActive?.();
      return workspace.sourceJobs;
    });
    stores.set(workspace, ready);
    ready.catch(() => { if (stores.get(workspace) === ready) stores.delete(workspace); });
  }
  return ready;
}
// A start may commit in Rust even if both of its replies are lost. Do not launch work without
// the id/run. Instead tombstone its request key in Rust; retry cleanup while this Node is alive,
// and drain it before another start for the same tenant. A newer Node recovers these jobs too.
const pendingAbandons = new Map();
let cleanupTimer = null;
const tenantKey = (workspace) => workspace.userId || workspace.dir || workspace;
function queueAbandon(key, jobs, request) {
  let entries = pendingAbandons.get(key);
  if (!entries) { entries = new Map(); pendingAbandons.set(key, entries); }
  entries.set(request, { jobs, request, cleaning: null });
}
async function drainAbandons(key) {
  const entries = pendingAbandons.get(key);
  if (!entries) return;
  await Promise.all([...entries.values()].map(async (entry) => {
    if (!entry.cleaning) entry.cleaning = Promise.resolve().then(() => entry.jobs.abandon(OWNER, entry.request))
      .then(() => { entries.delete(entry.request); }, (error) => {
        // A newer owner has already interrupted this process's source jobs; a deleted
        // account cannot retain a source journal. Transport/store failure remains pending.
        if (error?.status === 409 || error?.status === 410) entries.delete(entry.request);
      }).finally(() => { entry.cleaning = null; });
    await entry.cleaning;
  }));
  if (!entries.size) pendingAbandons.delete(key);
}
function scheduleCleanup() {
  if (cleanupTimer || !pendingAbandons.size) return;
  cleanupTimer = setTimeout(async () => {
    cleanupTimer = null;
    for (const key of [...pendingAbandons.keys()]) await drainAbandons(key);
    scheduleCleanup();
  }, 5000);
  cleanupTimer.unref?.();
}
// In-process record of file-bearing jobs still running, so a chat turn can wait for them (#1441).
// Names are memory-only, never in a journal. Rust replays their terminal status for polls.
const STALE_MS = 10 * 60000;
const registries = new WeakMap();
const registryFor = (workspace) => { let r = registries.get(workspace); if (!r) { r = new Map(); registries.set(workspace, r); } return r; };
async function start(workspace, projectId, operation, { name = null } = {}) {
  const jobs = await storeFor(workspace);
  workspace.assertActive?.();
  // Rust checks the per-tenant source-only two-active cap and persists created+started before
  // this returns. No local journal fallback can create a second writer on a store outage.
  const key = tenantKey(workspace);
  await drainAbandons(key);
  if (pendingAbandons.has(key)) {
    scheduleCleanup();
    throw Object.assign(Error('The source job store is reconciling an unconfirmed job; retry shortly.'), { status: 503 });
  }
  const request = crypto.randomUUID();
  let id, run;
  try {
    ({ id, run } = await jobs.start(OWNER, projectId, request));
    if (typeof id !== 'string' || typeof run !== 'string') throw Object.assign(Error('The source job store refused to start.'), { status: 503 });
  } catch (error) {
    if (error?.status === 503) {
      queueAbandon(key, jobs, request);
      // The caller should see the start failure promptly even if cleanup's two store
      // timeouts also fail. Keep retrying in memory and before this tenant's next start.
      Promise.resolve().then(() => drainAbandons(key)).finally(scheduleCleanup).catch(() => undefined);
      scheduleCleanup();
    }
    throw error;
  }
  const running = (async () => {
    let progressTail = Promise.resolve(), progressFailure = null, n = 0;
    const progress = (stage) => {
      const sequence = ++n;
      progressTail = progressTail.then(() => jobs.progress(OWNER, id, run, stage, sequence)).catch((err) => {
        progressFailure ||= err;
        throw err;
      });
      // The producer's callback is synchronous; attach a rejection observer now so Node does not
      // report an unhandled rejection before the operation itself reaches its flush barrier.
      progressTail.catch(() => undefined);
    };
    let result;
    try {
      result = await operation(progress);
      await progressTail; // no terminal event can overtake a pending progress write
      if (progressFailure) throw progressFailure;
      workspace.assertActive?.();
      await jobs.finish(OWNER, id, run, true, result, null);
    } catch (err) {
      // The operation may already have changed a source. A failed progress append must never be
      // followed by a clean completion. If the store is unavailable, leave the journal active;
      // the next Node process marks it interrupted rather than claiming a false success.
      try { await progressTail; } catch { /* progressFailure is already retained */ }
      const failure = Object.assign(new Error('Source processing failed; refresh or re-upload to retry.'),
        { result: { status: progressFailure ? 503 : (err?.status || 500) } });
      try { workspace.assertActive?.(); await jobs.finish(OWNER, id, run, false, failure.result, failure.message); }
      catch { /* a refused or uncertain finish is recovered on the next process start */ }
    }
  })();
  if (typeof name === 'string' && name) {
    const registry = registryFor(workspace);
    const entry = { projectId, name: name.slice(0, 200), outcome: null };
    entry.finished = running.then(async () => {
      let job = null; try { job = await jobs.read(projectId, id); } catch { /* unknown status is failed */ }
      entry.outcome = job && job.status === 'completed' && !(job.result?.status >= 400) ? 'ready' : 'failed';
    }).finally(() => registry.delete(id));
    registry.set(id, entry);
  }
  running.catch(() => undefined);
  return id;
}

// A chat turn sent right after an upload was accepted (202) must see that file (#1441): wait for the
// project's running file jobs, at most `timeoutMs`, ending early if `signal` aborts (the client left).
// Resolves { notReady: [{ name, reason: 'failed' | 'timeout' }], aborted } for the jobs it waited on.
async function settle(workspace, projectId, { timeoutMs = 30000, signal } = {}) {
  const registry = registryFor(workspace), now = Date.now();
  // A job that already outlasted one wait is reported as not ready without making every later turn
  // wait the full bound again; one that never settles is forgotten after STALE_MS.
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
async function read(workspace, projectId, id) {
  const jobs = await storeFor(workspace);
  // A 404 from Rust means the id is absent or belongs to another project. A store transport or
  // corruption failure propagates as unavailable instead of falsely saying the job expired.
  const job = await jobs.read(projectId, id);
  if (!job) return null;
  if (job.status === 'completed') return { done: true, status: job.result?.status, body: job.result?.body };
  if (job.status === 'failed') return { done: true, status: job.result?.status || 500, body: { error: job.error } };
  if (job.status === 'interrupted' || job.status === 'cancelled') return { done: true, status: 503, body: { error: 'The server restarted before processing finished; refresh or re-upload to retry.' } };
  return { done: false, ...(job.stage ? { stage: job.stage } : {}) };
}
module.exports = { start, read, settle };
