'use strict';
// Reads a day's Diary recovery records the way the Rust front lists them (noevia-rs
// crates/server-diary `exchanges::list`, GET /api/diary/exchanges; sbstndalton/noevia#2206): a record that
// reads `running` while nothing is published as running for it (diary-jobs.cjs `active.json`, written by
// the container start NOEVIA_START_ID names) reads `uncertain`. Test helper only: this process serves no
// such route any more.
const fs = require('node:fs');
const path = require('node:path');
const { START_ID } = require('../../server/chat-partial.cjs');

function published(workspace) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(workspace.dir, 'diary-conversations', 'active.json'), 'utf8'));
    return doc.start === START_ID && Array.isArray(doc.files) ? new Set(doc.files) : new Set();
  } catch { return new Set(); }
}

function rows(workspace, day) {
  const dir = path.join(workspace.dir, 'diary-conversations', day);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^[a-zA-Z0-9-]{16,80}\.json$/.test(n)).sort().map((name) => {
    try {
      const row = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (row && row.state === 'running' && !published(workspace).has(`${day}/${name}`)) row.state = 'uncertain';
      return row;
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => a.startedAt - b.startedAt).slice(-100);
}

module.exports = { rows, published };
