'use strict';
// Compiled ownership contract. No runtime switch or snapshot grants ownership.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { trustedFront } = require('./trusted-front.cjs');
const RUST_EMBEDDING_OWNED = 'rust-embedding-background-v1';
const RUST_INDEX_OUTBOX_OWNED = require('./rust-index-outbox.cjs').RUST_INDEX_OUTBOX_OWNED;
const PROTOCOL = 'rust-embedding-worker-v1';
// All checks and scheduling run synchronously after the notification body is read.
function createSourceMembershipGuard({ userExists, workspaceFor }) {
  return (user, project, file) => {
    try {
      if (!userExists(user)) return false;
      const workspace = workspaceFor(user);
      workspace.assertActive();
      workspace.projectsFile?.refresh(workspace.projects);
      const current = workspace.projects.find(p => p && p.id === project);
      return !!current && Array.isArray(current.files) && current.files.some(f => f && f.name === file);
    } catch { return false; }
  };
}
// frontSecret: the per-start store secret, captured before project-store-client deletes it from process.env (#1916).
function createOwner({ requiredFeatures = [], sourceMember = () => false, sourceChanged = (user, project) => require('./multimodal-rag.cjs').sourceChanged(user, project), foregroundBusy = () => require('./rag.cjs').foregroundBusy(), env = process.env, frontSecret = '', dataDir, now = Date.now, verifyPair = true, features = () => execFileSync(env.NOEVIA_SERVER_BIN || '/usr/local/bin/noevia-server', ['--features'], { encoding: 'utf8', timeout: 5000 }) }) {
  const start = String(env.NOEVIA_START_ID || '');
  if (verifyPair && (!start || !frontSecret || ![RUST_EMBEDDING_OWNED, RUST_INDEX_OUTBOX_OWNED, ...requiredFeatures].every(f => features().split(/\s+/).includes(f)))) throw Error('Embedding background requires a coherent paired front and current start');
  let stopped = false, sequence = 0;
  return {
    snapshot() {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dataDir, 'embedding-worker-status.json'), 'utf8'));
        return s.protocol === PROTOCOL && s.start === start && Number.isFinite(s.at) && s.at <= now() && now() - s.at <= 15000 ? s : null;
      } catch { return null; }
    },
    // Retrieval health only: optional embedding work never gates process readiness.
    healthy() { const s = this.snapshot(); return !stopped && verifyPair && !!s && s.configValid !== false; },
    kick() {
      if (stopped) return;
      fs.mkdirSync(dataDir, { recursive: true });
      const file = path.join(dataDir, 'embedding-worker-request.json'), tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ start, sequence: ++sequence }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
    handle(req, res, json) {
      if (req.url !== '/internal/embedding-worker-owner') return false;
      if (req.method !== 'GET' || !verifyPair || stopped || !trustedFront(req, frontSecret)) json(res, 404, { error: 'Not found' });
      else json(res, 200, { protocol: PROTOCOL, start, nodeWorkersStopped: true, indexOutboxStopped: true, foregroundBusy: !!foregroundBusy() });
      return true;
    },
    // Media remains Node-owned. This delegate only schedules its existing
    // media pass; native remains the sole index/unindex outbox executor.
    async handleSourceChanged(req, res, json) {
      if (req.url !== '/internal/embedding-worker-owner/source-changed') return false;
      if (req.method !== 'POST' || !verifyPair || stopped || !trustedFront(req, frontSecret)) { json(res, 404, { error: 'Not found' }); return true; }
      let body;
      try { body = await require('./http.cjs').readJson(req, 4096); } catch { json(res, 400, { error: 'Invalid notification' }); return true; }
      if (typeof body?.file !== 'string' || body?.start !== start || typeof body.user !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.user) || typeof body.project !== 'string' || !body.project || body.project.length > 256 || body.project.startsWith('.') || /[/\\\x00]/.test(body.project)) { json(res, 400, { error: 'Invalid notification' }); return true; }
      // No await between this fresh check and scheduling: a delayed body may
      // refer to an account/source removed after the native preflight.
      let member = false;
      try { member = sourceMember(body.user, body.project, body.file) === true; } catch { /* fail closed */ }
      if (member) {
        try { sourceChanged(body.user, body.project); }
        catch { json(res, 503, { error: 'Media notification unavailable' }); return true; }
      }
      json(res, 200, { protocol: PROTOCOL, start, notified: true });
      return true;
    },
    stop() { stopped = true; },
  };
}
// Kept for the legacy pair for one release; paired startup never registers these timers.
function scheduleLegacy({ owner, env, config, service, migration, afterReady, interval = setInterval, timeout = setTimeout, clear = clearTimeout }) {
  let stopped = false;
  const timers = [];
  if (!owner) afterReady(() => {
    if (stopped) return;
    if (env.MODEL_LOADER_URL) { service.refresh(); timers.push(interval(() => service.refresh(), 10000)); }
    if (config.next()) timers.push(timeout(() => migration.kick(), 30000));
    for (const timer of timers) timer.unref?.();
  });
  return () => { stopped = true; timers.forEach(clear); owner?.stop(); return migration.stop(); };
}
module.exports = { RUST_EMBEDDING_OWNED, PROTOCOL, createOwner, createSourceMembershipGuard, scheduleLegacy };
