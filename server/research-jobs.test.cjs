'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createResearchJobs } = require('./research-jobs.cjs');
const outage = () => Object.assign(Error('lost store reply'), { status: 503 });
let nextTenant = 0;
function fixture({ loseStart = false, loseCancel = false, loseFinish = false, commitFinish = true, commitCancel = true, failEvent = false } = {}) {
  const userId = `synthetic-research-${++nextTenant}`;
  const state = { job: null, abandons: 0, starts: 0, cancelIntent: false, events: [], report: null };
  const raw = {
    recover: async () => ({ count: 0 }),
    start: async (owner, projectId, request) => {
      state.starts++;
      state.job ||= { id: '11111111-1111-4111-8111-111111111111', run: '22222222-2222-4222-8222-222222222222', request, projectId, status: 'running', result: null, artifacts: [], kind: 'deep_research' };
      if (loseStart) throw outage();
      return { id: state.job.id, run: state.job.run };
    },
    abandon: async (owner, request) => { state.abandons++; if (state.job?.request === request && state.job.status === 'running') Object.assign(state.job, state.report ? { status: state.cancelIntent ? 'cancelled' : 'failed', result: state.report } : { status: 'interrupted' }); return { ok: true }; },
    event: async (owner, id, run, n, kind, data) => { if (failEvent) throw outage(); state.events.push({ n, kind, data }); return { ok: true }; },
    cancel: async () => { if (commitCancel) state.cancelIntent = true; if (loseCancel) throw outage(); return { ...state.job }; },
    report: async (owner, id, run, result) => { state.report = result; return { ok: true }; },
    finish: async (owner, id, run, ok, result, error) => {
      if (commitFinish && state.job.status === 'running') Object.assign(state.job, { status: state.cancelIntent ? 'cancelled' : ok ? 'completed' : 'failed', result, error });
      if (loseFinish) throw outage();
      return { ok: true };
    },
    read: async () => state.job && { ...state.job },
    list: async () => state.job ? [{ ...state.job }] : [],
  };
  return { state, workspace: { userId, researchJobs: raw, assertActive() {} }, raw };
}
const reserve = (jobs) => jobs.create({ projectId: 'p', question: 'Q?', plan: 'skipped', subQuestions: ['Q?'] });
const eventually = async (predicate) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 2)); } throw Error('did not reconcile'); };

test('two lost start replies reserve no executor and reconcile the one active slot in process', async () => {
  const { state, workspace } = fixture({ loseStart: true });
  const jobs = createResearchJobs(workspace);
  await assert.rejects(() => reserve(jobs), { status: 503 });
  await eventually(() => state.abandons > 0);
  assert.equal(state.job.status, 'interrupted');
  assert.equal(state.starts, 1);
});

test('lost cancel reply still aborts local executor and a committed intent yields cancelled', async () => {
  const { state, workspace } = fixture({ loseCancel: true });
  const jobs = createResearchJobs(workspace);
  const id = await reserve(jobs);
  const done = jobs.run(id, ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ sections: 1, markdown: '# Q', sources: [] }), { once: true })));
  await assert.rejects(() => jobs.cancel(id, 'p'), { status: 503 });
  assert.equal((await done).status, 'cancelled');
  assert.equal(state.job.result.sections, 1);
});

test('lost terminal replies reconcile both committed and uncommitted outcomes without false completion', async () => {
  for (const committed of [true, false]) {
    const { state, workspace } = fixture({ loseFinish: true, commitFinish: committed });
    const jobs = createResearchJobs(workspace);
    const id = await reserve(jobs);
    const result = await jobs.run(id, async () => ({ sections: 1, markdown: '# Q', sources: [] }));
    await eventually(() => state.abandons > 0);
    assert.equal(result.status, committed ? 'completed' : 'failed');
  }
});

test('event-store failure blocks a clean completion and keeps an attached report result', async () => {
  const { state, workspace } = fixture({ failEvent: true });
  const jobs = createResearchJobs(workspace);
  const id = await reserve(jobs);
  const result = await jobs.run(id, async (ctx) => {
    ctx.progress('Saving the report');
    try { await ctx.flush(); } catch (error) { throw Object.assign(error, { result: { markdown: '# Q', sources: [], sections: 1 } }); }
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.result.markdown, '# Q');
  assert.equal(state.events.length, 0);
});

test('lost cancel replies without a committed intent abort locally but retain partial report as failed', async () => {
  const { state, workspace } = fixture({ loseCancel: true, commitCancel: false });
  const jobs = createResearchJobs(workspace);
  const id = await reserve(jobs);
  const done = jobs.run(id, ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ sections: 1, markdown: '# Q', sources: [] }), { once: true })));
  await assert.rejects(() => jobs.cancel(id, 'p'), { status: 503 });
  const job = await done;
  assert.equal(job.status, 'failed');
  assert.equal(job.result.sections, 1);
  assert.equal(state.cancelIntent, false);
});

test('a queued event failure after work returns preserves the report', async () => {
  const { state, workspace } = fixture({ failEvent: true });
  const jobs = createResearchJobs(workspace);
  const id = await reserve(jobs);
  const job = await jobs.run(id, async (ctx) => {
    ctx.checkpoint({ step: 1 });
    return { markdown: '# Q', sources: [], sections: 1 };
  });
  assert.equal(job.status, 'failed');
  assert.equal(job.result.markdown, '# Q');
  assert.equal(state.events.length, 0);
});

test('cancelled sections survive uncommitted lost finish through report-first reconciliation', async () => {
  const { state, workspace } = fixture({ loseFinish: true, commitFinish: false });
  const jobs = createResearchJobs(workspace);
  const id = await reserve(jobs);
  const done = jobs.run(id, ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ sections: 1, markdown: '# Q', sources: [] }), { once: true })));
  await jobs.cancel(id, 'p');
  const job = await done;
  await eventually(() => state.abandons > 0);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.result.sections, 1);
  assert.equal(state.report.markdown, '# Q');
});
