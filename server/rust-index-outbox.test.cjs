'use strict';
// #2191 round 2: the executor of the Rust front's index outbox (rust-index-outbox.cjs). The outbox is
// written here exactly as noevia-rs crates/server-projects outbox.rs writes it (same schema, same
// upsert and tombstone transactions): synthetic jobs only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createIndexOutbox, OUTBOX_FILE, MAX_ATTEMPTS } = require('./rust-index-outbox.cjs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY, kind TEXT NOT NULL, project TEXT NOT NULL, file TEXT, payload TEXT,
  generation INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project);
CREATE TABLE IF NOT EXISTS tombstones (project TEXT PRIMARY KEY, generation INTEGER NOT NULL, at INTEGER NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('generation', 0);`;

/** The front's side: outbox.rs enqueue / tombstone. */
function front(dir) {
  const file = path.join(dir, OUTBOX_FILE);
  const tx = (fn) => { const db = new DatabaseSync(file); db.exec('PRAGMA journal_mode = WAL'); db.exec(SCHEMA); db.exec('BEGIN IMMEDIATE');
    try { db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'generation'").run(); const g = Number(db.prepare("SELECT value FROM meta WHERE key = 'generation'").get().value); fn(db, g); db.exec('COMMIT'); return g; }
    catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.close(); } };
  return {
    index: (project, files) => tx((db, g) => { for (const f of files) db.prepare(`INSERT INTO jobs (key, kind, project, file, payload, generation, state, attempts, claimed_at, created_at)
      VALUES (?, 'index', ?, ?, NULL, ?, 'pending', 0, NULL, 1) ON CONFLICT(key) DO UPDATE SET generation = excluded.generation, payload = excluded.payload, state = 'pending', attempts = 0, claimed_at = NULL`)
      .run(JSON.stringify(['index', project, f]), project, f, g); }),
    tombstone: (project, folder) => tx((db, g) => {
      db.prepare('INSERT INTO tombstones (project, generation, at) VALUES (?, ?, 1) ON CONFLICT(project) DO UPDATE SET generation = excluded.generation').run(project, g);
      db.prepare("DELETE FROM jobs WHERE project = ? AND kind IN ('index', 'unindex')").run(project);
      if (folder) db.prepare("INSERT INTO jobs (key, kind, project, file, payload, generation, created_at) VALUES (?, 'sweep', ?, NULL, ?, ?, 1)").run(JSON.stringify(['sweep', project]), project, JSON.stringify({ folder }), g);
    }),
    rows: () => { const db = new DatabaseSync(file); try { return db.prepare('SELECT key, kind, project, file, generation, state, attempts FROM jobs ORDER BY key').all().map((r) => ({ ...r })); } finally { db.close(); } },
    file,
  };
}

function world(t, runJob) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-index-outbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = { u1: path.join(root, 'u1'), u2: path.join(root, 'u2') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d);
  const scopes = [];
  const make = () => createIndexOutbox({ userDir: (u) => dirs[u], userIds: () => Object.keys(dirs), runAs: (u, fn) => { scopes.push(u); return fn(); }, runJob, warn: () => {} });
  return { dirs, make, scopes, f1: front(dirs.u1), f2: front(dirs.u2) };
}

test('each job runs once, in its own account, and is acknowledged; nothing runs for an account without an outbox', async (t) => {
  const ran = [];
  const w = world(t, async (job, userId) => { ran.push([userId, job.kind, job.project, job.file]); });
  const outbox = w.make();
  assert.deepEqual(await outbox.tick(), {}, 'no outbox anywhere: nothing opened');
  assert.equal(fs.existsSync(w.f2.file), false);
  w.f1.index('p1', ['a.md', 'b.md']);
  w.f1.index('p1', ['a.md']); // the same work again: one job at the newer generation
  await outbox.tick();
  assert.deepEqual(ran, [['u1', 'index', 'p1', 'b.md'], ['u1', 'index', 'p1', 'a.md']]);
  assert.deepEqual(w.scopes, ['u1', 'u1']);
  assert.deepEqual(w.f1.rows(), []);
  await outbox.tick();
  assert.equal(ran.length, 2, 'acknowledged work never runs twice');
});

test('work asked for again while its job runs stays pending and runs again', async (t) => {
  let release;
  const ran = [];
  const w = world(t, async (job) => { ran.push(job.generation); if (ran.length === 1) await new Promise((r) => { release = r; }); });
  const outbox = w.make();
  const g1 = w.f1.index('p1', ['a.md']);
  const pass = outbox.tick();
  while (!release) await new Promise((r) => setImmediate(r));
  const g2 = w.f1.index('p1', ['a.md']); // re-requested mid-run
  release();
  await pass;
  assert.deepEqual(w.f1.rows().map((r) => [r.state, r.generation]), [['pending', g2]], 'not acknowledged at the old generation');
  await outbox.tick();
  assert.deepEqual(ran, [g1, g2]);
  assert.deepEqual(w.f1.rows(), []);
});

test('a claim cut short by a restart runs again in the next process (at least once)', async (t) => {
  const w = world(t, async () => { throw new Error('crash stand-in'); });
  w.f1.index('p1', ['a.md']);
  // The previous process claimed it and died: the row is `running`.
  { const db = new DatabaseSync(w.f1.file); db.prepare("UPDATE jobs SET state = 'running', attempts = 1").run(); db.close(); }
  const ran = [];
  const fresh = createIndexOutbox({ userDir: (u) => w.dirs[u], userIds: () => ['u1'], runJob: async (job) => { ran.push(job.file); }, warn: () => {} });
  await fresh.tick();
  assert.deepEqual(ran, ['a.md']);
  assert.deepEqual(w.f1.rows(), []);
});

test('a job that keeps failing is retried, then kept as failed for review', async (t) => {
  let tries = 0;
  const w = world(t, async () => { tries += 1; throw new Error('embedding down'); });
  const outbox = w.make();
  w.f1.index('p1', ['a.md']);
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await outbox.drain('u1');
  assert.equal(tries, MAX_ATTEMPTS);
  assert.deepEqual(w.f1.rows().map((r) => [r.state, r.attempts]), [['failed', MAX_ATTEMPTS]]);
});

test('a delete tombstones the project: queued index work is dropped, an earlier run sees it, a later one does not; the sweep is the front\'s', async (t) => {
  const ran = [];
  const w = world(t, async (job) => { ran.push([job.kind, job.project, job.payload]); });
  const outbox = w.make();
  w.f1.index('p1', ['a.md']);
  const seen = outbox.generation('u1');
  assert.equal(outbox.deletedSince('p1', 'u1', seen), false);
  const g = w.f1.tombstone('p1', 'noevia projects/p1');
  assert.equal(outbox.generation('u1'), g, 'the change is seen on the next use');
  assert.equal(outbox.deletedSince('p1', 'u1', seen), true, 'a run queued before the delete stops');
  assert.equal(outbox.deletedSince('p1', 'u1', g), false, 'a run queued after it (a project made again) is not stopped');
  assert.equal(outbox.deletedSince('p2', 'u1', seen), false);
  assert.equal(outbox.deletedSince('p1', 'u2', 0), false, 'another account is unaffected');
  await outbox.tick();
  // #2191 round 3 (rust-project-storage.cjs): the sweep job is run by the front, never here.
  assert.deepEqual(ran, []);
  assert.deepEqual(w.f1.rows().map((r) => [r.kind, r.state, r.attempts]), [['sweep', 'pending', 0]]);
});

test('the front\'s job kinds are never claimed, recovered or counted here (round 3)', async (t) => {
  const ran = [];
  const w = world(t, async (job) => { ran.push([job.kind, job.project]); });
  w.f1.index('p1', ['a.md']);
  w.f1.tombstone('p2', 'noevia projects/p2');
  // Both rows claimed by a process that died: only this side's kind is taken back here.
  { const db = new DatabaseSync(w.f1.file); db.prepare("UPDATE jobs SET state = 'running', attempts = 1").run(); db.close(); }
  const outbox = w.make();
  await outbox.drain('u1');
  assert.deepEqual(ran, [['index', 'p1']]);
  assert.deepEqual(w.f1.rows().map((r) => [r.kind, r.state]), [['sweep', 'running']]);
  // A pending sweep alone is no work here: a tick drains nothing for it.
  { const db = new DatabaseSync(w.f1.file); db.prepare("UPDATE jobs SET state = 'pending'").run(); db.close(); }
  assert.deepEqual(await w.make().tick(), {});
  assert.deepEqual(ran, [['index', 'p1']]);
});

test('an unindex job (a removed source file, round 3) is claimed and run here; a delete drops it', async (t) => {
  const ran = [];
  const w = world(t, async (job) => { ran.push([job.kind, job.project, job.file]); });
  const outbox = w.make();
  const unindex = (project, file) => { const db = new DatabaseSync(w.f1.file); db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'generation'").run();
    const g = Number(db.prepare("SELECT value FROM meta WHERE key = 'generation'").get().value);
    db.prepare("INSERT INTO jobs (key, kind, project, file, payload, generation, created_at) VALUES (?, 'unindex', ?, ?, NULL, ?, 1)").run(JSON.stringify(['unindex', project, file]), project, file, g); db.close(); };
  w.f1.index('p1', ['keep.md']);
  unindex('p1', 'gone.md');
  unindex('p2', 'x.md');
  w.f1.tombstone('p2');
  await outbox.drain('u1');
  assert.deepEqual(ran.sort(), [['index', 'p1', 'keep.md'], ['unindex', 'p1', 'gone.md']]);
  assert.deepEqual(w.f1.rows(), []);
});

test('rust-project-storage.cjs splits the kinds and owns no route', () => {
  const { OWNED_ROUTES, CORE_KINDS, FRONT_KINDS } = require('./rust-project-storage.cjs');
  assert.equal(OWNED_ROUTES.size, 0);
  assert.deepEqual([...CORE_KINDS], ['index', 'unindex']);
  assert.deepEqual([...FRONT_KINDS], ['sweep']);
  assert.ok(CORE_KINDS.every((k) => /^[a-z]+$/.test(k) && !FRONT_KINDS.includes(k)));
});

test('rag.cjs stops an index run its project was deleted under (lifecycle guard)', () => {
  const rag = require('./rag.cjs');
  assert.equal(typeof rag.setLifecycleGuard, 'function');
  const src = fs.readFileSync(path.join(__dirname, 'rag.cjs'), 'utf8');
  assert.match(src, /userActive\(userId\)\) && alive\(\), version\)\);/);
  assert.match(src, /!signal\?\.aborted && alive\(\),/);
  rag.setLifecycleGuard(null); // back to the default guard
});

test('a kick starts one pass at a time and never throws', async (t) => {
  let runs = 0;
  const w = world(t, async () => { runs += 1; });
  const outbox = w.make();
  w.f1.index('p1', ['a.md']);
  const a = outbox.kick(), b = outbox.kick();
  assert.equal(a, b, 'a pass in flight is shared');
  await a;
  assert.equal(runs, 1);
  const broken = createIndexOutbox({ userDir: () => { throw new Error('no dir'); }, userIds: () => ['u1'], runJob: async () => {}, warn: () => {} });
  await broken.kick();
});
