'use strict';
// TASK_LIFECYCLE_IMPL (retired in #1071: the port always confirms the JS): the fail-closed paths, with a stand-in for the Rust port (no
// dav-parse.wasm needed; tests/server/task-lifecycle-differential.test.cjs runs the real module).
// The JS answer is the only one ever returned, and only when the port gives the same:
// a move is allowed only when both allow it. A port refusal, fault, bad reply or disagreement makes
// canTransition false and every throwing entry point throw TaskLifecycleError (impl_refused /
// impl_mismatch, 409); through jobs.cjs that refuses the stage write (nothing is appended) and
// derives no lifecycle (null). Synthetic journals only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const lc = require('./task-lifecycle.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');
const { createJobs, derive, claimLifecycleAuthority } = require('./jobs.cjs');
const { CHECK_NAMES } = require('./completeness-report.cjs');

const AUTHORITY = claimLifecycleAuthority();
const { TaskLifecycleError } = lc;
const ev = (type, data) => ({ type, ...(data === undefined ? {} : { data }) });
const stage = (from, to, extra = {}) => ev('task.stage', { from, to, revision: 0, ...extra });

const answer = (fn, key) => {
  try { return { [key]: fn() }; } catch (err) { if (err instanceof TaskLifecycleError) return { throws: err.code }; throw err; }
};
/** A port that answers as the JS does, with `over` replacing any call. */
function fakePort(over = {}) {
  const calls = [];
  const port = {
    taskLifecycleCanTransition: (f, t) => { calls.push('can'); return answer(() => lc.canTransitionJs(f, t), 'allowed'); },
    taskLifecycleTransition: (f, t) => { calls.push('transition'); return answer(() => lc.transitionJs(f, t), 'state'); },
    taskLifecycleStageMove: (f, t) => { calls.push('stage'); return answer(() => lc.assertStageMoveJs(f, t), 'state'); },
    taskLifecycleFold: (e, f, a) => { calls.push('fold'); return answer(() => lc.foldEventsJs(e, f, { authoritative: a }), 'state'); },
    taskLifecycleDerive: (e) => { calls.push('derive'); return answer(() => lc.deriveLifecycleJs(e), 'state'); },
    ...over,
  };
  return { loader: () => port, calls };
}
const wasm = (port) => ({ wasmLoader: port.loader });
const fault = () => { throw new davParseWasm.DavParseError('dav-parse module failed', 'trap'); };

function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
}
const refused = (fn, code) => quietly(() => assert.throws(fn, (err) => err instanceof TaskLifecycleError && err.code === code && err.status === 409)).seen;

test('TASK_LIFECYCLE_IMPL is retired: no switch, the port is always asked, an old =js changes nothing', () => {
  assert.equal(lc.taskLifecycleImpl, undefined);
  assert.ok(!davParseWasm.IMPL_FLAGS.includes('TASK_LIFECYCLE_IMPL'));
  assert.equal(davParseWasm.RETIRED_FLAGS.TASK_LIFECYCLE_IMPL, 'wasm');
  for (const opts of [{}, { env: {}, impl: 'js' }, { env: { TASK_LIFECYCLE_IMPL: 'js' } }]) {
    const port = fakePort();
    const o = { ...opts, wasmLoader: port.loader };
    assert.equal(lc.canTransition('planned', 'implementing', o), true);
    assert.equal(lc.transition('planned', 'implementing', o), 'implementing');
    assert.equal(lc.assertStageMove('reviewing', 'merged', o), 'merged');
    assert.equal(lc.foldEvents([ev('job.started')], 'planned', o), 'implementing');
    assert.equal(lc.deriveLifecycle([ev('job.started')], o), 'implementing');
    assert.equal(lc.confirmFold([ev('job.started')], 'implementing', o), 'implementing');
    assert.deepEqual(port.calls, ['can', 'transition', 'stage', 'fold', 'derive', 'fold'], 'the port is asked for every call');
  }
});

test('an agreeing port leaves every answer as the JS gives it', () => {
  const port = fakePort();
  const o = wasm(port);
  assert.equal(lc.canTransition('planned', 'implementing', o), true);
  assert.equal(lc.transition('verifying', 'changes_requested', o), 'changes_requested');
  assert.equal(lc.assertStageMove('reviewing', 'merged', o), 'merged');
  const journal = [stage('planned', 'implementing'), stage('implementing', 'reviewing', { reportHash: 'c'.repeat(64) })];
  assert.equal(lc.foldEvents(journal, 'planned', { authoritative: true, ...o }), 'reviewing');
  assert.equal(lc.deriveLifecycle(journal, o), 'reviewing');
  assert.equal(lc.safeDeriveLifecycle(journal, o), 'reviewing');
  assert.equal(lc.confirmFold(journal, 'reviewing', { authoritative: true, ...o }), 'reviewing');
  assert.deepEqual(port.calls, ['can', 'transition', 'stage', 'fold', 'derive', 'derive', 'fold']);
});

test('when the JS refuses or throws, the port is not asked and the JS error stands', () => {
  const port = fakePort();
  const o = wasm(port);
  assert.equal(lc.canTransition('planned', 'merged', o), false);
  assert.throws(() => lc.canTransition('shipped', 'planned', o), (e) => e.code === 'unknown_state');
  assert.throws(() => lc.transition('merged', 'planned', o), (e) => e.code === 'illegal');
  assert.throws(() => lc.assertStageMove('verifying', 'merged', o), (e) => e.code === 'merge_from_reviewing');
  assert.throws(() => lc.deriveLifecycle([stage('implementing', 'verifying')], o), (e) => e.code === 'stale');
  assert.throws(() => lc.deriveLifecycle([stage('planned', 'implementing'), stage('implementing', 'reviewing')], o), (e) => e.code === 'report_hash');
  assert.equal(lc.safeDeriveLifecycle([ev('job.completed')], o), null);
  assert.deepEqual(port.calls, []);
});

test('wasm fails closed: a refusing, faulting, malformed or disagreeing port refuses the move', () => {
  const bad = [
    ['fault', fault, 'impl_refused'],
    ['refusal', () => { throw new davParseWasm.DavParseError('refused', 'ambiguous'); }, 'impl_refused'],
    ['TypeError', () => { throw new TypeError('x'); }, 'impl_refused'],
    ['throws', () => ({ throws: 'illegal' }), 'impl_mismatch'],
    ['other state', () => ({ state: 'blocked' }), 'impl_mismatch'],
    ['nothing', () => undefined, 'impl_refused'],
    ['wrong shape', () => ({ allowed: true }), 'impl_mismatch'],
  ];
  for (const [label, reply, code] of bad) {
    const port = fakePort({ taskLifecycleCanTransition: () => ({ 'other state': { allowed: false }, 'wrong shape': { state: 'implementing' } }[label] ?? reply()),
      taskLifecycleTransition: reply, taskLifecycleStageMove: reply, taskLifecycleFold: reply, taskLifecycleDerive: reply });
    const o = wasm(port);
    quietly(() => assert.equal(lc.canTransition('planned', 'implementing', o), false, label));
    quietly(() => assert.equal(lc.canTransitionToReviewing('implementing', { overall: 'pass', checks: [] }, o), false, label));
    refused(() => lc.transition('planned', 'implementing', o), code);
    refused(() => lc.assertStageMove('reviewing', 'merged', o), code);
    refused(() => lc.foldEvents([ev('job.started')], 'planned', o), code);
    refused(() => lc.deriveLifecycle([ev('job.started')], o), code);
    quietly(() => assert.equal(lc.safeDeriveLifecycle([ev('job.started')], o), null, label));
    quietly(() => assert.equal(lc.confirmFold([ev('job.started')], 'implementing', o), null, label));
  }
});

test('#1126: the port is sent only the events and fields the fold reads, and agrees on them', () => {
  const big = 'x'.repeat(4096);
  const journal = [
    { job: 'j', seq: 1, type: 'job.created', at: 1, data: { kind: 'code', prompt: big } },
    { type: 'tool.completed', data: { output: big } }, { type: 'approval.requested', data: { to: 'merged', review: true } },
    { type: 'job.started', data: { note: big } }, { type: 'progress', data: { stage: 'verifying', detail: big } },
    null, 3, { type: 7 }, { type: 'progress', data: 'verifying' }, { type: 'progress' },
    { type: 'task.stage', at: 2, hash: 'h', data: { from: 'planned', to: 'blocked', revision: 0, reason: big } },
    { type: 'task.revision', data: { n: 1, headSha: 'a'.repeat(40) } },
  ];
  assert.deepEqual(lc.foldInput(journal), [
    { type: 'job.started' }, { type: 'progress', data: { stage: 'verifying' } }, { type: 'progress', data: {} }, { type: 'progress', data: {} },
    { type: 'task.stage', data: { from: 'planned', to: 'blocked' } }, { type: 'task.revision' },
  ]);
  assert.equal(lc.foldInput(undefined), null);
  assert.equal(lc.foldInput(null), null);
  // Every dropped event is a no-op: the projection folds to the same answer, both modes.
  for (const authoritative of [false, true]) {
    for (const k of [0, 3, 5, 11, journal.length]) {
      const part = journal.slice(0, k);
      assert.deepEqual(answer(() => lc.foldEventsJs(lc.foldInput(part), 'planned', { authoritative }), 'state'),
        answer(() => lc.foldEventsJs(part, 'planned', { authoritative }), 'state'), `${k} ${authoritative}`);
    }
  }
  const seen = [];
  const port = fakePort({ taskLifecycleDerive: (e) => { seen.push(e); return answer(() => lc.deriveLifecycleJs(e), 'state'); } });
  assert.equal(lc.deriveLifecycle(journal, wasm(port)), 'blocked');
  assert.ok(JSON.stringify(seen[0]).length < 300, 'no payload sent');
});

test('#1125: a non-string reportHash is a TaskLifecycleError (report_hash), never a TypeError', () => {
  const hash = 'ab'.repeat(32);
  for (const reportHash of [[hash], [[hash]], { toString: hash }, { valueOf: hash }, {}, 1, true]) {
    const journal = [stage('planned', 'implementing'), stage('implementing', 'reviewing', { reportHash })];
    assert.throws(() => lc.deriveLifecycleJs(journal), (e) => e instanceof TaskLifecycleError && e.code === 'report_hash');
    assert.equal(lc.safeDeriveLifecycle(journal, { wasmLoader: () => { throw Error('asked'); } }), null, 'the JS throws first: the port is not asked');
    assert.equal(derive([{ type: 'job.created', job: 'x', data: { kind: 'code' } }, ...journal]).lifecycle, null);
  }
  assert.equal(lc.deriveLifecycleJs([stage('planned', 'implementing'), stage('implementing', 'reviewing', { reportHash: hash })]), 'reviewing');
});

test('port warnings are logged once per reason and carry no journal text', () => {
  // A fresh copy of the module: the warnings above already used this copy's once-per-reason set.
  delete require.cache[require.resolve('./task-lifecycle.cjs')];
  const fresh = require('./task-lifecycle.cjs');
  const port = fakePort({ taskLifecycleDerive: () => ({ state: 'blocked' }) });
  const secret = 'SYNTHETIC-CANARY-77';
  const { seen } = quietly(() => {
    for (let i = 0; i < 3; i++) assert.equal(fresh.safeDeriveLifecycle([ev('job.started', { note: secret })], wasm(port)), null);
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /task_lifecycle\.impl_mismatch \(state\); the transition was refused/);
  assert.ok(!seen.join('\n').includes(secret));
});

// --- Through jobs.cjs: the stage write and the derived lifecycle --------------------------------

const temps = [];
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
function withPort(over, fn) {
  const names = Object.keys(over), saved = names.map((n) => davParseWasm[n]);
  names.forEach((n) => { davParseWasm[n] = over[n]; });
  try { return quietly(fn).value; } finally {
    names.forEach((n, i) => { davParseWasm[n] = saved[i]; });
  }
}
const agree = fakePort().loader();

test('jobs.cjs: an agreeing port writes the stage; a refusing one writes nothing and yields 409', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-tl-')); temps.push(dir);
  const jobs = createJobs({ dir, kinds: ['code'], maxJobs: 10 });
  const id = jobs.create({ kind: 'code', projectId: 'p-synthetic', capabilities: ['read'] });
  const file = path.join(dir, 'jobs', id + '.jsonl');
  withPort(agree, () => jobs.append(id, 'task.stage', { from: 'planned', to: 'implementing', revision: 0 }, AUTHORITY));
  assert.equal(jobs.get(id).lifecycle, 'implementing');
  const before = fs.readFileSync(file, 'utf8');
  for (const [over, message] of [[{ ...agree, taskLifecycleStageMove: fault }, /refused by the Rust port/],
    [{ ...agree, taskLifecycleFold: () => ({ state: 'blocked' }) }, /^This task’s lifecycle could not be verified; review required$/],
    [{ ...agree, taskLifecycleFold: fault }, /^This task’s lifecycle could not be verified; review required$/]]) {
    // #1127: a port refusal is not reported as an inconsistent journal.
    assert.throws(() => withPort(over, () => jobs.append(id, 'task.stage', { from: 'implementing', to: 'verifying', revision: 0 }, AUTHORITY)),
      (e) => e.status === 409 && message.test(e.message) && !/inconsistent/.test(e.message));
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing appended');
  }
  // The read path: a disagreeing port derives no lifecycle; the rest of the job is unchanged.
  const disagree = withPort({ ...agree, taskLifecycleFold: () => ({ state: 'blocked' }) }, () => jobs.get(id));
  const plain = jobs.get(id);
  assert.equal(disagree.lifecycle, null);
  assert.deepEqual({ ...disagree, lifecycle: plain.lifecycle }, plain);
  assert.equal(withPort({ ...agree, taskLifecycleFold: fault }, () => jobs.get(id)).lifecycle, null);
  assert.equal(withPort(agree, () => jobs.get(id)).lifecycle, 'implementing');
  // The completeness checks are untouched by the confirmation.
  assert.ok(CHECK_NAMES.length > 0);
});

test('jobs.cjs derive: a journal the JS cannot fold is null without asking the port', () => {
  let asked = 0;
  const job = withPort({ ...agree, taskLifecycleFold: () => { asked++; return { state: 'verifying' }; } },
    () => derive([{ type: 'job.created', job: 'x', data: { kind: 'chat' } }, { type: 'job.completed', data: {} }]));
  assert.equal(job.lifecycle, null);
  assert.equal(asked, 0);
});
