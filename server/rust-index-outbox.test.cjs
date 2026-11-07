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
const { createIndexOutbox, OUTBOX_FILE } = require('./rust-index-outbox.cjs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY, kind TEXT NOT NULL, project TEXT NOT NULL, file TEXT, payload TEXT,
  generation INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project);
CREATE TABLE IF NOT EXISTS tombstones (project TEXT PRIMARY KEY, generation INTEGER NOT NULL, at INTEGER NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('generation', 0);`;

test('native-owned outbox exposes lifecycle reads without a Node drainer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-reader-'));
  try {
    const dir = path.join(root, 'u1'); fs.mkdirSync(dir);
    const db = new DatabaseSync(path.join(dir, OUTBOX_FILE)); db.exec(SCHEMA);
    db.prepare("UPDATE meta SET value=7 WHERE key='generation'").run();
    db.prepare('INSERT INTO tombstones VALUES (?, ?, ?)').run('p1', 7, 1); db.close();
    const reader = createIndexOutbox({ userDir: id => path.join(root, id) });
    assert.equal(reader.generation('u1'), 7);
    assert.equal(reader.deletedSince('p1', 'u1'), true);
    assert.equal(reader.deletedSince('p2', 'u1'), false);
    assert.equal(reader.generation('u2'), 0);
    for (const method of ['drain', 'tick', 'kick']) assert.equal(reader[method], undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
