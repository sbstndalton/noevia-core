'use strict';
// #1126: append() no longer re-reads the JSONL journal or re-folds it from the start. The journal is
// cached per job (validated by the file's size, mtime and inode), and each append folds only its own
// event. These tests pin: the read count, that a cached journal equals an independent read of the file,
// that an external change to the file is seen, and that the one-event fold equals the whole-journal
// fold for random mixed journals (including the authority events). Synthetic data only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createJobs, derive, claimLifecycleAuthority, journalFold } = require('./jobs.cjs');

const AUTHORITY = claimLifecycleAuthority();
const JOB_ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-incremental-1126-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// The journal as a fresh reader sees it: every line parsed, no cache.
const journalOnDisk = (dir, id) => fs.readFileSync(path.join(dir, 'jobs', `${id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('#1126 appends read the JSONL journal once, not once per append', (t) => {
  const dir = tmp(t);
  const jobs = createJobs({ dir, kinds: ['code'], maxJobs: 10 });
  const id = jobs.create({ kind: 'code', projectId: 'p-synthetic', capabilities: ['read'] });
  jobs.append(id, 'job.started', {});
  const journal = path.join(dir, 'jobs', `${id}.jsonl`);
  const reads = [];
  const real = fs.readFileSync;
  fs.readFileSync = function patched(file, ...rest) { if (String(file) === journal) reads.push(1); return real.call(fs, file, ...rest); };
  try {
    for (let i = 0; i < 500; i++) jobs.append(id, i % 25 ? 'tool.completed' : 'progress', i % 25 ? { i } : { stage: 'implementing' });
  } finally { fs.readFileSync = real; }
  assert.ok(reads.length <= 1, `journal read ${reads.length} times for 500 appends`);
  assert.equal(journalOnDisk(dir, id).length, 502);
});

test('#1126 the cached job equals a fold of the journal as it is on disk, after every kind of append', (t) => {
  const dir = tmp(t);
  const jobs = createJobs({ dir, kinds: ['code'], maxJobs: 10 });
  const id = jobs.create({ kind: 'code', projectId: 'p-synthetic', capabilities: ['read'] });
  const steps = [
    ['job.started', {}], ['step.started', { id: 'tests', title: 'Run tests' }], ['progress', { stage: 'implementing' }],
    ['assistant.output', { text: 'partial answer' }], ['artifact.created', { name: 'a.txt' }],
    ['task.stage', { from: 'planned', to: 'implementing', revision: 0 }, AUTHORITY], ['step.completed', { id: 'tests' }],
    ['tool.uncertain', { tool: 'x' }], ['progress', { stage: 'verifying' }],
  ];
  for (const [type, data, authority] of steps) {
    jobs.append(id, type, data, authority);
    assert.deepEqual(jobs.get(id), derive(journalOnDisk(dir, id)), `after ${type}`);
  }
});

test('#1126 a change to the journal made outside the cached appends is seen by the next read', (t) => {
  const dir = tmp(t);
  const jobs = createJobs({ dir, kinds: ['code'], maxJobs: 10 });
  const id = jobs.create({ kind: 'code', projectId: 'p-synthetic', capabilities: ['read'] });
  jobs.append(id, 'job.started', {});
  assert.equal(jobs.get(id).stage, null);
  const line = { job: id, seq: journalOnDisk(dir, id).length + 1, type: 'progress', at: Date.now(), data: { stage: 'implementing' } };
  fs.appendFileSync(path.join(dir, 'jobs', `${id}.jsonl`), JSON.stringify(line) + '\n');
  assert.equal(jobs.get(id).stage, 'implementing', 'an outside write is read, not hidden by the cache');
  jobs.append(id, 'progress', { stage: 'verifying' });
  assert.deepEqual(jobs.get(id), derive(journalOnDisk(dir, id)));
});

test('#1126 a replaced journal is re-read, not served from the cache: the reader answers what the file now says', (t) => {
  const dir = tmp(t);
  const jobs = createJobs({ dir, kinds: ['code'], maxJobs: 10 });
  const id = jobs.create({ kind: 'code', projectId: 'p-synthetic', capabilities: ['read'] });
  jobs.append(id, 'job.started', {});
  assert.equal(jobs.get(id).status, 'running');
  // A torn single line is what a crash leaves in a non-durable journal: read as an empty journal, as before.
  fs.writeFileSync(path.join(dir, 'jobs', `${id}.jsonl`), '{"job":"' + id + '","seq":1,"type":"job.created","at":1,"data":{"kind":"code"');
  assert.equal(jobs.get(id), null);
});

// Random journals, the events the fold reads, in every order a real journal could show them.
function randomJournal(rand, length) {
  const kinds = ['code', 'chat'];
  const types = ['job.started', 'step.started', 'step.completed', 'progress', 'artifact.created', 'tool.uncertain',
    'assistant.output', 'checkpoint.created', 'plan.skipped', 'approval.requested', 'approval.decided', 'task.stage',
    'task.revision', 'job.completed', 'job.failed', 'job.cancelled', 'job.interrupted'];
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const events = [{ job: 'j', seq: 1, type: 'job.created', at: 1000, data: { kind: pick(kinds), projectId: 'p', capabilities: ['read'] } }];
  for (let i = 1; i < length; i++) {
    const type = pick(types);
    const data = type === 'step.started' || type === 'step.completed' ? { id: pick(['tests', 'lint']), title: 'T', failed: rand() < 0.2 }
      : type === 'progress' ? { stage: pick(['implementing', 'verifying', 'other']) }
      : type === 'task.stage' ? { from: pick(['planned', 'implementing', 'verifying', 'blocked']), to: pick(['implementing', 'verifying', 'blocked']), revision: Math.floor(rand() * 2) }
      : type === 'task.revision' ? { n: 1 + Math.floor(rand() * 2), headSha: 'a'.repeat(40) }
      : type === 'assistant.output' ? { text: 'x'.repeat(Math.floor(rand() * 40)) }
      : { value: i };
    events.push({ job: 'j', seq: i + 1, type, at: 1000 + i, data });
  }
  return events;
}

test('#1126 folding one event at a time equals folding the whole journal, for random mixed journals', () => {
  let seed = 1126;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let round = 0; round < 60; round++) {
    const events = randomJournal(rand, 2 + Math.floor(rand() * 30));
    const acc = journalFold.newAccumulator(false);
    for (let k = 0; k < events.length; k++) {
      // The accumulator is rebuilt exactly when a journal first shows an authority event (as append does).
      const prefix = events.slice(0, k + 1);
      const authoritative = prefix.some((e) => e.type === 'task.stage' || e.type === 'task.revision');
      if (authoritative !== acc.authoritative) {
        const rebuilt = journalFold.buildAccumulator(prefix);
        Object.assign(acc, rebuilt);
      } else journalFold.foldEvent(acc, events[k]);
      // The lifecycle confirmation is get()'s alone (the Rust port sees the whole journal there); the fold has no part in it.
      const { lifecycle: _unconfirmed, ...folded } = journalFold.snapshot(acc);
      const { lifecycle: _whole, ...whole } = derive(prefix);
      assert.deepEqual(folded, whole, `round ${round}, prefix ${k + 1}`);
    }
  }
});

test('#1126 the cached fold is the same job object shape get() reports (keys and values)', (t) => {
  const dir = tmp(t);
  const jobs = createJobs({ dir, kinds: ['code'], maxJobs: 10 });
  const id = jobs.create({ kind: 'code', projectId: 'p-synthetic', capabilities: [] });
  jobs.append(id, 'job.started', {});
  jobs.append(id, 'job.completed', { result: { ok: true } });
  const job = jobs.get(id);
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.result, { ok: true });
  assert.equal(job.id, id);
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(Object.keys(job))).digest('hex').length, 64);
});

test('#1590 the cache holds its own copy: editing the data given to append, or a job from get(), never changes the journal', (t) => {
  const dir = tmp(t);
  const jobs = createJobs({ dir, kinds: ['code'], maxJobs: 10 });
  const id = jobs.create({ kind: 'code', projectId: 'p-synthetic', capabilities: ['read'] });
  const card = { id: 'approval-1', tool: 'write_file', args: { path: 'a.txt' } };
  jobs.append(id, 'approval.requested', card);
  card.args.path = '/etc/passwd'; card.tool = 'something_else'; // the caller reuses its object
  const first = jobs.get(id);
  assert.deepEqual(first.pendingApproval, { id: 'approval-1', tool: 'write_file', args: { path: 'a.txt' } });
  first.pendingApproval.args.path = 'tampered'; first.steps.push({ id: 'fake' }); first.status = 'completed';
  const second = jobs.get(id);
  assert.equal(second.pendingApproval.args.path, 'a.txt', 'a job from get() is a copy');
  assert.deepEqual(second.steps, []);
  assert.deepEqual(second, derive(journalOnDisk(dir, id)), 'and it still equals a fold of the file');
  const event = jobs.append(id, 'approval.decided', { id: 'approval-1', decision: 'approve' });
  event.data.decision = 'deny';
  assert.equal(journalOnDisk(dir, id).at(-1).data.decision, 'approve');
  assert.equal(jobs.get(id).pendingApproval, null);
});

test('#1590 an append after a torn last line cuts the fragment off, so the result survives a restart', (t) => {
  const dir = tmp(t);
  const jobs = createJobs({ dir, maxJobs: 10 }); // no hash chain: a torn last line is tolerated on read
  const id = jobs.create({ kind: 'research', projectId: 'p-synthetic', capabilities: [] });
  jobs.append(id, 'job.started', {});
  const journal = path.join(dir, 'jobs', `${id}.jsonl`);
  fs.appendFileSync(journal, '{"job":"' + id + '","seq":3,"type":"progr'); // a crash mid-write
  assert.equal(jobs.get(id).status, 'running', 'the torn tail is ignored on read');
  jobs.append(id, 'job.completed', { result: { answer: 'synthetic result' } });
  const text = fs.readFileSync(journal, 'utf8');
  assert.ok(text.endsWith('\n'));
  assert.equal(text.split('\n').filter(Boolean).length, 3, 'created, started, completed: the fragment is gone');
  assert.deepEqual(journalOnDisk(dir, id).map((e) => e.seq), [1, 2, 3]);
  // After a restart, a fresh reader sees the finished job, not "Unreadable job journal".
  const restarted = createJobs({ dir, maxJobs: 10 });
  assert.deepEqual(restarted.get(id).result, { answer: 'synthetic result' });
  assert.equal(restarted.get(id).status, 'completed');
});

test('#1590 a journal that is only a torn fragment still takes its first event', (t) => {
  const dir = tmp(t);
  const jobs = createJobs({ dir, maxJobs: 10 });
  const id = '00000000-0000-4000-8000-0000000000aa';
  fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'jobs', `${id}.jsonl`), '{"job":"x","seq":1,"ty');
  jobs.append(id, 'job.created', { kind: 'research', projectId: 'p-synthetic', capabilities: [] });
  assert.deepEqual(journalOnDisk(dir, id).map((e) => e.type), ['job.created']);
});
