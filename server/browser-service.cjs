'use strict';
// Browser mode as a project feature (issue #274, wiring spec-agent-execution §6 into §4's
// durable job primitive and the existing write-approval card). One task is one durable job
// (kind 'browser') that holds one BrowserExecutor session open for its lifetime; actions are
// submitted one at a time through `act()`, in the order they arrive, and every consequential
// one still stops at noevia's approval card exactly as Code mode's does — the same
// approve/approve_all/deny answers, the same per-request pending map, the same "a restart never
// silently resumes an approval" rule.
//
// What is deliberately NOT here: an execution node (spec §5). `launch` is injected, so a
// deployment without a qualified browser brings none, and the feature simply reports itself
// unavailable — it never falls back to running one unsandboxed.
const path = require('node:path');
const crypto = require('node:crypto');
const { createJobs } = require('./jobs.cjs');
const { createBrowserExecutor } = require('./browser-executor.cjs');

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
// No action arrives (act or finish) for this long: the task is not making progress and is timed
// out rather than left running forever waiting on a caller that may never come back.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const TIMEOUT_REASON = 'This browser task made no progress and timed out.';
// A caller's own summary of what the task did, stored on the job's completion event (spec §4):
// bounded the same way assistant output is, so a careless or hostile caller cannot grow the
// journal file without limit.
const MAX_RESULT_BYTES = 64 * 1024;

const fail = (status, message) => Object.assign(Error(message), { status, publicMessage: message });

function parseDomains(list) {
  return (Array.isArray(list) ? list : [])
    .map((d) => String(d || '').trim().toLowerCase())
    .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
    .slice(0, 20);
}

/** Public view of a task. Bounded, never carrying a secret, a host path or a session id. */
function view(job, pending = null) {
  if (!job) return null;
  return {
    id: job.id, status: job.status, stage: job.stage, error: job.error,
    domains: job.checkpoint?.domains || [], createdAt: job.createdAt, updatedAt: job.updatedAt,
    capabilities: job.capabilities, steps: job.steps,
    approval: pending ? { id: pending.id, ...pending.request } : null,
    result: job.result || null,
  };
}

/**
 * @param {{ launch: () => Promise<object>, egress?: object, log?: Function, now?: ()=>number,
 *           timeoutMs?: number, idleTimeoutMs?: number, direct?: boolean }} deps
 */
function createBrowserService({ launch, egress = null, log = () => {}, now = Date.now,
  timeoutMs = APPROVAL_TIMEOUT_MS, idleTimeoutMs = IDLE_TIMEOUT_MS, direct = false }) {
  if (typeof launch !== 'function') throw Error('A browser service needs a browser to launch.');
  const stores = new WeakMap();
  const sessions = new Map(); // jobId -> { enqueue(item) }
  // Approvals live in memory on purpose, exactly as Code mode's do: a decision that outlives the
  // request it belongs to is not a decision, and a restart must re-ask.
  const pending = new Map(); // approvalId -> { id, taskId, request, decide }
  const expired = new Map(); // approvalId -> expiry epoch ms (UI courtesy, mirrors code-service)
  const EXPIRED_MEMORY_MS = 60000;
  const rememberExpired = (id) => {
    expired.set(id, now() + EXPIRED_MEMORY_MS);
    if (expired.size > 200) for (const [k, until] of expired) if (until <= now()) expired.delete(k);
  };

  function storeFor(workspace) {
    let store = stores.get(workspace);
    if (!store) {
      // Server-restart recovery (spec §4): anything not terminal when this store is first opened
      // for this tenant was running under a process that no longer exists. It is marked
      // interrupted, never resumed and never left silently "running".
      const jobs = createJobs({ dir: workspace.dir, kinds: ['browser'], maxJobs: 50, retainMs: 7 * 86400000, now });
      jobs.recover();
      store = { jobs };
      stores.set(workspace, store);
    }
    return store;
  }

  function askApproval(card, { signal } = {}) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      let settled = false;
      const onAbort = () => finish('aborted');
      const finish = (decision) => {
        if (settled) return;
        settled = true; clearTimeout(timer); pending.delete(id);
        // One job's signal outlives many approvals raised on it over the task's life (one per
        // consequential action); a listener left attached after each one settles otherwise, and
        // the signal accumulates one forever-unfired 'abort' listener per action for as long as
        // the job runs.
        if (signal) signal.removeEventListener('abort', onAbort);
        if (decision === 'timeout') rememberExpired(id);
        resolve(decision === 'approve' ? 'approve' : 'deny');
      };
      // Waiting forever is a leaked task; a timeout is a REFUSAL, never a silent approval. Left
      // ref'd on purpose: an unref'd timer does not keep the event loop alive, so if nothing
      // else happens to be pending when this is the only outstanding work, the process can end
      // before it ever fires — silently abandoning whoever is awaiting this decision instead of
      // refusing it. In the real server this timer is never the only thing running (the HTTP
      // listener already keeps the process alive), so this changes nothing about shutdown.
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      pending.set(id, { id, taskId: card.jobId, request: { ...card, id }, decide: finish });
      if (signal) {
        if (signal.aborted) finish('aborted');
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
  const pendingAll = (taskId) => [...pending.values()].filter((p) => p.taskId === taskId);
  const pendingFor = (taskId) => pendingAll(taskId)[0] || null;

  function owned(workspace, project, taskId) {
    const { jobs } = storeFor(workspace);
    const job = jobs.get(taskId);
    if (!job || job.kind !== 'browser' || job.projectId !== project.id) throw fail(404, 'Task not found');
    return job;
  }

  return {
    grantable: Object.freeze(['open_browser']),
    network: () => !!egress,

    list(workspace, project) {
      const { jobs } = storeFor(workspace);
      return jobs.list({ projectId: project.id, kind: 'browser' }).map((j) => view(j, pendingFor(j.id)));
    },
    get(workspace, project, taskId) {
      return view(owned(workspace, project, taskId), pendingFor(taskId));
    },
    async start(workspace, project, body = {}) {
      const domains = parseDomains(body.domains);
      if (!domains.length) throw fail(400, 'A browser task needs at least one domain it may reach.');
      const { jobs } = storeFor(workspace);
      if (jobs.list({ projectId: project.id, kind: 'browser', active: true }).length) {
        throw fail(409, 'This project already has a browser task running.');
      }
      // Refused up front, without a job: a job created and then immediately refused would sit in
      // the store as a non-terminal, un-runnable 'queued' record — nothing ever moves it to
      // TERMINAL, so `active: true` keeps seeing it and every later start is refused with
      // "already running" until a restart happens to call recover() on it.
      if (!egress && !direct) throw fail(503, 'Browser tasks need the egress proxy (D15) configured on this server.');
      const id = jobs.create({ kind: 'browser', projectId: project.id, capabilities: ['open_browser'] });
      const downloadsDir = path.join(workspace.dir, 'browser-downloads', id);
      let grant = null;
      try { grant = egress && domains.length ? egress.grant({ taskId: id, domains }) : null; }
      catch (e) { jobs.cancel(id); throw fail(503, e.publicMessage || 'The egress proxy refused this task.'); }
      // The grant's token outlives this task under any sane configuration: code-egress.cjs
      // defaults CODE_EGRESS_TOKEN_TTL_MS to 6 hours, well past both IDLE_TIMEOUT_MS (10 min,
      // above) and the approval timeout (5 min) that would otherwise end the task first. An
      // operator who sets CODE_EGRESS_TOKEN_TTL_MS below IDLE_TIMEOUT_MS could still see a task's
      // last action refused at the proxy after its token expires; nothing here refreshes it.
      const proxy = grant ? { server: `http://${egress.endpoint || 'egress'}`, username: 'task', password: grant.token } : null;
      if (!proxy && !direct) { jobs.cancel(id); throw fail(503, 'Browser tasks need the egress proxy (D15) configured on this server.'); }

      let ready, readyResolve, readyReject;
      ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

      jobs.run(id, async (ctx) => {
        jobs.append(id, 'checkpoint.created', { domains });
        const revoke = () => { try { if (grant) egress.revoke(id); } catch { /* best effort */ } };
        // The moment noevia's write-approval card is raised and answered is recorded on the job
        // itself (mirrors code-harness.cjs): `waiting_approval` and its reversal both come from
        // these two events, never from in-memory state alone, so the card's status survives a
        // poll racing the decision.
        const executor = createBrowserExecutor({ launch, secrets: {}, direct,
          log: (entry) => log({ ...entry, projectId: project.id }),
          askApproval: async (card, opts) => {
            ctx.event('approval.requested', { ...card, jobId: id });
            // The executor itself does not pass a signal (it has none of its own); this task's
            // job signal is what a cancel actually aborts, so a card raised mid-action must be
            // wired to it here — otherwise a cancel that lands while an action is waiting on the
            // human leaves the card answerable for the full timeout, with the job stuck in
            // `waiting_approval` and its egress grant unrevoked until that timer finally fires.
            const answer = await askApproval({ ...card, jobId: id }, { ...opts, signal: ctx.signal });
            ctx.event('approval.decided', { decision: answer, action: card.action });
            return answer;
          } });
        let sessionId;
        try {
          sessionId = await executor.open({ jobId: id, allowedDomains: domains, downloadsDir, proxy, signal: ctx.signal });
        } catch (error) {
          revoke();
          readyReject(error);
          throw error;
        }
        const queue = [];
        let waking = null;
        sessions.set(id, {
          enqueue(item) { queue.push(item); if (waking) { const w = waking; waking = null; w(); } },
        });
        readyResolve();
        try {
          for (;;) {
            if (ctx.signal.aborted) break;
            if (!queue.length) {
              // One promise, settled exactly once, with every listener and timer it registered
              // torn down on the way out — whichever of the three ways out fires. `Promise.race`
              // over three separately-constructed promises looks equivalent, but it is not: the
              // two that lose the race are still "pending" as far as anything tracking this
              // test's/request's outstanding promises is concerned (their timer is cleared, so it
              // will never settle them; their abort listener may never fire at all), and they
              // leak for the life of the process. With one action arriving per idle wait in the
              // common case, that is one or two dangling, permanently-unsettled promises per
              // action — surfacing under `node --test` as "Promise resolution is still pending
              // but the event loop has already resolved" on whatever test or request happened to
              // be active when the process finally exits.
              const timedOut = await new Promise((resolve) => {
                let settled = false;
                const onAbort = () => finish(false);
                const finish = (value) => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(idleTimer);
                  ctx.signal.removeEventListener('abort', onAbort);
                  resolve(value);
                };
                waking = () => finish(false);
                // Also left ref'd (see the approval timer above): the real server always has its
                // HTTP listener keeping the process alive regardless, so this only matters for a
                // bare `node --test` process where this timer could otherwise be the sole
                // remaining handle and never get to fire at all.
                const idleTimer = setTimeout(() => finish(true), idleTimeoutMs);
                if (ctx.signal.aborted) finish(false);
                else ctx.signal.addEventListener('abort', onAbort, { once: true });
              });
              if (ctx.signal.aborted) break;
              if (timedOut) throw Object.assign(Error(TIMEOUT_REASON), { publicMessage: TIMEOUT_REASON });
              continue;
            }
            const item = queue.shift();
            if (item.finish) return item.result;
            try {
              const result = await executor.act(sessionId, item.action);
              ctx.event('progress', { stage: `${item.action.type}: ${result.status}` });
              item.resolve(result);
            } catch (error) { item.reject(error); }
          }
          return null;
        } finally {
          sessions.delete(id);
          for (const waiting of pendingAll(id)) waiting.decide('aborted');
          // Whatever is still queued (behind a `finish`, a cancel, an idle timeout or the
          // executor open failing) is never going to be picked up by the loop above again: the
          // HTTP request that is awaiting each one would otherwise hang until its own client
          // timeout instead of learning the task ended.
          while (queue.length) { const item = queue.shift(); if (!item.finish) item.reject(fail(409, 'This task ended before this action ran.')); }
          await executor.close(sessionId).catch(() => {});
          revoke();
        }
      }).catch((error) => {
        // A rejection here can be the executor.open() failure already reported through
        // readyReject below, or something earlier still (job.started's own append failing, a
        // disk error) that never reached that catch at all — either way, a caller still awaiting
        // `ready` must not hang forever on a job that has already given up. Settling twice is a
        // no-op on an already-settled promise.
        readyReject(error);
        log({ event: 'browser.job.error', jobId: id, error: String(error?.message || error) });
      });

      await ready.catch((error) => { throw fail(error.status || 502, error.publicMessage || 'The browser could not open.'); });
      return { taskId: id, domains };
    },
    /** Runs one browser action against the task's open session and waits for its outcome. */
    async act(workspace, project, taskId, action = {}) {
      const job = owned(workspace, project, taskId);
      if (job.status !== 'running' && job.status !== 'waiting_approval') throw fail(409, 'This task is not running.');
      if (!action || typeof action.type !== 'string' || !action.type) throw fail(400, 'Name an action to run.');
      const s = sessions.get(taskId);
      if (!s) throw fail(409, 'This task is not open for actions.');
      return new Promise((resolve, reject) => s.enqueue({ action, resolve, reject }));
    },
    decide(workspace, project, taskId, decision, approvalId) {
      owned(workspace, project, taskId);
      if (!['approve', 'approve_all', 'deny'].includes(decision)) throw fail(400, 'Unknown decision');
      if (typeof approvalId !== 'string' || !approvalId) throw fail(400, 'Which approval is this answer for?');
      const waiting = pending.get(approvalId);
      if (!waiting || waiting.taskId !== taskId) {
        const wasExpired = expired.has(approvalId) && expired.get(approvalId) > now();
        throw fail(409, wasExpired
          ? 'This approval expired before anyone answered it.'
          : 'That approval is no longer waiting.');
      }
      waiting.decide(decision === 'deny' ? 'deny' : 'approve');
      return { ok: true };
    },
    /** Ends the task cleanly, with whatever result the caller has to report. */
    finish(workspace, project, taskId, result = null) {
      const job = owned(workspace, project, taskId);
      if (job.status !== 'running' && job.status !== 'waiting_approval') throw fail(409, 'This task is not running.');
      if (result !== null && result !== undefined && Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) {
        throw fail(413, 'That result is too large to record.');
      }
      const s = sessions.get(taskId);
      if (!s) throw fail(409, 'This task is not open for actions.');
      s.enqueue({ finish: true, result });
      return { ok: true };
    },
    cancel(workspace, project, taskId) {
      owned(workspace, project, taskId);
      // Refuse anything still waiting first, so a cancelled task never leaves a card that could
      // later be answered into an action.
      for (const waiting of pendingAll(taskId)) waiting.decide('aborted');
      const { jobs } = storeFor(workspace);
      jobs.cancel(taskId);
      return view(jobs.get(taskId), null);
    },
  };
}

module.exports = { createBrowserService, view, parseDomains, APPROVAL_TIMEOUT_MS, IDLE_TIMEOUT_MS, TIMEOUT_REASON };
