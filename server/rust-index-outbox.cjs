'use strict';
// Read-only tenant lifecycle view. The paired native front owns all outbox execution.
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

function createIndexOutbox({ userDir, open = defaultOpen, kinds = CORE_KINDS }) {
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

  /** Whether the front deleted `projectId`. Any tombstone counts, whenever the caller started: project
   * ids are random and never revived, so a run that began before the delete must stop just the same
   * (`seen` is kept for the callers' signature only). */
  function deletedSince(projectId, userId, _seen) {
    if (!userId) return false;
    return stateFor(userId).reader.get().tombstones.has(projectId);
  }

  return { generation, deletedSince, file: (userId) => stateFor(userId).file };
}

const RUST_INDEX_OUTBOX_OWNED = 'rust-index-outbox-v3';
module.exports = { OUTBOX_FILE, MAX_ATTEMPTS, createIndexOutbox, RUST_INDEX_OUTBOX_OWNED };
