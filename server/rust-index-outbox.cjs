'use strict';
// sbstndalton/noevia#2191 round 2: the executor of the Rust front's index outbox
// (users/<id>/index-outbox.db, noevia-rs crates/server-projects outbox.rs). The front owns the
// project writes (create, delete: rust-project-lifecycle.cjs) and records in the same request what
// they leave to do where its engine is: here, the RAG index (sqlite-vec is loaded by rag.cjs only).
// Round 3 (rust-project-storage.cjs): the front has a storage write client and runs the `sweep` jobs
// (the empty storage folder sweep) itself. This side claims, recovers and counts only CORE_KINDS; a
// job of another kind is the front's and is never touched here.
//
// Contract with the front (both sides keep it):
//   - jobs(key PRIMARY KEY, kind, project, file, payload, generation, state, attempts, claimed_at):
//     the front upserts a key as `pending` at a new generation; this side claims a row at its
//     generation (`running`), runs it, and deletes it only at that generation. Work the front asked
//     for again meanwhile stays pending and runs again: nothing is lost, nothing runs twice at once.
//   - A `running` row at this process's start was cut short by a crash or restart: it is pending again
//     (at least once; every job is idempotent: an index run indexes the file's text as it is now,
//     rag.cjs replaces the file's rows in one transaction).
//   - A job that keeps failing is retried up to MAX_ATTEMPTS times, then kept as `failed` for review.
//   - tombstones(project, generation): a project the front deleted at that generation. An index run
//     started before it (rag.cjs captures `generation()` when it is queued) stops at its next step and
//     closes its database handle, so it never recreates the deleted project's index.
//
// The outbox is read through rust-generation.cjs's stamped reader: no boot cache, a change on the
// other side is seen on the next use. Tenant-scoped: each user's outbox is in that user's directory
// and its jobs run in that user's request scope (`runAs`).
const fs = require('node:fs');
const path = require('node:path');
const { createStampedReader } = require('./rust-generation.cjs');

const OUTBOX_FILE = 'index-outbox.db';
const { CORE_KINDS } = require('./rust-project-storage.cjs');
// `kind IN ('index')`: the kinds are fixed identifiers (checked), never user input.
function kindSql(kinds) {
  if (!Array.isArray(kinds) || !kinds.length || !kinds.every((k) => typeof k === 'string' && /^[a-z]+$/.test(k))) throw new Error('outbox kinds must be lower-case identifiers');
  return `kind IN (${kinds.map((k) => `'${k}'`).join(', ')})`;
}
const MAX_ATTEMPTS = 5;

function defaultOpen(file) {
  let DatabaseSync = null;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* older runtime */ }
  if (DatabaseSync) { const db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout = 5000'); return db; }
  const Database = require('better-sqlite3');
  const db = new Database(file);
  db.pragma('busy_timeout = 5000');
  return db;
}

function createIndexOutbox({ userDir, userIds = () => [], runAs = (_userId, fn) => fn(), runJob, open = defaultOpen, warn = console.warn, maxAttempts = MAX_ATTEMPTS, kinds = CORE_KINDS }) {
  const KIND_SQL = kindSql(kinds);
  const users = new Map(); // userId -> { file, reader, recovered, draining }

  function stateFor(userId) {
    let s = users.get(userId);
    if (s) return s;
    const file = path.join(userDir(userId), OUTBOX_FILE);
    s = {
      file,
      recovered: false,
      draining: null,
      // { generation, tombstones: Map(project -> generation), pending } as last read.
      reader: createStampedReader({
        files: [file, `${file}-wal`],
        fallback: { generation: 0, tombstones: new Map(), pending: 0 },
        load: () => {
          if (!fs.existsSync(file)) return { generation: 0, tombstones: new Map(), pending: 0 };
          const db = open(file);
          try {
            const generation = Number(db.prepare("SELECT value FROM meta WHERE key = 'generation'").get()?.value || 0);
            const tombstones = new Map(db.prepare('SELECT project, generation FROM tombstones').all().map((r) => [r.project, Number(r.generation)]));
            const pending = Number(db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state IN ('pending', 'running') AND ${KIND_SQL}`).get()?.n || 0);
            return { generation, tombstones, pending };
          } finally { db.close(); }
        },
      }),
    };
    users.set(userId, s);
    return s;
  }

  /** The outbox generation of `userId` now (0 without an outbox). */
  function generation(userId) {
    if (!userId) return 0;
    return stateFor(userId).reader.get().generation;
  }

  /** Whether the front deleted `projectId` after generation `seen` (an index run queued then must stop). */
  function deletedSince(projectId, userId, seen) {
    if (!userId) return false;
    const at = stateFor(userId).reader.get().tombstones.get(projectId);
    return at !== undefined && at > (Number(seen) || 0);
  }

  async function runOne(userId, db, row) {
    const claimed = db.prepare("UPDATE jobs SET state = 'running', claimed_at = ?, attempts = attempts + 1 WHERE key = ? AND generation = ? AND state = 'pending'")
      .run(Date.now(), row.key, row.generation);
    if (!Number(claimed.changes)) return 'skipped';
    let ok = true;
    try { await runAs(userId, () => runJob({ ...row, payload: row.payload ? JSON.parse(row.payload) : null }, userId)); }
    catch (err) { ok = false; warn(`[index-outbox] ${row.kind} job for ${row.project} failed: ${String((err && err.message) || err).slice(0, 200)}`); }
    if (ok) { db.prepare('DELETE FROM jobs WHERE key = ? AND generation = ?').run(row.key, row.generation); return 'done'; }
    const attempts = Number(row.attempts || 0) + 1;
    db.prepare("UPDATE jobs SET state = ?, claimed_at = NULL WHERE key = ? AND generation = ? AND state = 'running'")
      .run(attempts >= maxAttempts ? 'failed' : 'pending', row.key, row.generation);
    return 'failed';
  }

  /** Runs every pending job of `userId` once, oldest first. One drain per user at a time. */
  function drain(userId) {
    const s = stateFor(userId);
    if (s.draining) return s.draining;
    s.draining = (async () => {
      const out = { done: 0, failed: 0 };
      if (!fs.existsSync(s.file)) return out;
      let db;
      try { db = open(s.file); } catch (err) { warn(`[index-outbox] cannot open ${userId}'s outbox: ${err.message}`); return out; }
      try {
        if (!s.recovered) {
          // A claim this process never acknowledged (it restarted): pending again.
          db.prepare(`UPDATE jobs SET state = 'pending', claimed_at = NULL WHERE state = 'running' AND ${KIND_SQL}`).run();
          s.recovered = true;
        }
        const rows = db.prepare(`SELECT key, kind, project, file, payload, generation, attempts FROM jobs WHERE state = 'pending' AND ${KIND_SQL} ORDER BY generation, key`).all();
        for (const row of rows) {
          const r = await runOne(userId, db, row);
          if (r === 'done') out.done += 1; else if (r === 'failed') out.failed += 1;
        }
      } finally { db.close(); }
      return out;
    })().finally(() => { s.draining = null; });
    return s.draining;
  }

  /** One pass over every account whose outbox has work. */
  async function tick() {
    const results = {};
    for (const userId of userIds()) {
      let pending = 0;
      try { pending = stateFor(userId).reader.get().pending; } catch { pending = 0; }
      if (pending > 0) results[userId] = await drain(userId);
    }
    return results;
  }

  // A pass started now unless one is running (index.cjs kicks one at each request start, so work the
  // front queued is picked up at once, not only on the interval). Never throws.
  let kicked = null;
  function kick() {
    if (!kicked) kicked = tick().catch((err) => { warn(`[index-outbox] pass failed: ${err.message}`); }).finally(() => { kicked = null; });
    return kicked;
  }

  return { generation, deletedSince, drain, tick, kick, file: (userId) => stateFor(userId).file };
}

module.exports = { OUTBOX_FILE, MAX_ATTEMPTS, createIndexOutbox };
