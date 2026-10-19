'use strict';
// Deterministic, model-free completeness auditor (#514, part of #511's fit-gap: "no
// completeness report"). Given a job's own derived shape (jobs.cjs `derive()`/`get()`), this
// module produces a structured report of named checks — each pass/fail/unknown with its
// evidence — and a pure guard, `canEnterReviewing()`, that a future reviewer/merge feature can
// consult before letting a task leave `implementing`/`verifying` for `reviewing` (see
// task-lifecycle.cjs).
//
// No models, no HTTP, no storage: pure functions over data the caller already has in hand.
//
// WARNING TO FUTURE AUTHORS (read before touching `tests-run`): do NOT correlate a
// `tool.started` event's agent-supplied `name`/`title`/`kind` to a later `tool.completed` by
// `id` to decide whether "tests" ran or passed. Both the `id` (the ACP protocol's own
// `toolCallId`) and the `name`/`title` on those events are supplied by the external agent the
// harness is running (code-harness.cjs:346 sets `tool.started`'s `name` straight from
// `update.title`), and `tool.completed`'s `failed`/`exitCode` (code-harness.cjs:357,
// code-meta.cjs's `readExitCode`) are the agent's own self-report of what its subprocess did —
// none of it is server-measured. An agent (or the model driving it) can report any exit code it
// likes for any command it likes; matching a "test-shaped" name to a "successful" exit code
// would launder that self-report into false proof of a real test run. `tests-run` below is
// therefore decided ONLY from (a) a `step.completed` for a closed, server-chosen set of
// test-step ids that only first-party harness code emits (the same trust boundary as
// code-harness.cjs's hardcoded `'harness.config'` step id — never a regex over agent text), or
// (b) a dedicated, explicitly-shaped test-report artifact a trusted measurement path emits.
// Neither exists in this codebase yet, so `tests-run` is honestly 'unknown' until one does —
// that is the correct, honest answer, not a bug to "fix" by reading tool.completed instead.
//
// Trust model (same "server-emitted event types only" boundary task-lifecycle.cjs's honesty
// constraint (#522) draws): every check below is decided from data jobs.cjs's own `derive()`
// already folds — `job.steps` (id/status from `step.started`/`step.completed`), `job.artifacts`
// (from `artifact.created`), `job.plan`, `job.checkpoint`, `job.uncertain`, and
// `job.pendingApproval`. No check here ever reads a free-form, caller-chosen key (e.g. a
// `testsPassed`, `review`, or `merged` flag) out of an event's `data` as proof of anything:
// `approval.requested`/`approval.decided`'s payload is the per-tool-call write-approval card,
// built by spreading page- or model-influenced content (browser-service.cjs's `{ ...card,
// jobId }`), and `job.completed`'s `result` is whatever the harness or model reported — neither
// is evidence of a real test run, review or merge, and a forged claim on either is inert here by
// construction (see the spoof-resistance tests). `tool.completed`'s `failed`/`exitCode` fields
// are excluded from every check for the same reason (see the warning above), even though they
// are "structured" fields on a server-appended event type: structure alone isn't trust when the
// content inside that structure is the agent's own self-report.
//
// This module deliberately does NOT change the derived lifecycle: `job.lifecycle` from
// jobs.cjs/task-lifecycle.cjs is unaffected by anything here, and `canEnterReviewing()` is a
// pure, read-only guard — nothing in this file appends an event, mutates `job`, or calls
// `transition()`. Since #701, jobs.cjs consults it before appending a `task.stage` into
// `reviewing` and records `reportHash(report)` on that event; nothing else calls it.

// Rust opcode 2 is the sole check/review policy. The host below retains only the generic
// hash codec, structural reply validation and unchanged opcode 1 representation comparison.
const crypto = require('node:crypto');

// Key-order-independent JSON: the same report always hashes the same, however it was built.
// Bounded: a cycle, very deep nesting or an oversized report is refused (409), never a crash.
const MAX_HASH_CHARS = 4 * 1024 * 1024, MAX_HASH_DEPTH = 64;
const unhashable = (why) => Object.assign(Error(`The completeness report cannot be hashed: ${why}`), { status: 409 });
function canonical(value, stack = new Set(), budget = { chars: 0 }) {
  let out;
  if (value && typeof value === 'object') {
    if (stack.has(value)) throw unhashable('it is circular');
    if (stack.size >= MAX_HASH_DEPTH) throw unhashable('it is nested too deeply');
    stack.add(value);
    out = Array.isArray(value)
      ? `[${value.map((v) => canonical(v === undefined ? null : v, stack, budget)).join(',')}]`
      : `{${Object.keys(value).filter((k) => value[k] !== undefined).sort()
        .map((k) => { budget.chars += k.length; return `${JSON.stringify(k)}:${canonical(value[k], stack, budget)}`; }).join(',')}}`;
    stack.delete(value);
  } else {
    out = typeof value === 'bigint' ? JSON.stringify(String(value)) : JSON.stringify(value) ?? 'null';
    budget.chars += out.length; // leaves only, so nesting is not counted twice
    if (budget.chars > MAX_HASH_CHARS) throw unhashable('it is too large');
  }
  return out;
}

// The hash a `task.stage` into `reviewing` records (#701): which report allowed the move.
function reportHash(report) {
  if (!report || typeof report !== 'object') throw Object.assign(Error('reportHash requires a report'), { status: 400 });
  return crypto.createHash('sha256').update(canonical(report)).digest('hex');
}


const {executePolicy}=require('./completeness-policy-host.cjs');
const defaultLoader=()=>require('./dav-parse-wasm.cjs');
const version=defaultLoader().completenessPolicy({version:true});
if(version?.version!==1||version.frameLimit!==65536||!Array.isArray(version.checks)||version.checks.length!==5||!Array.isArray(version.testStepIds)||version.testStepIds.length!==4||typeof version.testArtifactKind!=='string')throw Error('Required completeness policy capability missing');
const CHECK_NAMES=Object.freeze([...version.checks]);
const TEST_STEP_IDS=new Set(version.testStepIds);
const TEST_ARTIFACT_KIND=version.testArtifactKind;
const warnedPort=new Set();
function portWarn(event,reason){const key=`${event}:${reason}`;if(warnedPort.has(key))return;warnedPort.add(key);console.warn(`[completeness-report] ${event} (${reason}); the report is unverified`);}
const UNHASHABLE_REASONS = [['nested too deeply', 'deep'], ['too large', 'large']];
// What reportHash makes of the JS report: { text, hash } or { unhashable } (circular included).
function jsHashed(report) {
  try {
    const text = canonical(report);
    return { text, hash: crypto.createHash('sha256').update(text).digest('hex') };
  } catch (err) {
    const hit = UNHASHABLE_REASONS.find(([m]) => String(err?.message).includes(m));
    return { unhashable: hit ? hit[1] : 'circular' };
  }
}

function portAgrees(port, report) {
  const js = jsHashed(report);
  if (js.unhashable) {
    return port.unhashable === js.unhashable && port.overall === report.overall
      && port.statuses.length === report.checks.length && port.statuses.every((s, i) => s === report.checks[i].status);
  }
  return port.unhashable === undefined && port.hash === js.hash && canonical(port.report) === js.text;
}


function buildCompletenessReport(input = {}, { wasmLoader = defaultLoader } = {}) {
  const report = executePolicy(defaultLoader(),0,[input],(original,report)=>{
    let port;
    try { port=wasmLoader().completenessReport(original.job,original.expectedArtifacts??null); }
    catch(err){portWarn('completeness_report.wasm_fault',String(err?.reason||'unexpected').slice(0,40));return {reason:'impl_refused'};}
    let agrees=false;
    try { agrees=!!port&&portAgrees(port,report); } catch { agrees=false; }
    if(!agrees)portWarn('completeness_report.impl_mismatch',port&&port.unhashable!==undefined?'unhashable':'report');
    return {reason:agrees?null:'impl_mismatch'};
  });
  // Structural reply validation only; all five decisions and templates came from Rust.
  const statuses=new Set(['pass','fail','unknown']);
  if(!report||typeof report!=='object'||!Array.isArray(report.checks)||report.checks.length!==CHECK_NAMES.length
    ||!statuses.has(report.overall)
    ||report.unverified!==undefined&&!['impl_refused','impl_mismatch'].includes(report.unverified))
    throw new (defaultLoader().DavParseError)('completeness policy report reply shape','reply');
  for(let index=0;index<CHECK_NAMES.length;index++){const check=report.checks[index];
    if(!check||check.name!==CHECK_NAMES[index]||!statuses.has(check.status)||typeof check.detail!=='string'
      ||!check.evidence||typeof check.evidence!=='object')
      throw new (defaultLoader().DavParseError)('completeness policy check reply shape','reply');
  }
  return report;
}
function canEnterReviewing(report) {return executePolicy(defaultLoader(),6,[report]);}
module.exports={reportHash,CHECK_NAMES,TEST_STEP_IDS,TEST_ARTIFACT_KIND,buildCompletenessReport,canEnterReviewing};
