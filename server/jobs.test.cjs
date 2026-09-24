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

test('run() never leaks a controllers entry when the job.started append throws (e.g. disk full)', async (t) => {
  const dir = tmp();
  try {
    const jobs = createJobs({ dir });
    const id = jobs.create({ kind: 'x' });
    const realWrite = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (fd, data, ...rest) => {
      if (typeof data === 'string' && data.includes('"job.started"')) throw Object.assign(Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return realWrite(fd, data, ...rest);
    });
    await assert.rejects(jobs.run(id, async () => 'never runs'), /ENOSPC/);
    t.mock.restoreAll();
    // If the controllers entry had leaked (the pre-fix bug: controllers.set happened
    // before the append that can throw), recover() would see controllers.has(id) and
    // wrongly treat this job as still "running" in this process — skipping cleanup
    // (code-harness egress revoke / worktree release / research controllers) forever.
    // With the fix, the append throws before controllers ever gets an entry, so recover()
    // correctly finds an unfinished, un-tracked job and interrupts it.
    assert.equal(jobs.recover(), 1);
    assert.equal(jobs.get(id).status, 'interrupted');
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

test('Code plan append and legacy replay stay bounded while Research retains its plan shape', (t) => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = createJobs({ dir });
  const code = before.create({ kind: 'code', projectId: 'p1' });
  assert.equal(before.get(code).plan, null);
  before.append(code, 'job.started');
  const entries = Array.from({ length: 25 }, (_, i) => i === 0 ? '😀'.repeat(80) : `Entry ${i}`);
  const appended = before.append(code, 'plan.proposed', { question: 'unused', subQuestions: entries });
  assert.equal(appended.data.subQuestions.length, 20);
  assert.equal(Buffer.byteLength(appended.data.subQuestions[0]), 200);
  assert.equal(appended.data.truncated, true);
  assert.equal(before.get(code).plan.truncated, true);

  // Older journals can contain a plan event written before the producer cap existed.
  const journal = path.join(dir, 'jobs', code + '.jsonl');
  const seq = fs.readFileSync(journal, 'utf8').trim().split('\n').length + 1;
  fs.appendFileSync(journal, JSON.stringify({ job: code, seq, type: 'plan.edited', at: Date.now(),
    data: { question: 'legacy', subQuestions: entries } }) + '\n');
  const replay = createJobs({ dir });
  assert.deepEqual(replay.get(code).plan, { status: 'edited', question: null,
    subQuestions: appended.data.subQuestions, truncated: true });
  assert.equal(replay.recover(), 1);
  assert.equal(replay.get(code).status, 'interrupted');
  assert.equal(replay.get(code).plan.status, 'edited');

  const skipped = replay.create({ kind: 'code' });
  replay.append(skipped, 'plan.skipped', { question: 'unused', subQuestions: entries });
  assert.deepEqual(replay.get(skipped).plan, { status: 'skipped', question: null, subQuestions: [], truncated: false });

  const research = replay.create({ kind: 'deep_research' });
  replay.append(research, 'plan.edited', { question: 'Why?', subQuestions: ['One', 'Two'] });
  assert.deepEqual(replay.get(research).plan, { status: 'edited', question: 'Why?', subQuestions: ['One', 'Two'] });
});

test('assistant output replays after restart, clips UTF-8 safely, and survives interruption', (t) => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = createJobs({ dir, kinds: ['code'] });
  const id = before.create({ kind: 'code', projectId: 'p1' });
  before.append(id, 'job.started');
  before.append(id, 'assistant.output', { text: 'Visible. ' });
  for (let i = 0; i < 32; i++) before.append(id, 'assistant.output', { text: '😀'.repeat(256) });
  const bounded = before.append(id, 'assistant.output', { text: 'x'.repeat(2000) });
  assert.equal(Buffer.byteLength(bounded.data.text), 1024);
  assert.equal(bounded.data.truncated, true);
  const after = createJobs({ dir, kinds: ['code'] });
  assert.equal(after.recover(), 1);
  const recovered = after.get(id);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(Buffer.byteLength(recovered.assistantOutput.text), 32765, 'later ASCII cannot fill the gap left at a multibyte boundary');
  assert.ok(recovered.assistantOutput.text.startsWith('Visible. 😀'));
  assert.equal(recovered.assistantOutput.truncated, true);
  assert.equal(recovered.assistantOutput.text.includes('\uFFFD'), false);
  assert.equal(after.list({ projectId: 'other', kind: 'code' }).length, 0);
  const flood = before.create({ kind: 'code' });
  for (let i = 0; i < 64; i++) before.append(flood, 'assistant.output', { text: 'x' });
  assert.throws(() => before.append(flood, 'assistant.output', { text: 'more' }), /event limit/);
  const invalid = before.create({ kind: 'code' });
  before.append(invalid, 'assistant.output', { text: '\uD800' });
  assert.equal(before.get(invalid).assistantOutput.text, '\uFFFD', 'malformed UTF-16 is normalized in the journal');
});

test('a torn last line is tolerated; corruption elsewhere in one journal never blocks another kind sharing the directory', async (t) => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const research = createJobs({ dir, kinds: ['research'] });
  const sources = createJobs({ dir, kinds: ['source'] });

  // Torn last line: the process died mid-write of the final event. events() should
  // ignore the partial trailing line and derive the job from what came before it.
  const torn = research.create({ kind: 'research' });
  research.append(torn, 'job.started');
  research.append(torn, 'progress', { stage: 'reading' });
  const journal = path.join(dir, 'jobs', torn + '.jsonl');
  fs.appendFileSync(journal, '{"job":"' + torn + '","seq":3,"type":"progress","data":{"stage":"wri');
  assert.equal(research.get(torn).status, 'running');
  assert.equal(research.get(torn).stage, 'reading');

  // Real corruption in the middle of a different kind's journal must still 409 on
  // direct access, but must not stop recover/prune/list from doing their job for
  // everything else in the shared directory.
  const corrupt = sources.create({ kind: 'source' });
  sources.append(corrupt, 'job.started');
  fs.writeFileSync(path.join(dir, 'jobs', corrupt + '.jsonl'), 'not json at all\n{"job":"' + corrupt + '","seq":2,"type":"progress","data":{}}\n');
  assert.throws(() => sources.get(corrupt), (e) => e.status === 409);

  const running = sources.create({ kind: 'source' }); sources.append(running, 'job.started');
  assert.equal(sources.recover(), 1, 'recover still interrupts the healthy job in the same directory');
  assert.equal(sources.get(running).status, 'interrupted');

  const kept = sources.create({ kind: 'source' }); sources.append(kept, 'job.completed', {});
  sources.prune();
  assert.ok(fs.existsSync(path.join(dir, 'jobs', corrupt + '.jsonl')), 'unreadable journals are never deleted silently');
  assert.ok(fs.existsSync(path.join(dir, 'jobs', kept + '.jsonl')));

  const listed = sources.list();
  const entry = listed.find((j) => j.id === corrupt);
  assert.deepEqual(entry, { id: corrupt, status: 'unreadable' });
  assert.ok(listed.find((j) => j.id === running));
  assert.ok(listed.find((j) => j.id === kept));

  // create() for the healthy kind still works after prune runs over the corrupt file.
  const created = sources.create({ kind: 'source' });
  assert.equal(sources.get(created).status, 'queued');
});
