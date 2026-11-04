'use strict';
// Compiled ownership contract. No runtime switch or snapshot grants ownership.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { trustedFront } = require('./trusted-front.cjs');
const RUST_EMBEDDING_OWNED = 'rust-embedding-background-v1';
const PROTOCOL = 'rust-embedding-worker-v1';
function createOwner({ env = process.env, dataDir, now = Date.now, verifyPair = true, features = () => execFileSync(env.NOEVIA_SERVER_BIN || '/usr/local/bin/noevia-server', ['--features'], { encoding: 'utf8', timeout: 5000 }) }) {
  const start = String(env.NOEVIA_START_ID || '');
  if (verifyPair && (!start || !env.NOEVIA_PROJECT_STORE_TOKEN || !features().split(/\s+/).includes(RUST_EMBEDDING_OWNED))) throw Error('Embedding background requires a coherent paired front and current start');
  let stopped = false, sequence = 0;
  return {
    snapshot() {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dataDir, 'embedding-worker-status.json'), 'utf8'));
        return s.protocol === PROTOCOL && s.start === start && Number.isFinite(s.at) && s.at <= now() && now() - s.at <= 15000 ? s : null;
      } catch { return null; }
    },
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
      if (req.method !== 'GET' || !verifyPair || stopped || !trustedFront(req, env.NOEVIA_PROJECT_STORE_TOKEN)) json(res, 404, { error: 'Not found' });
      else json(res, 200, { protocol: PROTOCOL, start, nodeWorkersStopped: true });
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
module.exports = { RUST_EMBEDDING_OWNED, PROTOCOL, createOwner, scheduleLegacy };
