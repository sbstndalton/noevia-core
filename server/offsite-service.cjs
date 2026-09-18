'use strict';
// D7 wiring: reads operator configuration, schedules one nightly snapshot + retention, keeps a
// small status file, and exposes run-now / restore-test for admins. Off unless
// features.offsiteBackup is on AND the destination and key are configured.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOffsiteBackup, loadKey } = require('./offsite-backup.cjs');
const { createS3Store } = require('./offsite-s3.cjs');
const { createDirStore } = require('./offsite-dir.cjs');

const ENV = ['OFFSITE_BACKUP_S3_ENDPOINT', 'OFFSITE_BACKUP_S3_BUCKET', 'OFFSITE_BACKUP_S3_ACCESS_KEY_ID', 'OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY', 'OFFSITE_BACKUP_KEY_FILE'];
// A folder destination, mirrored elsewhere by the host (Google Drive via rclone): no S3 keys.
const DIR_ENV = ['OFFSITE_BACKUP_DIR', 'OFFSITE_BACKUP_KEY_FILE'];

/**
 * The destination folder may not overlap anything being backed up: inside a backed-up path it
 * would back itself up on every run, growing without bound; containing one, a restore could
 * land on top of its own source.
 */
function checkDestination(dir, paths, fsImpl = fs) {
  let real;
  try { real = fsImpl.realpathSync(dir); }
  catch { throw Object.assign(Error(`The backup folder ${dir} does not exist.`), { status: 409, publicMessage: `The backup folder ${dir} does not exist.` }); }
  for (const root of paths) {
    let r; try { r = fsImpl.realpathSync(root); } catch { continue; }
    if (real === r || real.startsWith(r + path.sep) || r.startsWith(real + path.sep)) {
      const message = 'The backup folder must not overlap the folders being backed up.';
      throw Object.assign(Error(message), { status: 409, publicMessage: message });
    }
  }
  return real;
}

/** A consistent copy of a live SQLite database via the online backup API. */
async function sqliteSnapshot(abs) {
  if (!/\.(db|sqlite3?)$/.test(abs)) return null;
  const Database = require('better-sqlite3');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-sqlite-')), 'copy.db');
  let db;
  try {
    db = new Database(abs, { readonly: true, fileMustExist: true });
    await db.backup(tmp);
    return fs.readFileSync(tmp);
  } catch { return null; } finally { try { db?.close(); } catch { /* closed */ } fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); }
}

/**
 * The host mirror's last word, from the dot file rclone-sync.sh leaves in the store folder.
 * noevia cannot see rclone or its config, and should not: this is the only thing it learns.
 * A mirror that has not reported for two days is stale, whatever it last said.
 */
function readMirror(dir, now = Date.now(), fsImpl = fs) {
  if (!dir) return null;
  let raw;
  try { raw = JSON.parse(fsImpl.readFileSync(path.join(dir, '.mirror-status.json'), 'utf8')); }
  catch { return { state: 'unknown', at: null, message: 'The copy to Google Drive has not run yet.' }; }
  const states = ['ok', 'not-connected', 'waiting', 'refused', 'failed'];
  const state = states.includes(raw.state) ? raw.state : 'unknown';
  const at = Number.isFinite(raw.at) ? raw.at : null;
  const message = typeof raw.message === 'string' ? raw.message.slice(0, 300) : '';
  if (state === 'ok' && at && now - at > 2 * 86400000) {
    return { state: 'stale', at, message: 'The last copy to Drive is more than two days old.' };
  }
  return { state, at, message };
}

function createOffsiteService({ env = process.env, features, dataDir, now = Date.now, log = () => {}, backupFactory = null }) {
  const statusFile = path.join(dataDir, 'offsite-backup-status.json');
  const paths = String(env.OFFSITE_BACKUP_PATHS || dataDir).split(',').map((p) => p.trim()).filter(Boolean);
  const hour = Math.min(23, Math.max(0, Number.parseInt(env.OFFSITE_BACKUP_HOUR ?? '3', 10) || 0));
  const readStatus = () => { try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { return {}; } };
  const writeStatus = (patch) => {
    const next = { ...readStatus(), ...patch };
    const tmp = `${statusFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 }); fs.renameSync(tmp, statusFile);
    return next;
  };
  const useDir = () => !!String(env.OFFSITE_BACKUP_DIR || '').trim();
  const missing = () => (useDir() ? DIR_ENV : ENV).filter((k) => !String(env[k] || '').trim());
  let engine = null, busy = '';

  function build() {
    if (engine) return engine;
    if (backupFactory) return (engine = backupFactory());
    const store = useDir()
      ? createDirStore({ root: checkDestination(env.OFFSITE_BACKUP_DIR.trim(), paths) })
      : createS3Store({ endpoint: env.OFFSITE_BACKUP_S3_ENDPOINT, bucket: env.OFFSITE_BACKUP_S3_BUCKET, region: env.OFFSITE_BACKUP_S3_REGION || 'us-east-1',
        accessKeyId: env.OFFSITE_BACKUP_S3_ACCESS_KEY_ID, secretAccessKey: env.OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY, prefix: env.OFFSITE_BACKUP_S3_PREFIX || 'noevia-backup' });
    return (engine = createOffsiteBackup({ store, key: loadKey(env.OFFSITE_BACKUP_KEY_FILE, paths), paths, now, log, snapshotFile: sqliteSnapshot }));
  }
  const ready = () => {
    if (!features.enabled('offsiteBackup')) return 'Off-site backups are turned off (Settings → Features).';
    const gaps = missing();
    if (gaps.length && !backupFactory) return `Not configured: set ${gaps.join(', ')}.`;
    return null;
  };
  async function exclusive(label, work) {
    const reason = ready();
    if (reason) throw Object.assign(Error(reason), { status: 409, publicMessage: reason });
    if (busy) throw Object.assign(Error(`A ${busy} is already running.`), { status: 409, publicMessage: `A ${busy} is already running.` });
    busy = label;
    try { return await work(build()); }
    catch (error) {
      writeStatus({ lastError: { at: now(), during: label, message: String(error.publicMessage || error.message || 'failed').slice(0, 300) } });
      throw error;
    } finally { busy = ''; }
  }
  return {
    status() {
      const s = readStatus();
      return { enabled: features.enabled('offsiteBackup'), ready: !ready(), reason: ready(), busy: busy || null, schedule: `Daily at ${String(hour).padStart(2, '0')}:00 (server time)`,
        retention: 'Keeps 7 daily, 4 weekly and 6 monthly snapshots',
        // Naming where it goes, never how it authenticates.
        destination: useDir() ? `Folder ${env.OFFSITE_BACKUP_DIR.trim()}${env.OFFSITE_BACKUP_MIRROR ? `, mirrored to ${env.OFFSITE_BACKUP_MIRROR}` : ''}`
          : env.OFFSITE_BACKUP_S3_ENDPOINT ? `${new URL(env.OFFSITE_BACKUP_S3_ENDPOINT).host} / ${env.OFFSITE_BACKUP_S3_BUCKET || '?'}` : null,
        mirror: useDir() ? readMirror(env.OFFSITE_BACKUP_DIR.trim(), now()) : null,
        // What the one-time Google sign-in needs to know about the host. Paths and an SSH name
        // only: the sign-in runs on the admin's own computer and the token goes straight to the
        // host's rclone, never through noevia.
        connect: useDir() ? connectInfo(env) : null,
        paths: paths.length, lastBackup: s.lastBackup || null, lastVerify: s.lastVerify || null, lastError: s.lastError || null, snapshots: s.snapshots ?? null };
    },
    runNow: () => exclusive('backup', async (b) => {
      const snap = await b.backup();
      const retention = await b.forget();
      return writeStatus({ lastBackup: { at: now(), id: snap.id, files: snap.files, uploadedBytes: snap.uploadedBytes }, snapshots: retention.kept, lastError: null }).lastBackup;
    }),
    verifyNow: () => exclusive('restore test', async (b) => writeStatus({ lastVerify: await b.verify(os.tmpdir()), lastError: null }).lastVerify),
    /** Checks every 15 minutes; runs once a day in the configured hour. Returns a stop function. */
    schedule(setIntervalImpl = setInterval, clearIntervalImpl = clearInterval) {
      const tick = () => {
        if (ready() || busy) return;
        const last = readStatus().lastBackup?.at || 0;
        if (new Date(now()).getHours() === hour && now() - last > 20 * 3600000) this.runNow().catch((e) => log({ event: 'offsite.failed', message: e.message }));
      };
      const timer = setIntervalImpl(tick, 15 * 60000);
      timer?.unref?.();
      return () => clearIntervalImpl(timer);
    },
  };
}

/** Where the host keeps the sync script and key, as the admin reaches it over SSH. */
function connectInfo(env) {
  const clean = (v, fallback) => (String(v || '').trim() || fallback);
  return {
    sshHost: clean(env.OFFSITE_BACKUP_SSH_HOST, null),
    script: clean(env.OFFSITE_BACKUP_HOST_SCRIPT, '/mnt/docker/appdata/cowork/tools/offsite/rclone-sync.sh'),
    keyFile: clean(env.OFFSITE_BACKUP_HOST_KEY_FILE, '/mnt/docker/appdata/cowork/config/offsite-backup.key'),
    rcloneConfig: clean(env.OFFSITE_BACKUP_HOST_RCLONE_CONFIG, '/boot/config/rclone/rclone.conf'),
  };
}

module.exports = { connectInfo, readMirror, checkDestination, DIR_ENV, createOffsiteService, sqliteSnapshot, ENV };
