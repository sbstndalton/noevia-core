'use strict';
// The Rust store is the only persisted deep_research journal owner. Node keeps only the live
// executor/AbortController and reports ordered progress/checkpoints to the authenticated store.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { START_ID } = require('./chat-partial.cjs');
const stat = fs.readFileSync('/proc/self/stat', 'utf8');
const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
const BORN = fields[19];
if (!/^[0-9]+$/.test(BORN || '')) throw Error('Cannot establish research-job process birth');
const OWNER = Object.freeze({ start: START_ID, born: BORN, owner: crypto.randomUUID() });
const recovered = new WeakMap();
async function storeFor(workspace) {
  let ready = recovered.get(workspace);
  if (!ready) {
    if (!workspace.researchJobs) throw Object.assign(Error('The research job store is unavailable; retry shortly.'), { status: 503 });
    ready = Promise.resolve().then(async () => {
      workspace.assertActive?.();
      await workspace.researchJobs.recover(OWNER);
      workspace.assertActive?.();
      return workspace.researchJobs;
    });
    recovered.set(workspace, ready);
    ready.catch(() => { if (recovered.get(workspace) === ready) recovered.delete(workspace); });
  }
  return ready;
}
const pendingAbandons = new Map();
let cleanupTimer = null;
const tenantKey = (w) => w.userId || w.dir || w;
function queueAbandon(key, store, request, report) {
  let entries = pendingAbandons.get(key);
  if (!entries) { entries = new Map(); pendingAbandons.set(key, entries); }
  entries.set(request, { store, request, report, cleaning: null });
}
async function drainAbandons(key) {
  const entries = pendingAbandons.get(key);
  if (!entries) return;
  await Promise.all([...entries.values()].map(async (entry) => {
    if (!entry.cleaning) entry.cleaning = Promise.resolve().then(async () => {
      if (entry.report) {
        try { await entry.store.report(OWNER, entry.report.id, entry.report.run, entry.report.result); }
        catch (error) { if (error?.status !== 409) throw error; }
      }
      return entry.store.abandon(OWNER, entry.request);
    })
      .then(() => entries.delete(entry.request), (error) => {
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
function reconcileLater(key, store, request, report) {
  queueAbandon(key, store, request, report);
  Promise.resolve().then(() => drainAbandons(key)).finally(scheduleCleanup).catch(() => undefined);
  scheduleCleanup();
}
function createResearchJobs(workspace) {
  const running = new Map();
  const known = new Map();
  const key = tenantKey(workspace);
  const store = () => storeFor(workspace);
  const runFor = (id) => known.get(id)?.run || '';
  return {
    async create({ projectId, question, plan, subQuestions }) {
      const jobs = await store();
      workspace.assertActive?.();
      await drainAbandons(key);
      if (pendingAbandons.has(key)) {
        scheduleCleanup();
        throw Object.assign(Error('The research job store is reconciling an unconfirmed job; retry shortly.'), { status: 503 });
      }
      const request = crypto.randomUUID();
      let id, run;
      try {
        ({ id, run } = await jobs.start(OWNER, projectId, request, question, plan || 'skipped', subQuestions || []));
        if (typeof id !== 'string' || typeof run !== 'string') throw Object.assign(Error('The research job store refused to start.'), { status: 503 });
      } catch (error) {
        if (error?.status === 503) reconcileLater(key, jobs, request);
        throw error;
      }
      known.set(id, { projectId, run, request });
      return id;
    },
    // The plan was committed atomically with create in Rust. The runner's legacy call is harmless.
    async append(id, type) {
      if (!known.has(id) || !/^plan\.(proposed|edited|skipped)$/.test(type)) throw Object.assign(Error('Invalid research event'), { status: 409 });
    },
    run(id, work) {
      const reservation = known.get(id);
      if (!reservation || running.has(id)) throw Object.assign(Error('Research job is not reserved'), { status: 409 });
      const controller = new AbortController();
      const state = { controller, cancelAttempted: false };
      running.set(id, state);
      let tail = Promise.resolve(), failed = null, n = 0;
      const enqueue = (kind, data) => {
        const sequence = ++n;
        tail = tail.then(async () => { const jobs = await store(); await jobs.event(OWNER, id, reservation.run, sequence, kind, data); })
          .catch((error) => { failed ||= error; controller.abort(); throw error; });
        tail.catch(() => undefined);
      };
      const ctx = { id, signal: controller.signal,
        progress: (stage) => { if (!controller.signal.aborted) enqueue('progress', { stage }); },
        checkpoint: (data) => enqueue('checkpoint.created', data),
        flush: async () => { await tail; if (failed) throw failed; },
      };
      const done = (async () => {
        let result = null, ok = false, error = null;
        try {
          result = await work(ctx);
          await tail;
          if (failed) throw failed;
          ok = !state.cancelAttempted;
          if (state.cancelAttempted) error = 'Research cancellation was not confirmed; review the job before retrying.';
        } catch (cause) {
          try { await tail; } catch { /* first failure retained */ }
          error = String(cause?.publicMessage || cause?.message || 'Research failed.').slice(0, 500);
          result = cause?.result ?? result;
        }
        try {
          workspace.assertActive?.();
          const jobs = await store();
          // Cancellation and error paths can also return completed sections. Persist their
          // result before the terminal attempt so an ambiguous finish can be reconciled.
          if (result && typeof result.markdown === 'string' && Array.isArray(result.sources))
            await jobs.report(OWNER, id, reservation.run, result);
          await jobs.finish(OWNER, id, reservation.run, ok, result, error);
        } catch {
          // Lost terminal answers or an outage cannot keep this project's sole active slot
          // indefinitely in the same Node process. Rust preserves committed terminal rows.
          const jobs = await store().catch(() => workspace.researchJobs);
          if (jobs) reconcileLater(key, jobs, reservation.request, result && typeof result.markdown === 'string' && Array.isArray(result.sources) ? { id, run: reservation.run, result } : null);
        } finally { running.delete(id); known.delete(id); }
        const jobs = await store();
        return jobs.read(reservation.projectId, id);
      })();
      state.done = done;
      done.catch(() => undefined);
      return done;
    },
    async get(id, projectId) {
      const project = projectId || known.get(id)?.projectId;
      if (!project) return null;
      return (await store()).read(project, id);
    },
    async list({ projectId, active } = {}) {
      const jobs = await (await store()).list(projectId);
      return active === undefined ? jobs : jobs.filter((j) => active === !['completed','failed','cancelled','interrupted'].includes(j.status));
    },
    async cancel(id, projectId) {
      const project = projectId || known.get(id)?.projectId;
      if (!project) return null;
      // The journal intent is durable first; then stop the in-process executor. A 409 cannot
      // be turned into a claimed cancellation of a newer owner.
      const jobs = await store();
      try { return await jobs.cancel(OWNER, project, id, runFor(id)); }
      finally {
        // A committed intent may have lost both replies. Stop the local executor even when
        // the HTTP result remains an honest 503; Rust decides the eventual terminal status.
        const live = running.get(id);
        if (live) { live.cancelAttempted = true; live.controller.abort(); }
      }
    },
    async report(id, result) {
      const jobs = await store();
      return jobs.report(OWNER, id, runFor(id), result);
    },
    async prepareFile(id, projectId, name, hash, bytes, target) {
      const jobs = await store();
      return jobs.prepare(OWNER, projectId, id, runFor(id), name, hash, bytes, target);
    },
    async artifact(id, projectId, name, hash, bytes) {
      const jobs = await store();
      return jobs.artifact(OWNER, projectId, id, runFor(id), name, hash, bytes);
    },
    async clearFile(id, projectId, name, hash) {
      const jobs = await store();
      return jobs.clear(OWNER, projectId, id, runFor(id), name, hash);
    },
  };
}
module.exports = { createResearchJobs };
