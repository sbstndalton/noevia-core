'use strict';
// Durable work primitive (spec-agent-execution §4): append-only events per job in the
// tenant's directory, state derived from events, restart recovery, cancellation, and
// capability sets fixed at creation. No scheduler; callers run the work in-process.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { boundCodePlan } = require('./code-plan.cjs');
const { boundReviewEvent } = require('./code-review-verdict.cjs');
const taskLifecycle = require('./task-lifecycle.cjs');
const { buildCompletenessReport, canEnterReviewing, reportHash } = require('./completeness-report.cjs');
const MAX_ASSISTANT_OUTPUT_BYTES = 32 * 1024;
const MAX_ASSISTANT_OUTPUT_EVENT_BYTES = 1024, MAX_ASSISTANT_OUTPUT_EVENTS = 64;

const TYPES = new Set(['job.created', 'job.started', 'step.started', 'step.completed', 'progress', 'approval.requested',
  'approval.decided', 'tool.started', 'tool.completed', 'tool.uncertain', 'artifact.created', 'checkpoint.created',
  'job.completed', 'job.failed', 'job.cancelled', 'job.interrupted', 'plan.proposed', 'plan.edited', 'plan.skipped', 'assistant.output',
  // Planner review of a finished Code change (#519, code-review.cjs). Appended only by the
  // harness's own review gate, never from agent or reviewer output; task-lifecycle.cjs treats
  // them as no-ops, so a model verdict carries no lifecycle authority.
  'review.requested', 'review.completed', 'review.failed',
  // Lifecycle authority for Code tasks (#701): append() refuses both unless the caller presents
  // LIFECYCLE_AUTHORITY, so the ACP session's ctx.event, an approval payload or a job result can
  // never write one. See task-lifecycle.cjs for how they fold.
  'task.stage', 'task.revision']);
const REVIEW_TYPES = new Set(['review.requested', 'review.completed', 'review.failed']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const AUTHORITY_TYPES = taskLifecycle.AUTHORITY_TYPES;
const MAX_STAGE_EVENTS = 64, MAX_REVISIONS = 32, MAX_STAGE_REASON = 300, MAX_EXPECTED_ARTIFACTS = 32;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, CONTENT_HASH = /^[0-9a-f]{64}$/;

// The lifecycle capability token (#701). Module-private: it is never exported, never written to
// a journal (a Symbol does not survive JSON, so no event, approval card or result can carry it)
// and handed out exactly once per process, to the pipeline that claims it first. Any other
// caller, including the harness that holds the same job store, cannot produce it.
const LIFECYCLE_AUTHORITY = Symbol('noevia.task-lifecycle-authority');
let authorityClaimed = false;
function claimLifecycleAuthority() {
  if (authorityClaimed) throw Error('Task lifecycle authority was already claimed in this process');
  authorityClaimed = true;
  return LIFECYCLE_AUTHORITY;
}

// The journal fold, one event at a time (#1126). derive() folds a whole journal through this
// accumulator; createJobs keeps one per cached journal and folds only each event it appends, so an
// append no longer re-folds the whole journal. `authoritative` is decided by the whole journal (see
// the comment on the fold rules in foldEvent), so an accumulator that sees its first authority event
// is rebuilt from the journal rather than advanced.
function newAccumulator(authoritative) {
  return {
    authoritative, count: 0, revision: null, stages: [],
    job: { id: null, kind: null, projectId: null, parentId: null, capabilities: [], status: 'queued', stage: null,
      steps: [], artifacts: [], plan: null, assistantOutput: null, checkpoint: null, pendingApproval: null, uncertain: [], result: null, error: null, createdAt: null, updatedAt: null,
      lifecycle: null },
    // Folded alongside the switch below in the same single pass over `events`, rather than
    // re-reading the whole journal a second time after the loop: `lifecycleState` only advances
    // while `lifecycleOk` stays true, and one illegal jump (a journal never shaped with this
    // layer in mind) just stops the fold there — the rest of the fold is unaffected.
    lifecycleState: taskLifecycle.INITIAL_STATE, lifecycleOk: true,
    // A journal with any lifecycle authority event folds authoritatively throughout (#701), and
    // only such a journal gains `revision`/`stages`: every other derived job keeps its exact shape.
    fold: { authoritative },
  };
}
function foldEvent(acc, e) {
  const job = acc.job, d = e.data || {}, authoritative = acc.authoritative;
  job.updatedAt = e.at;
  if (acc.lifecycleOk) {
    try { acc.lifecycleState = taskLifecycle.step(acc.lifecycleState, e, acc.fold); }
    catch (err) { if (err instanceof taskLifecycle.TaskLifecycleError) acc.lifecycleOk = false; else throw err; }
  }
  switch (e.type) {
    case 'job.created': Object.assign(job, { id: e.job, kind: d.kind, projectId: d.projectId ?? null, parentId: d.parentId ?? null, capabilities: d.capabilities || [], createdAt: e.at }); break;
    case 'job.started': job.status = 'running'; break;
    case 'progress': job.stage = d.stage ?? job.stage; break;
    case 'step.started': job.steps.push({ id: d.id, title: d.title, status: 'running' }); break;
    // In a pipeline journal (#705, authoritative) a step id recurs once per revision (`tests`), so a
    // completion closes the latest one still running. Every other journal keeps the original rule:
    // the first step with that id.
    case 'step.completed': { const s = (authoritative && job.steps.findLast((x) => x.id === d.id && x.status === 'running')) || job.steps.find((x) => x.id === d.id); if (s) s.status = d.failed ? 'failed' : 'completed'; break; }
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
    // Only a job that was reviewed ever carries `review`: every other job's derived shape,
    // and so every API response built from it, is exactly what it was before #519.
    case 'review.requested': case 'review.completed': case 'review.failed':
      job.review = boundReviewEvent(e.type, d); break;
    case 'task.stage': if (d.revision !== (acc.revision?.n ?? 0)) acc.lifecycleOk = false; acc.stages.push({ from: d.from ?? null, to: d.to ?? null, revision: d.revision ?? 0, reason: d.reason ?? null,
      ...(d.reportHash ? { reportHash: d.reportHash } : {}), at: e.at }); break;
    case 'task.revision': if (d.n !== (acc.revision?.n ?? 0) + 1) acc.lifecycleOk = false; acc.revision = { n: d.n, headSha: d.headSha ?? null, planHash: d.planHash ?? null, at: e.at }; break;
    case 'job.completed': job.status = 'completed'; job.result = d.result ?? null; job.pendingApproval = null; break;
    case 'job.failed': job.status = 'failed'; job.error = d.error ?? 'failed'; job.result = d.result ?? null; job.pendingApproval = null; break;
    case 'job.cancelled': job.status = 'cancelled'; job.result = d.result ?? null; job.pendingApproval = null; break;
    case 'job.interrupted': job.status = 'interrupted'; job.error = d.reason ?? 'interrupted'; job.pendingApproval = null; break;
    default: break;
  }
  acc.count++;
}
// The job as the accumulator stands: a fresh object, so a caller cannot alter the accumulator.
function snapshot(acc) {
  const job = { ...acc.job };
  if (acc.authoritative) Object.assign(job, { revision: acc.revision, stages: acc.stages });
  return job;
}
function buildAccumulator(events) {
  const acc = newAccumulator(taskLifecycle.isAuthoritative(events));
  for (const e of events) foldEvent(acc, e);
  return acc;
}
// Additive, read-only: a coarser vision-layer state (#512), folded in the same pass. Never affects
// `job.status` or any other field, and never throws — an event sequence this layer can't make sense
// of just yields `null`. The Rust port (TASK_LIFECYCLE_IMPL, retired in #1071) folds the same journal
// too; any disagreement or fault also yields `null`. Only get() and the job reads it serves compute
// this confirmation; append() folds without it (#1126).
function derive(events) {
  const acc = buildAccumulator(events);
  const job = snapshot(acc);
  job.lifecycle = acc.lifecycleOk ? taskLifecycle.confirmFold(events, acc.lifecycleState, acc.fold) : null;
  // snapshot() is shallow, and the fold points into the events' own data (the pending approval, the result,
  // the artifacts). A caller that edited what get() returned would edit the cached journal, which would then
  // differ from the file; the approval card depends on these not changing (#1590). So the job is a copy.
  return structuredClone(job);
}

const lifecycleConflict = (message) => Object.assign(Error(message), { status: 409 });

// Validates a lifecycle authority event against the journal it would join and rebuilds its data
// from known fields only. Holding the token proves who is writing, not that the move is sound:
// a stale `from` or revision, an illegal transition, or a journal whose completeness report does
// not allow review is refused here, before anything is written. That report is built here, from
// the journal itself: a caller-supplied `report` is ignored, and the caller may only name the
// artifacts it expects (`expectedArtifacts`, a short list of names).
//
// Once the job has ended nothing more is accepted (append()'s terminal rule): a task blocked by a
// restart, failure or cancel is not resumed — the pipeline starts a new job for it. Only a live
// job can go `blocked → implementing`.
function boundAuthorityEvent(id, type, data, current, known) {
  const raw = data && typeof data === 'object' ? data : {};
  let state;
  try { state = taskLifecycle.foldEvents(current, taskLifecycle.INITIAL_STATE, { authoritative: true }); }
  catch (error) {
    // A Rust-confirmation refusal (impl_refused / impl_mismatch) says nothing about the journal
    // itself (#1127).
    if (error instanceof taskLifecycle.TaskLifecycleError) {
      throw lifecycleConflict(String(error.code || '').startsWith('impl_')
        ? 'This task’s lifecycle could not be verified; review required'
        : 'This task’s lifecycle journal is inconsistent; review required');
    }
    throw error;
  }
  const revision = known.revision?.n ?? 0;
  if (type === 'task.revision') {
    if (current.filter((row) => row.type === type).length >= MAX_REVISIONS) throw lifecycleConflict('Task revision limit reached');
    if (raw.n !== revision + 1) throw lifecycleConflict(`Stale task revision: expected ${revision + 1}`);
    if (typeof raw.headSha !== 'string' || !GIT_SHA.test(raw.headSha)) throw Object.assign(Error('A task revision needs the full head commit SHA'), { status: 400 });
    if (raw.planHash != null && (typeof raw.planHash !== 'string' || !CONTENT_HASH.test(raw.planHash))) throw Object.assign(Error('A plan hash is a sha256 hex digest'), { status: 400 });
    return { n: raw.n, headSha: raw.headSha, planHash: raw.planHash ?? null };
  }
  if (current.filter((row) => row.type === type).length >= MAX_STAGE_EVENTS) throw lifecycleConflict('Task stage limit reached');
  if (!taskLifecycle.STATES.includes(raw.to)) throw Object.assign(Error(`Unknown task stage: ${JSON.stringify(raw.to)}`), { status: 400 });
  if (raw.from !== state) throw lifecycleConflict(`Stale task stage: the task is ${state}`);
  if (raw.revision !== revision) throw lifecycleConflict(`Stale task revision: the task is at revision ${revision}`);
  taskLifecycle.assertStageMove(state, raw.to); // throws TaskLifecycleError (409) on an illegal move
  const out = { from: state, to: raw.to, revision,
    reason: typeof raw.reason === 'string' ? raw.reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_STAGE_REASON) || null : null };
  if (raw.to === 'reviewing' && state !== 'reviewing') {
    const expected = raw.expectedArtifacts;
    if (expected != null && (!Array.isArray(expected) || expected.length > MAX_EXPECTED_ARTIFACTS
      || !expected.every((n) => typeof n === 'string' && n.length > 0 && n.length <= 200))) {
      throw Object.assign(Error('expectedArtifacts is a short list of artifact names'), { status: 400 });
    }
    const report = buildCompletenessReport({ job: { ...revisionWindow(current, known), id }, expectedArtifacts: expected ?? null });
    if (!canEnterReviewing(report)) {
      const open = report.checks.filter((c) => c.status !== 'pass').map((c) => `${c.name}: ${c.status}`);
      if (report.unverified) open.push(`unverified: ${report.unverified}`); // the Rust confirmation (COMPLETENESS_REPORT_IMPL, retired)
      throw lifecycleConflict(`The completeness report does not allow review (${open.join('; ')})`);
    }
    out.reportHash = reportHash(report);
  }
  return out;
}

// The evidence a move into `reviewing` is judged on is the CURRENT round's (#705): the steps and
// artifacts recorded since the task last entered `implementing`. A test run that failed in an
// earlier revision is that revision's evidence, not this one's — and a passing one from an earlier
// revision does not vouch for this head either. Everything else (plan, checkpoint, uncertainty,
// a pending approval) is still the whole job's. A journal that never entered `implementing` is
// judged whole, exactly as before.
function revisionWindow(current, known) {
  let since = -1;
  for (let i = current.length - 1; i >= 0; i--) {
    if (current[i].type === 'task.stage' && current[i].data?.to === 'implementing') { since = i; break; }
  }
  if (since < 0) return known;
  const window = derive([current[0], ...current.slice(since + 1)]);
  return { ...known, steps: window.steps, artifacts: window.artifacts };
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
function createJobs({ dir, now = Date.now, retainMs = 7 * 86400000, maxJobs = 200, kinds = null, durable = false, assertActive = () => {} } = {}) {
  const root = path.join(dir, 'jobs');
  const controllers = new Map();
  const file = (id) => {
    if (!/^[0-9a-f-]{36}$/.test(String(id))) throw Object.assign(Error('Invalid job id'), { status: 400 });
    return path.join(root, id + '.jsonl');
  };
  // #1126: the parsed journal of each job this process has read or written, kept while the file's
  // size, mtime and inode still match what was last read or written here. Appends (this process is the
  // only writer) extend it and its fold; any other change to the file misses the cache and re-reads it,
  // so the hash chain and every fault are still checked whenever the bytes on disk change.
  const cache = new Map();
  const CACHE_LIMIT = 64;
  const stampOf = (stat) => (stat ? { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino } : null);
  const sameStamp = (a, b) => !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
  function remember(id, entry) {
    cache.delete(id);
    cache.set(id, entry);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  function events(id) {
    const p = file(id);
    let stamp = null;
    try { stamp = stampOf(fs.statSync(p)); } catch { stamp = null; }
    const hit = cache.get(id);
    if (stamp && hit && sameStamp(hit.stamp, stamp)) return hit.events;
    cache.delete(id);
    const rows = readJournal(id);
    if (stamp) remember(id, { stamp, events: rows, acc: null });
    return rows;
  }
  function readJournal(id) {
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
          // that don't hash-chain their events: a durable (hash-chained)
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

  // `authority` is only ever read for the lifecycle authority types; see claimLifecycleAuthority.
  function append(id, type, data = {}, authority = undefined) {
    assertActive();
    if (!TYPES.has(type)) throw Error(`Unknown job event type: ${type}`);
    const lifecycleEvent = AUTHORITY_TYPES.has(type);
    if (lifecycleEvent && authority !== LIFECYCLE_AUTHORITY) throw Object.assign(Error('Task lifecycle events are server-only'), { status: 403 });
    const current = events(id);
    if (!current.length && type !== 'job.created') throw Object.assign(Error('No such job'), { status: 404 });
    // One exception: a partial result the user explicitly saves after a cancel is recorded on the
    // cancelled job (spec-deep-research §4 — never saved automatically). Deep research keeps its own
    // journal on the Rust front (#2218); the retry save of a failed report is no longer this store's.
    const finished = current.length ? foldedJob(id, current) : null;
    const lateArtifact = type === 'artifact.created' && finished && finished.status === 'cancelled';
    if (finished && TERMINAL.has(finished.status) && !lateArtifact) throw Object.assign(Error('Job already finished'), { status: 409 });
    if (type === 'assistant.output') {
      if (finished?.kind !== 'code') throw Error('Assistant output belongs to Code jobs');
      if (current.filter((row) => row.type === type).length >= MAX_ASSISTANT_OUTPUT_EVENTS) throw Error('Assistant output event limit reached');
      const incoming = typeof data.text === 'string' ? data.text : '';
      const text = clipUtf8(incoming, MAX_ASSISTANT_OUTPUT_EVENT_BYTES);
      data = { text, truncated: data.truncated === true || text.length < incoming.length };
    }
    if (lifecycleEvent) {
      if (finished?.kind !== 'code') throw Error('Task lifecycle events belong to Code jobs');
      data = boundAuthorityEvent(id, type, data, current, finished);
    }
    if (REVIEW_TYPES.has(type)) {
      if (finished?.kind !== 'code') throw Error('Reviews belong to Code jobs');
      data = boundReviewEvent(type, data);
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
    const line = JSON.stringify(event);
    const fd = fs.openSync(file(id), 'a+', 0o600);
    let written = null;
    try {
      // #1590: a crash mid-write can leave a last line with no newline. Readers drop it, but writing after it
      // would glue this event onto the fragment and the journal would read as unreadable after a restart.
      // Cut the file back to its last complete line first.
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) {
          const whole = fs.readFileSync(file(id));
          fs.ftruncateSync(fd, whole.lastIndexOf(0x0a) + 1);
        }
      }
      fs.writeFileSync(fd, line + '\n'); if (sync) fs.fsyncSync(fd); written = stampOf(fs.fstatSync(fd));
    }
    finally { fs.closeSync(fd); }
    if (sync) {
      const directory = fs.openSync(root, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    // The cached journal is `current` (read or written here moments ago); extend it with this event.
    const entry = cache.get(id);
    if (entry && entry.events === current && written) {
      // The cache holds its own copy of what was written, never the caller's objects (#1590).
      current.push(JSON.parse(line));
      entry.stamp = written;
      if (entry.acc && !(!entry.acc.authoritative && AUTHORITY_TYPES.has(type))) foldEvent(entry.acc, event);
      else entry.acc = null;
    }
    return event;
  }
  // The job as the journal stands, for append()'s own checks: the cached fold when there is one, else
  // a fold of `current` (kept for the next append). It skips the lifecycle confirmation get() makes.
  function foldedJob(id, current) {
    const entry = cache.get(id);
    if (!entry || entry.events !== current) return snapshot(buildAccumulator(current));
    if (!entry.acc) entry.acc = buildAccumulator(current);
    return snapshot(entry.acc);
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
  // #1391: the enumeration a release idle gate can trust. Only an absent jobs directory is "no
  // jobs"; anything else that cannot be read exactly (an unreadable, symlinked or non-directory
  // root, a journal that is not a regular file, more than `cap` entries) is refused, never empty.
  function strictIds(cap) {
    const refuse = (why) => { throw Object.assign(Error(`Job state unknown: ${why}`), { code: 'JOBS_UNKNOWN', status: 503 }); };
    let st;
    try { st = fs.lstatSync(root); } catch (e) { if (e.code === 'ENOENT') return []; refuse(`jobs directory (${e.code || 'error'})`); }
    if (!st.isDirectory()) refuse('the jobs path is not a plain directory');
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { refuse(`jobs directory (${e.code || 'error'})`); }
    if (entries.length > cap) refuse(`more than ${cap} entries`);
    const out = [];
    for (const d of entries) {
      if (!d.name.endsWith('.jsonl')) continue;
      if (!d.isFile()) refuse('a job journal that is not a regular file');
      if (!/^[0-9a-f-]{36}$/.test(d.name.slice(0, -6))) refuse('a job journal whose name is not a job id');
      out.push(d.name.slice(0, -6));
    }
    return out;
  }
  function list({ projectId, kind, active, strict = false, cap = 4096 } = {}) {
    const out = [];
    for (const id of strict ? strictIds(cap) : ids()) {
      const { job, unreadable } = getSafe(id);
      if (unreadable && strict) throw Object.assign(Error('Job state unknown: an unreadable job journal'), { code: 'JOBS_UNKNOWN', status: 503 });
      if (unreadable) { out.push({ id, status: 'unreadable' }); continue; }
      if (!job && strict) {
        // #1391: a journal that exists but yields no events (0 bytes, or one torn line) is unknown
        // state, not "no job". Only a journal removed since the directory read is skipped.
        let exists = true;
        try { fs.statSync(file(id)); } catch (e) { if (e.code === 'ENOENT') exists = false; }
        if (exists) throw Object.assign(Error('Job state unknown: a job journal with no readable events'), { code: 'JOBS_UNKNOWN', status: 503 });
      }
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
    // A second run() of a live id would replace the first run's controller, and the first
    // run's finally would then delete the second's: cancel would miss it and the final
    // write would race. Refuse it before touching the journal.
    if (controllers.has(id)) throw Object.assign(Error('This job is already running'), { status: 409 });
    const controller = new AbortController();
    // append() must succeed (job not finished, journal writable) before this job is
    // considered "running" — if it throws (409 on an already-finished job, disk full),
    // controllers must not hold an entry for it, otherwise callers relying on the
    // controllers map to know a job is live (code-harness egress revoke, worktree
    // release, research controllers cleanup) never get to run their cleanup.
    append(id, 'job.started');
    const ctx = {
      id,
      signal: controller.signal,
      // Two arguments, never more: whatever the work passes, it cannot hand append() authority.
      event: (type, data) => append(id, type, data),
      progress: (stage) => { if (!controller.signal.aborted) append(id, 'progress', { stage }); },
      checkpoint: (data) => append(id, 'checkpoint.created', data),
      artifact: (data) => append(id, 'artifact.created', data),
      uncertain: (data) => append(id, 'tool.uncertain', data),
    };
    try {
      controllers.set(id, controller);
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
    for (const [i, j] of done.entries()) if (now() - j.updatedAt > retainMs || i >= maxJobs) { fs.rmSync(file(j.id), { force: true }); cache.delete(j.id); }
  }
  return { create, run, append, get, list, cancel, recover, can, prune };
}

module.exports = { createJobs, derive, claimLifecycleAuthority, TYPES, MAX_ASSISTANT_OUTPUT_BYTES, MAX_ASSISTANT_OUTPUT_EVENTS,
  // The fold one event at a time (#1126): derive() is this, applied to a whole journal.
  journalFold: { newAccumulator, foldEvent, snapshot, buildAccumulator } };
