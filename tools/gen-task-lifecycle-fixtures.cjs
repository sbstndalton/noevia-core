#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for TASK_LIFECYCLE_IMPL: task-lifecycle.cjs's guarded table
// (canTransition, transition), the pipeline's stage move (assertStageMove) and the journal fold
// (foldEvents, deriveLifecycle). The same file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/task-lifecycle/tests/fixtures/task-lifecycle.v1.json); noevia-core CI compares them.
//   node tools/gen-task-lifecycle-fixtures.cjs > tests/fixtures/task-lifecycle.v1.json
//
// Every expectation is what the JS itself returns or throws (TaskLifecycleError's code), with
// TASK_LIFECYCLE_IMPL=js. Journals are synthetic (no Diary or user text) and the random ones come
// from a seeded mulberry32, so the table is the same on every Node version. Nothing here depends on
// ICU, locale or number formatting (#1115): states and types compare as code units. A reportHash
// that is not a string (an array, an object with its own toString) is refused by the JS itself since
// #1125, so those rows carry the JS answer like any other.
//
// Sections:
// Each row is { wire, want }: `wire` is the request JSON (JSON.parse it for the arguments).
//   pairs:  wire [from, to], want { canTransition: { allowed } | { throws }, transition,
//           stageMove: { state } | { throws } }                                  ops 1, 2, 3
//   folds:  wire [events, from, authoritative], want { state } | { throws }      op 4
//   derive: wire [events], want { state } | { throws }                           op 5

const path = require('node:path');
const lifecycle = require(path.join(__dirname, '..', 'server', 'task-lifecycle.cjs'));

const JS = { impl: 'js' };
const HASH = 'ab'.repeat(32);

function answer(fn, key) {
  try {
    const v = fn();
    return { [key]: v };
  } catch (err) {
    if (!(err instanceof lifecycle.TaskLifecycleError) || typeof err.code !== 'string') throw err;
    return { throws: err.code };
  }
}

const ODD = [null, 'shipped', 'Planned', ' planned', 'planned ', 1, true, ['planned'], { state: 'planned' }, '', 'merged\u0000', 'reviewing\ud800'];
const VALUES = [...lifecycle.STATES, ...ODD];

function pairRow(from, to) {
  return {
    wire: JSON.stringify([from, to]),
    want: {
      canTransition: answer(() => lifecycle.canTransition(from, to, JS), 'allowed'),
      transition: answer(() => lifecycle.transition(from, to, JS), 'state'),
      stageMove: answer(() => lifecycle.assertStageMove(from, to, JS), 'state'),
    },
  };
}

const pairs = [];
for (const from of VALUES) {
  for (const to of VALUES) {
    if (lifecycle.STATES.includes(from) || lifecycle.STATES.includes(to) || (from === null && to === null)) pairs.push(pairRow(from, to));
  }
}

const ev = (type, data) => (data === undefined ? { type } : { type, data });
const stage = (from, to, extra = {}) => ev('task.stage', { from, to, revision: 0, ...extra });

// Hand-written journals: the real shapes jobs.cjs writes, and the odd ones a fold must survive.
const HAND = [
  [],
  [ev('job.created', { kind: 'code' })],
  [ev('job.created'), ev('job.started')],
  [ev('job.created'), ev('job.started'), ev('progress', { stage: 'verifying' }), ev('job.completed', { result: { merged: true } })],
  [ev('job.created'), ev('job.completed')],
  [ev('job.created'), ev('job.started'), ev('progress', { stage: 'reviewing' }), ev('approval.requested', { review: true, merged: true }), ev('approval.decided', { review: true })],
  [ev('job.created'), ev('job.started'), ev('job.failed', { error: 'x' }), ev('job.started')],
  [ev('job.created'), ev('job.started'), ev('job.cancelled'), ev('job.interrupted')],
  [ev('job.started'), ev('progress', { stage: 'implementing' }), ev('progress', { stage: 'verifying' }), ev('progress', { stage: 'implementing' })],
  [ev('job.started'), ev('progress', { stage: 'Verifying' }), ev('progress', { stage: ['verifying'] }), ev('progress', 'verifying'), ev('progress')],
  [null, 0, 1, 'job.started', [], [ev('job.started')], {}, { type: 5 }, { type: null }, { type: ['job.started'] }],
  [ev('job.started', null), ev('job.completed', 0), ev('job.failed', ''), ev('job.started', false)],
  [{ type: 'job.started\ud800' }, { type: 'job.started ' }, { type: 'JOB.STARTED' }],
  // Authoritative (#701): the pipeline's own stage moves.
  [ev('job.created', { kind: 'code' }), stage('planned', 'implementing'), ev('task.revision', { n: 1, headSha: 'a'.repeat(40) })],
  [stage('planned', 'implementing'), stage('implementing', 'verifying'), stage('verifying', 'reviewing', { reportHash: HASH }), stage('reviewing', 'merged')],
  [stage('planned', 'implementing'), stage('implementing', 'reviewing')],
  [stage('planned', 'implementing'), stage('implementing', 'reviewing', { reportHash: HASH.toUpperCase() })],
  [stage('planned', 'implementing'), stage('implementing', 'reviewing', { reportHash: HASH.slice(1) })],
  [stage('planned', 'implementing'), stage('implementing', 'reviewing', { reportHash: `${HASH}\n` })],
  [stage('planned', 'implementing'), stage('implementing', 'reviewing', { reportHash: 0 })],
  [stage('planned', 'implementing'), stage('implementing', 'reviewing', { reportHash: 1234567890123456789012 })],
  [stage('planned', 'implementing'), stage('implementing', 'reviewing', { reportHash: true })],
  [stage('planned', 'implementing'), stage('implementing', 'reviewing', { reportHash: null })],
  [stage('planned', 'implementing'), stage('implementing', 'reviewing', { reportHash: HASH }), stage('reviewing', 'reviewing')],
  [stage('planned', 'implementing'), stage('implementing', 'merged')],
  [stage('planned', 'implementing'), stage('implementing', 'verifying'), stage('verifying', 'merged')],
  [stage('planned', 'implementing'), stage('implementing', 'verifying'), stage('verifying', 'changes_requested'), stage('changes_requested', 'implementing')],
  [stage('planned', 'implementing'), stage('planned', 'verifying')],
  [stage('planned', 'implementing'), stage('implementing', 'shipped')],
  [stage('planned', 'implementing'), stage(null, 'blocked')],
  [stage('planned', 'implementing'), ev('task.stage', { to: 'blocked' })],
  [stage('planned', 'implementing'), ev('task.stage')],
  [stage('planned', 'implementing'), ev('task.stage', 'blocked')],
  [stage('planned', 'implementing'), ev('job.started'), ev('job.completed'), ev('progress', { stage: 'verifying' })],
  [stage('planned', 'implementing'), ev('job.failed'), stage('blocked', 'implementing')],
  [stage('planned', 'implementing'), stage('implementing', 'reviewing', { reportHash: HASH }), stage('reviewing', 'merged'), ev('job.failed'), ev('job.interrupted')],
  [stage('planned', 'blocked'), stage('blocked', 'planned'), stage('planned', 'planned')],
  [stage('planned', 'implementing'), stage('implementing', 'reviewing', { reportHash: HASH }), stage('reviewing', 'merged'), stage('merged', 'implementing')],
  [ev('task.revision', { n: 1 }), ev('job.started'), ev('job.cancelled')],
  [ev('job.started'), ev('job.completed'), ev('task.revision')],
  [ev('job.started'), stage('implementing', 'verifying')],
];

// Seeded journals: mulberry32 over a small synthetic vocabulary.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x7a5c);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const HASHES = [HASH, HASH, HASH, HASH, HASH.toUpperCase(), '', null, 0, 'x', undefined];
const STAGES = ['implementing', 'verifying', 'reviewing', 'merged', 'other', null];
function randomEvent(state) {
  const r = rand();
  if (r < 0.35) {
    const to = pick(lifecycle.STATES);
    const from = rand() < 0.85 ? state : pick(lifecycle.STATES);
    const extra = to === 'reviewing' ? { reportHash: pick(HASHES) } : {};
    return stage(from, to, extra);
  }
  if (r < 0.4) return ev('task.revision', { n: 1 });
  if (r < 0.55) return ev('progress', { stage: pick(STAGES) });
  return ev(pick(['job.created', 'job.started', 'job.completed', 'job.failed', 'job.cancelled', 'job.interrupted', 'approval.requested', 'approval.decided', 'step.started', 'tool.completed', 'artifact.created']));
}
function randomJournal() {
  const n = Math.floor(rand() * 12);
  const out = [];
  let state = 'planned';
  for (let i = 0; i < n; i++) {
    const e = randomEvent(state);
    out.push(e);
    try { state = lifecycle.step(state, e, { authoritative: true }); } catch { /* keep the guess */ }
  }
  return out;
}
const SEEDED = Array.from({ length: 300 }, randomJournal);

// A reportHash that is not a string (#1125): before, String() let [hash] through and an own
// toString key threw a TypeError; now each is a report_hash refusal.
const NON_STRING_HASHES = [[HASH], [[HASH]], [HASH, HASH], {}, { toString: HASH }, { valueOf: HASH }, []]
  .map((reportHash) => [stage('planned', 'implementing'), stage('implementing', 'reviewing', { reportHash })]);

const derive = [...HAND, ...NON_STRING_HASHES, ...SEEDED].map((events) => ({
  wire: JSON.stringify([events]), want: answer(() => lifecycle.deriveLifecycle(events, JS), 'state'),
}));
derive.push({ wire: JSON.stringify([null]), want: answer(() => lifecycle.deriveLifecycle(null, JS), 'state') });

const folds = [];
for (const [i, events] of HAND.entries()) {
  for (const from of [lifecycle.STATES[i % 7], 'blocked', 'merged']) {
    for (const authoritative of [false, true]) {
      folds.push({ wire: JSON.stringify([events, from, authoritative]),
        want: answer(() => lifecycle.foldEvents(events, from, { authoritative, ...JS }), 'state') });
    }
  }
}
for (const from of ODD) {
  folds.push({ wire: JSON.stringify([[], from, false]),
    want: answer(() => lifecycle.foldEvents([], from, JS), 'state') });
}


const counts = (rows) => rows.reduce((m, r) => { const k = r.want.state ?? r.want.throws; m[k] = (m[k] || 0) + 1; return m; }, {});
const c = counts(derive);
for (const k of ['planned', 'implementing', 'verifying', 'reviewing', 'merged', 'blocked', 'illegal', 'stale', 'report_hash', 'unknown_state', 'merge_from_reviewing']) {
  if (!c[k]) throw Error(`derive rows never reach ${k}`);
}

process.stdout.write(`${JSON.stringify({ version: 1, pairs, folds, derive })}\n`);
