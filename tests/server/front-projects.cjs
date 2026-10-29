'use strict';
// #2191 round 2: POST /api/projects is the Rust front's (server/rust-project-lifecycle.cjs), so a Node
// test can no longer create its fixture project through this process. This writes the project the
// front writes for a plain create (noevia-rs crates/server-projects lifecycle.rs: Node's keys in
// Node's order, put first in the list) straight into the account's projects.json, as the front's
// save leaves it; this process takes it in at the next request start (rust-projects.cjs refresh).
// Test-only; synthetic data. The create's own behaviour is tested in noevia-rs tests/project_lifecycle.rs.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function createProjectAs(dataDir, userId, body = {}) {
  const dir = path.join(dataDir, 'users', userId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'projects.json');
  const now = Date.now();
  const project = {
    id: `proj-${now}-${crypto.randomBytes(3).toString('hex')}`,
    name: String(body.name || 'Synthetic').trim().slice(0, 120),
    goal: String(body.goal || '').slice(0, 2000),
    instructions: String(body.instructions || '').slice(0, 8000),
    pinned: false, archived: false, sourceFolders: [], memories: [],
    files: Array.isArray(body.files) ? body.files.filter((f) => f && typeof f.name === 'string' && typeof f.content === 'string').map((f) => ({ name: f.name, content: f.content })) : [],
    ...(body.model ? { model: body.model } : {}),
    routing: body.routing === 'manual' ? 'manual' : 'auto',
    modes: Array.isArray(body.modes) ? ['chat', ...['cowork', 'code'].filter((m) => body.modes.includes(m))] : ['chat'],
    toolboxes: Array.isArray(body.toolboxes) ? body.toolboxes : ['core'],
    toolsMode: Array.isArray(body.toolboxes) ? 'manual' : 'auto',
    chats: [], createdAt: now, updatedAt: now,
    ...(body.extra || {}),
  };
  // The folder the front reserves with browsable storage (#589; the id is unique, so its first name).
  if (body.reserveIn) project.reservedFolder = `${body.reserveIn}/${project.id}`;
  // #1806: the texts in their own files, as the front's create writes them (source-text.cjs format).
  require('../../server/source-text.cjs').externalize(dir, [project]);
  let projects = [];
  try { projects = JSON.parse(fs.readFileSync(file, 'utf8')).projects || []; } catch { projects = []; }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ projects: [project, ...projects] }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return project;
}

module.exports = { createProjectAs };
