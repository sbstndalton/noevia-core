'use strict';
// Compiled pairing marker; source changes are hints, never outbox claims.
const RUST_MEDIA_BACKGROUND_OWNED = 'rust-media-background-v1';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function createClient({ dataDir, start, fsImpl = fs }) {
  let stopped = false, sequence = 0;
  const folder = path.join(dataDir, 'media-worker-requests');
  return {
    schedule(user, project) {
      if (stopped || !start || typeof user !== 'string' || typeof project !== 'string') return;
      const key = crypto.createHash('sha256').update(JSON.stringify([user, project])).digest('hex');
      fsImpl.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const file = path.join(folder, `${key}.json`), temporary = `${file}.${process.pid}.tmp`;
      fsImpl.writeFileSync(temporary, JSON.stringify({ start, user, project, sequence: ++sequence }), { mode: 0o600 });
      fsImpl.renameSync(temporary, file);
    },
    status() {
      try { const s = JSON.parse(fsImpl.readFileSync(path.join(dataDir, 'embedding-worker-status.json'), 'utf8')); return s.start === start ? s.media || null : null; } catch { return null; }
    },
    stop() { stopped = true; },
  };
}
module.exports = { RUST_MEDIA_BACKGROUND_OWNED, createClient };
