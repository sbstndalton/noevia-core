const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createJobs } = require('./jobs.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-jobs-'));

test('a job runs to completion with progress, checkpoints and artifacts derived from events', async () => {
  const dir = tmp();
  try {
    const jobs = createJobs({ dir });
    const id = jobs.create({ kind: 'source', projectId: 'p1', capabilities: ['read'] });
    const done = await jobs.run(id, async (ctx) => { ctx.progress('Reading'); ctx.checkpoint({ step: 1 }); ctx.artifact({ name: 'a.md' }); return { ok: true }; });
    assert.equal(done.status, 'completed'); assert.deepEqual(done.result, { ok: true });
    assert.equal(done.stage, 'Reading'); assert.deepEqual(done.checkpoint, { step: 1 }); assert.equal(done.artifacts.length, 1);
    assert.equal(fs.statSync(path.join(dir, 'jobs', id + '.jsonl')).mode & 0o777, 0o600);
    assert.throws(() => jobs.append(id, 'progress', {}), /already finished/);
    assert.throws(() => jobs.append(id, 'made.up', {}), /Unknown job event type/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failures and cancellation end the job exactly once', async () => {
  const dir = tmp();
  try {
    const jobs = createJobs({ dir });
    const failed = await jobs.run(jobs.create({ kind: 'x' }), async () => { throw Object.assign(Error('boom'), { result: { status: 500 } }); });
    assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'boom'); assert.deepEqual(failed.result, { status: 500 });
    const id = jobs.create({ kind: 'x' });
    const running = jobs.run(id, (ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve('late'))));
    jobs.cancel(id);
    assert.equal((await running).status, 'cancelled');
    assert.equal(jobs.cancel(id).status, 'cancelled');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restart recovery interrupts unfinished jobs and never resumes an approval', () => {
  const dir = tmp();
  try {
    const before = createJobs({ dir });
    const running = before.create({ kind: 'x' }); before.append(running, 'job.started');
    const waiting = before.create({ kind: 'x' }); before.append(waiting, 'job.started');
    before.append(waiting, 'tool.uncertain', { tool: 'submit', note: 'connection lost after submit' });
    before.append(waiting, 'approval.requested', { tool: 'write', args: '{}' });
    const finished = before.create({ kind: 'x' }); before.append(finished, 'job.completed', {});
    const after = createJobs({ dir });
    assert.equal(after.recover(), 2);
    assert.equal(after.get(running).status, 'interrupted');
    const w = after.get(waiting);
    assert.equal(w.status, 'interrupted'); assert.equal(w.pendingApproval, null); assert.match(w.error, /asked again/);
    assert.equal(w.uncertain.length, 1, 'uncertain side effects stay visible');
    assert.equal(after.get(finished).status, 'completed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('capabilities are fixed at creation and a child can never widen them', () => {
  const dir = tmp();
  try {
    const jobs = createJobs({ dir });
    const parent = jobs.create({ kind: 'research', capabilities: ['web.read', 'project.read'] });
    assert.equal(jobs.can(parent, 'web.read'), true); assert.equal(jobs.can(parent, 'project.write'), false);
    assert.ok(jobs.create({ kind: 'sub', parentId: parent, capabilities: ['web.read'] }));
    assert.throws(() => jobs.create({ kind: 'sub', parentId: parent, capabilities: ['web.read', 'project.write'] }), (e) => e.status === 403);
    assert.throws(() => jobs.get('../../etc/passwd'), (e) => e.status === 400);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('finished jobs are pruned by age and count; unfinished ones never are', () => {
  const dir = tmp();
  try {
    let clock = 1_000_000;
    const jobs = createJobs({ dir, now: () => clock, retainMs: 1000, maxJobs: 2 });
    const old = jobs.create({ kind: 'x' }); jobs.append(old, 'job.completed', {});
    const open = jobs.create({ kind: 'x' }); jobs.append(open, 'job.started');
    clock += 5000;
    const a = jobs.create({ kind: 'x' }); jobs.append(a, 'job.completed', {});
    assert.equal(jobs.get(old), null, 'aged out');
    assert.equal(jobs.get(open).status, 'running', 'unfinished work is kept');
    assert.equal(jobs.list({ active: true }).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a store scoped to its kinds never prunes another kind sharing the directory', () => {
  const dir = tmp();
  try {
    let clock = 1_000_000;
    const research = createJobs({ dir, now: () => clock });
    const kept = research.create({ kind: 'research' }); research.append(kept, 'job.completed', {});
    const sources = createJobs({ dir, now: () => clock, retainMs: 1000, maxJobs: 1, kinds: ['source'] });
    const s1 = sources.create({ kind: 'source' }); sources.append(s1, 'job.completed', {});
    clock += 5000;
    sources.create({ kind: 'source' });
    assert.equal(sources.get(s1), null, 'own kind aged out');
    assert.equal(research.get(kept).status, 'completed', 'other kind untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recover is scoped to the store kinds: another store in the same directory cannot interrupt a running job', async (t) => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-jobs-kinds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { createJobs } = require('./jobs.cjs');
  const research = createJobs({ dir, kinds: ['deep_research'] });
  const id = research.create({ kind: 'deep_research' });
  let release;
  const done = research.run(id, () => new Promise((r) => { release = r; }));
  const sources = createJobs({ dir, kinds: ['source'] });
  assert.equal(sources.recover(), 0);
  release('ok');
  assert.equal((await done).status, 'completed');
});
