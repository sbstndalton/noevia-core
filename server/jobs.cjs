'use strict';
// Durable work primitive (spec-agent-execution §4): append-only events per job in the
// tenant's directory, state derived from events, restart recovery, cancellation, and
// capability sets fixed at creation. No scheduler; callers run the work in-process.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

const TYPES = new Set(['job.created', 'job.started', 'step.started', 'step.completed', 'progress', 'approval.requested',
  'approval.decided', 'tool.started', 'tool.completed', 'tool.uncertain', 'artifact.created', 'checkpoint.created',
  'job.completed', 'job.failed', 'job.cancelled', 'job.interrupted']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function derive(events) {
  const job = { id: null, kind: null, projectId: null, parentId: null, capabilities: [], status: 'queued', stage: null,
    steps: [], artifacts: [], checkpoint: null, pendingApproval: null, uncertain: [], result: null, error: null, createdAt: null, updatedAt: null };
  for (const e of events) {
    job.updatedAt = e.at;
    const d = e.data || {};
    switch (e.type) {
      case 'job.created': Object.assign(job, { id: e.job, kind: d.kind, projectId: d.projectId ?? null, parentId: d.parentId ?? null, capabilities: d.capabilities || [], createdAt: e.at }); break;
      case 'job.started': job.status = 'running'; break;
      case 'progress': job.stage = d.stage ?? job.stage; break;
      case 'step.started': job.steps.push({ id: d.id, title: d.title, status: 'running' }); break;
      case 'step.completed': { const s = job.steps.find((x) => x.id === d.id); if (s) s.status = d.failed ? 'failed' : 'completed'; break; }
      case 'approval.requested': job.pendingApproval = d; job.status = 'waiting_approval'; break;
      case 'approval.decided': job.pendingApproval = null; if (!TERMINAL.has(job.status)) job.status = 'running'; break;
      case 'tool.uncertain': job.uncertain.push(d); break;
      case 'artifact.created': job.artifacts.push(d); break;
      case 'checkpoint.created': job.checkpoint = d; break;
      case 'job.completed': job.status = 'completed'; job.result = d.result ?? null; job.pendingApproval = null; break;
      case 'job.failed': job.status = 'failed'; job.error = d.error ?? 'failed'; job.result = d.result ?? null; job.pendingApproval = null; break;
      case 'job.cancelled': job.status = 'cancelled'; job.pendingApproval = null; break;
      case 'job.interrupted': job.status = 'interrupted'; job.error = d.reason ?? 'interrupted'; job.pendingApproval = null; break;
      default: break;
    }
  }
  return job;
}

// `kinds` scopes retention: stores sharing one jobs/ directory each prune only their own kinds.
function createJobs({ dir, now = Date.now, retainMs = 7 * 86400000, maxJobs = 200, kinds = null } = {}) {
  const root = path.join(dir, 'jobs');
  const controllers = new Map();
  const file = (id) => {
    if (!/^[0-9a-f-]{36}$/.test(String(id))) throw Object.assign(Error('Invalid job id'), { status: 400 });
    return path.join(root, id + '.jsonl');
  };
  function events(id) {
    try { return fs.readFileSync(file(id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
    catch (e) { if (e.status) throw e; return []; }
  }
  function append(id, type, data = {}) {
    if (!TYPES.has(type)) throw Error(`Unknown job event type: ${type}`);
    const current = events(id);
    if (!current.length && type !== 'job.created') throw Object.assign(Error('No such job'), { status: 404 });
    if (current.length && TERMINAL.has(derive(current).status)) throw Object.assign(Error('Job already finished'), { status: 409 });
    const event = { job: id, seq: current.length + 1, type, at: now(), data };
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file(id), JSON.stringify(event) + '\n', { mode: 0o600 });
    return event;
  }
  function get(id) { const e = events(id); return e.length ? derive(e) : null; }
  function ids() { try { return fs.readdirSync(root).filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -6)); } catch { return []; } }
  function list({ projectId, kind, active } = {}) {
    return ids().map(get).filter(Boolean)
      .filter((j) => (projectId === undefined || j.projectId === projectId) && (!kind || j.kind === kind) && (active === undefined || active === !TERMINAL.has(j.status)))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  function create({ kind, projectId = null, parentId = null, capabilities = [] }) {
    if (!kind) throw Error('Job kind required');
    if (parentId) {
      const parent = get(parentId);
      if (!parent) throw Object.assign(Error('No such parent job'), { status: 404 });
      const extra = capabilities.filter((c) => !parent.capabilities.includes(c));
      if (extra.length) throw Object.assign(Error(`A child job cannot widen capabilities: ${extra.join(', ')}`), { status: 403 });
    }
    prune();
    const id = crypto.randomUUID();
    append(id, 'job.created', { kind, projectId, parentId, capabilities: [...new Set(capabilities)] });
    return id;
  }
  function can(id, capability) { return !!get(id)?.capabilities.includes(capability); }
  // Runs `work` for a created job. The job completes, fails or is cancelled exactly once.
  async function run(id, work) {
    const controller = new AbortController();
    controllers.set(id, controller);
    append(id, 'job.started');
    const ctx = {
      signal: controller.signal,
      progress: (stage) => { if (!controller.signal.aborted) append(id, 'progress', { stage }); },
      checkpoint: (data) => append(id, 'checkpoint.created', data),
      artifact: (data) => append(id, 'artifact.created', data),
      uncertain: (data) => append(id, 'tool.uncertain', data),
    };
    try {
      const result = await work(ctx);
      if (controller.signal.aborted) append(id, 'job.cancelled');
      else append(id, 'job.completed', { result });
    } catch (error) {
      if (controller.signal.aborted) append(id, 'job.cancelled');
      else append(id, 'job.failed', { error: String(error?.publicMessage || error?.message || 'failed').slice(0, 500), result: error?.result ?? null });
    } finally { controllers.delete(id); }
    return get(id);
  }
  function cancel(id) {
    const job = get(id);
    if (!job) return null;
    if (TERMINAL.has(job.status)) return job;
    const controller = controllers.get(id);
    if (controller) controller.abort(); else append(id, 'job.cancelled');
    return get(id);
  }
  // After a restart nothing is running in this process. Unfinished jobs are interrupted;
  // approvals are never silently resumed, and uncertain side effects stay listed.
  function recover() {
    let count = 0;
    for (const id of ids()) {
      const job = get(id);
      if (!job || TERMINAL.has(job.status) || controllers.has(id)) continue;
      append(id, 'job.interrupted', { reason: job.status === 'waiting_approval' ? 'The server restarted while waiting for approval; start again to be asked again.' : 'The server restarted before this finished.' });
      count++;
    }
    return count;
  }
  function prune() {
    const all = ids().map(get).filter(Boolean);
    const done = all.filter((j) => TERMINAL.has(j.status) && (!kinds || kinds.includes(j.kind))).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const [i, j] of done.entries()) if (now() - j.updatedAt > retainMs || i >= maxJobs) fs.rmSync(file(j.id), { force: true });
  }
  return { create, run, append, get, list, cancel, recover, can, prune };
}

module.exports = { createJobs, derive, TYPES };
