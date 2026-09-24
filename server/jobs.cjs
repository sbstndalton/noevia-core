'use strict';
// Durable work primitive (spec-agent-execution §4): append-only events per job in the
// tenant's directory, state derived from events, restart recovery, cancellation, and
// capability sets fixed at creation. No scheduler; callers run the work in-process.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { boundCodePlan } = require('./code-plan.cjs');
const MAX_ASSISTANT_OUTPUT_BYTES = 32 * 1024;
const MAX_ASSISTANT_OUTPUT_EVENT_BYTES = 1024, MAX_ASSISTANT_OUTPUT_EVENTS = 64;

const TYPES = new Set(['job.created', 'job.started', 'step.started', 'step.completed', 'progress', 'approval.requested',
  'approval.decided', 'tool.started', 'tool.completed', 'tool.uncertain', 'artifact.created', 'checkpoint.created',
  'job.completed', 'job.failed', 'job.cancelled', 'job.interrupted', 'plan.proposed', 'plan.edited', 'plan.skipped', 'assistant.output']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function derive(events) {
  const job = { id: null, kind: null, projectId: null, parentId: null, capabilities: [], status: 'queued', stage: null,
    steps: [], artifacts: [], plan: null, assistantOutput: null, checkpoint: null, pendingApproval: null, uncertain: [], result: null, error: null, createdAt: null, updatedAt: null };
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
      case 'plan.proposed': case 'plan.edited': job.plan = job.kind === 'code'
        ? { status: e.type.slice(5), question: null, ...boundCodePlan(d) }
        : { status: e.type.slice(5), question: d.question ?? null, subQuestions: d.subQuestions || [] }; break;
      case 'plan.skipped': job.plan = job.kind === 'code'
        ? { status: 'skipped', question: null, subQuestions: [], truncated: false }
        : { status: 'skipped', question: d.question ?? null, subQuestions: [] }; break;
      case 'assistant.output': {
        const previous = job.assistantOutput || { text: '', truncated: false };
        const incoming = typeof d.text === 'string' ? d.text : '';
        const remaining = MAX_ASSISTANT_OUTPUT_BYTES - Buffer.byteLength(previous.text);
        const text = previous.truncated ? '' : clipUtf8(incoming, remaining);
        if (text || d.truncated === true || previous.text) job.assistantOutput = {
          text: previous.text + text,
          truncated: previous.truncated || d.truncated === true || text.length < incoming.length,
        };
        break;
      }
      case 'checkpoint.created': job.checkpoint = d; break;
      case 'job.completed': job.status = 'completed'; job.result = d.result ?? null; job.pendingApproval = null; break;
      case 'job.failed': job.status = 'failed'; job.error = d.error ?? 'failed'; job.result = d.result ?? null; job.pendingApproval = null; break;
      case 'job.cancelled': job.status = 'cancelled'; job.result = d.result ?? null; job.pendingApproval = null; break;
      case 'job.interrupted': job.status = 'interrupted'; job.error = d.reason ?? 'interrupted'; job.pendingApproval = null; break;
      default: break;
    }
  }
  return job;
}

function clipUtf8(text, maxBytes) {
  if (maxBytes <= 0) return '';
  let clipped = '', bytes = 0;
  for (const unit of text) {
    const char = /^[\uD800-\uDFFF]$/.test(unit) ? '\uFFFD' : unit;
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    clipped += char; bytes += size;
  }
  return clipped;
}

// `kinds` scopes retention: stores sharing one jobs/ directory each prune only their own kinds.
function createJobs({ dir, now = Date.now, retainMs = 7 * 86400000, maxJobs = 200, kinds = null, durable = false } = {}) {
  const root = path.join(dir, 'jobs');
  const controllers = new Map();
  const file = (id) => {
    if (!/^[0-9a-f-]{36}$/.test(String(id))) throw Object.assign(Error('Invalid job id'), { status: 400 });
    return path.join(root, id + '.jsonl');
  };
  function events(id) {
    let raw;
    try {
      raw = fs.readFileSync(file(id), 'utf8');
    } catch (e) {
      if (e.status) throw e;
      if (e.code === 'ENOENT') return [];
      throw Object.assign(Error('Unreadable job journal; review required', { cause: e }), { status: 409 });
    }
    const lines = raw.split('\n').filter(Boolean);
    try {
      const rows = [];
      for (const [i, line] of lines.entries()) {
        try {
          rows.push(JSON.parse(line));
        } catch (e) {
          // Tolerate a torn last line left by a crash mid-write, but only for journals
          // that don't hash-chain their events: a durable (e.g. chat-turns tool-call)
          // journal must fail closed on any unreadable tail rather than silently resume
          // with the last recorded event possibly missing its effect.
          const hashChained = rows[0]?.hash || (durable && (!kinds || kinds.includes(rows[0]?.data?.kind)));
          if (i === lines.length - 1 && !hashChained) break;
          throw e;
        }
      }
      let previous = null;
      for (const [i, row] of rows.entries()) {
        if (rows[0]?.hash || row.hash || (durable && (!kinds || kinds.includes(rows[0]?.data?.kind)))) {
          const { hash, ...payload } = row;
          if (row.job !== id || row.seq !== i + 1 || row.previous !== previous ||
              hash !== crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')) throw Error('Invalid journal chain');
          previous = hash;
        }
      }
      return rows;
    } catch (e) {
      if (e.status) throw e;
      // Never turn corruption into an empty journal and replay uncertain effects.
      throw Object.assign(Error('Unreadable job journal; review required', { cause: e }), { status: 409 });
    }
  }

  function append(id, type, data = {}) {
    if (!TYPES.has(type)) throw Error(`Unknown job event type: ${type}`);
    const current = events(id);
    if (!current.length && type !== 'job.created') throw Object.assign(Error('No such job'), { status: 404 });
    // One exception: a partial result the user explicitly saves after a cancel is recorded on the
    // cancelled job (spec-deep-research §4 — never saved automatically).
    const finished = current.length ? derive(current) : null;
    if (finished && TERMINAL.has(finished.status) && !(type === 'artifact.created' && finished.status === 'cancelled')) throw Object.assign(Error('Job already finished'), { status: 409 });
    if (type === 'assistant.output') {
      if (finished?.kind !== 'code') throw Error('Assistant output belongs to Code jobs');
      if (current.filter((row) => row.type === type).length >= MAX_ASSISTANT_OUTPUT_EVENTS) throw Error('Assistant output event limit reached');
      const incoming = typeof data.text === 'string' ? data.text : '';
      const text = clipUtf8(incoming, MAX_ASSISTANT_OUTPUT_EVENT_BYTES);
      data = { text, truncated: data.truncated === true || text.length < incoming.length };
    }
    if (finished?.kind === 'code' && (type === 'plan.proposed' || type === 'plan.edited' || type === 'plan.skipped')) {
      data = type === 'plan.skipped'
        ? { question: null, subQuestions: [], truncated: false }
        : { question: null, ...boundCodePlan(data) };
    }
    const event = { job: id, seq: current.length + 1, type, at: now(), data };
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const sync = durable || current[0]?.hash;
    if (sync) {
      event.previous = current.at(-1)?.hash || null;
      event.hash = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
    }
    const fd = fs.openSync(file(id), 'a', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(event) + '\n'); if (sync) fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (sync) {
      const directory = fs.openSync(root, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    return event;
  }
  function get(id) { const e = events(id); return e.length ? derive(e) : null; }
  function ids() { try { return fs.readdirSync(root).filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -6)); } catch { return []; } }
  const warnedUnreadable = new Set();
  // A single corrupt or torn-mid-line journal must never take down reads of every other
  // job sharing the directory (recover/prune/list all enumerate every file up front).
  function getSafe(id) {
    try {
      return { job: get(id) };
    } catch (e) {
      if (e.status !== 409) throw e;
      const p = file(id);
      if (!warnedUnreadable.has(p)) { warnedUnreadable.add(p); console.error(`[jobs] unreadable job journal, skipping: ${p}: ${e.message}`); }
      return { unreadable: true };
    }
  }
  function list({ projectId, kind, active } = {}) {
    const out = [];
    for (const id of ids()) {
      const { job, unreadable } = getSafe(id);
      if (unreadable) { out.push({ id, status: 'unreadable' }); continue; }
      if (!job) continue;
      if ((projectId === undefined || job.projectId === projectId) && (!kind || job.kind === kind) && (active === undefined || active === !TERMINAL.has(job.status))) out.push(job);
    }
    return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
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
      id,
      signal: controller.signal,
      event: (type, data) => append(id, type, data),
      progress: (stage) => { if (!controller.signal.aborted) append(id, 'progress', { stage }); },
      checkpoint: (data) => append(id, 'checkpoint.created', data),
      artifact: (data) => append(id, 'artifact.created', data),
      uncertain: (data) => append(id, 'tool.uncertain', data),
    };
    try {
      const result = await work(ctx);
      if (controller.signal.aborted) append(id, 'job.cancelled', result === undefined ? {} : { result });
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
      const { job, unreadable } = getSafe(id);
      if (unreadable) continue; // leave it for manual review; never delete silently
      if (!job || TERMINAL.has(job.status) || controllers.has(id) || (kinds && !kinds.includes(job.kind))) continue;
      append(id, 'job.interrupted', { reason: job.status === 'waiting_approval' ? 'The server restarted while waiting for approval; start again to be asked again.' : 'The server restarted before this finished.' });
      count++;
    }
    return count;
  }
  function prune() {
    const all = [];
    for (const id of ids()) {
      const { job, unreadable } = getSafe(id);
      if (unreadable) continue; // leave it for manual review; never delete silently
      if (job) all.push(job);
    }
    const done = all.filter((j) => TERMINAL.has(j.status) && (!kinds || kinds.includes(j.kind))).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const [i, j] of done.entries()) if (now() - j.updatedAt > retainMs || i >= maxJobs) fs.rmSync(file(j.id), { force: true });
  }
  return { create, run, append, get, list, cancel, recover, can, prune };
}

module.exports = { createJobs, derive, TYPES, MAX_ASSISTANT_OUTPUT_BYTES, MAX_ASSISTANT_OUTPUT_EVENTS };
