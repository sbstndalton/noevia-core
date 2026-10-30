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
      db.prepare("DELETE FROM jobs WHERE project = ? AND kind = 'index'").run(project);
      if (folder) db.prepare("INSERT INTO jobs (key, kind, project, file, payload, generation, created_at) VALUES (?, 'sweep', ?, NULL, ?, ?, 1)").run(JSON.stringify(['sweep', project]), project, JSON.stringify({ folder }), g);
    }),
    revive: (project) => tx((db) => { db.prepare('DELETE FROM tombstones WHERE project = ?').run(project); }), // outbox.rs revive_listed
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

test('a delete tombstones the project: queued index work is dropped, an earlier run sees it, a later one does not, the sweep runs', async (t) => {
  const ran = [];
  const w = world(t, async (job) => { ran.push([job.kind, job.project, job.payload]); });
  const outbox = w.make();
  w.f1.index('p1', ['a.md']);
  const seen = outbox.generation('u1');
  assert.equal(outbox.deletedSince('p1', 'u1', seen), false);
  const g = w.f1.tombstone('p1', 'noevia projects/p1');
  assert.equal(outbox.generation('u1'), g, 'the change is seen on the next use');
  assert.equal(outbox.deletedSince('p1', 'u1', seen), true, 'a run queued before the delete stops');
  assert.equal(outbox.deletedSince('p1', 'u1', g + 1), true, 'a run that started after the delete stops too');
  assert.equal(outbox.deletedSince('p2', 'u1', seen), false);
  assert.equal(outbox.deletedSince('p1', 'u2', 0), false, 'another account is unaffected');
  await outbox.tick();
  assert.deepEqual(ran, [['sweep', 'p1', { folder: 'noevia projects/p1' }]]);
  w.f1.revive('p1'); // a fixed id created again: the front's projects.json write lifts its tombstone
  assert.equal(outbox.deletedSince('p1', 'u1', 0), false, 'a project made again is indexed again');
});

test('a deleted project never gets its index back: not from a run that starts after the delete, nor one the delete lands in', async (t) => {
  const rag = require('./rag.cjs');
  const w = world(t, async () => {});
  const outbox = w.make();
  rag.init({ dataDir: path.dirname(w.dirs.u1), inferenceUrl: 'http://unused.invalid', userDataDirFn: (u) => w.dirs[u], userActive: () => true });
  t.after(() => rag.setLifecycleGuard(null));
  rag.setLifecycleGuard(outbox);
  const db = (p) => path.join(w.dirs.u1, 'rag', `${p}.db`);
  // The delete is already in the outbox when a slow request (an upload, a sources sync) indexes.
  w.f1.tombstone('p-dead', null);
  const late = await rag.indexProjectFile('p-dead', 'a.md', 'synthetic content', 'u1');
  assert.equal(late.stored || 0, 0, JSON.stringify(late));
  assert.equal(fs.existsSync(db('p-dead')), false, 'no index is made for a deleted project');
  // The delete lands while the index opens: the open made the file, which goes again.
  rag.setLifecycleGuard({ generation: () => 0, deletedSince: (p) => fs.existsSync(db(p)) });
  const raced = await rag.indexProjectFile('p-race', 'a.md', 'synthetic content', 'u1');
  assert.equal(raced.stored || 0, 0, JSON.stringify(raced));
  for (const f of [db('p-race'), `${db('p-race')}-wal`, `${db('p-race')}-shm`]) assert.equal(fs.existsSync(f), false, f);
  // A live project still indexes.
  rag.setLifecycleGuard(outbox);
  const live = await rag.indexProjectFile('p-live', 'a.md', 'synthetic content', 'u1');
  assert.ok(live.ok, JSON.stringify(live));
  assert.equal(fs.existsSync(db('p-live')), true);
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
