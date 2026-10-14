'use strict';
// #1391: list({ strict: true }) is the job enumeration a release idle gate can trust. Only an absent
// jobs directory is "no jobs"; an unreadable, symlinked or non-directory root, a journal that is not a
// regular file, an unreadable journal or more entries than the cap is refused (JOBS_UNKNOWN), never
// read as empty. The default list() keeps its lenient behaviour for the app.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createJobs } = require('./jobs.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-jobs-strict-'));
const unknown = (e) => e.code === 'JOBS_UNKNOWN';
const root = process.getuid?.() === 0;

test('an absent jobs directory is no jobs, strict or not', () => {
  const dir = tmp();
  try {
    const jobs = createJobs({ dir });
    assert.deepEqual(jobs.list({ strict: true }), []);
    assert.deepEqual(jobs.list(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable jobs directory is refused in strict mode, not read as idle', { skip: root && 'root reads anything' }, () => {
  const dir = tmp();
  try {
    const jobs = createJobs({ dir });
    jobs.create({ kind: 'code' });
    fs.chmodSync(path.join(dir, 'jobs'), 0o000);
    assert.throws(() => jobs.list({ strict: true, active: true }), unknown);
    assert.deepEqual(jobs.list({ active: true }), [], 'the lenient list still reads it as empty');
  } finally { fs.chmodSync(path.join(dir, 'jobs'), 0o700); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a symlinked or non-directory jobs root is refused', () => {
  for (const make of [
    (dir) => { const elsewhere = tmp(); fs.symlinkSync(elsewhere, path.join(dir, 'jobs')); },
    (dir) => fs.writeFileSync(path.join(dir, 'jobs'), 'not a directory'),
  ]) {
    const dir = tmp();
    try {
      make(dir);
      assert.throws(() => createJobs({ dir }).list({ strict: true }), unknown);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a symlinked journal, a corrupt journal or too many entries is refused', () => {
  const cases = [
    (dir, id) => { const f = path.join(dir, 'jobs', id + '.jsonl'); const target = f + '.real'; fs.renameSync(f, target); fs.symlinkSync(target, f); },
    // A damaged line in the middle (a torn last line is crash residue and deliberately tolerated).
    (dir, id) => { const f = path.join(dir, 'jobs', id + '.jsonl'); fs.writeFileSync(f, 'not json\n' + fs.readFileSync(f, 'utf8')); },
    (dir) => { for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, 'jobs', `x${i}.tmp`), ''); },
  ];
  for (const [i, damage] of cases.entries()) {
    const dir = tmp();
    try {
      const jobs = createJobs({ dir });
      const id = jobs.create({ kind: 'code' });
      damage(dir, id);
      assert.throws(() => createJobs({ dir }).list({ strict: true, cap: 4 }), unknown, `case ${i}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('strict mode still reports active and finished jobs exactly as list() does', async () => {
  const dir = tmp();
  try {
    const jobs = createJobs({ dir });
    const running = jobs.create({ kind: 'code' });
    jobs.append(running, 'job.started', {});
    const done = jobs.create({ kind: 'code' });
    await jobs.run(done, async () => ({ ok: true }));
    assert.deepEqual(jobs.list({ strict: true, active: true }).map((j) => j.id), [running]);
    assert.deepEqual(jobs.list({ strict: true }), jobs.list());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
