'use strict';
// D7 wiring: reads operator configuration, schedules one nightly snapshot + retention, keeps a
// small status file, and exposes run-now / restore-test for admins. Off unless
// features.offsiteBackup is on AND the destination and key are configured.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOffsiteBackup, loadKey } = require('./offsite-backup.cjs');
const { createS3Store } = require('./offsite-s3.cjs');

const ENV = ['OFFSITE_BACKUP_S3_ENDPOINT', 'OFFSITE_BACKUP_S3_BUCKET', 'OFFSITE_BACKUP_S3_ACCESS_KEY_ID', 'OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY', 'OFFSITE_BACKUP_KEY_FILE'];

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
  const missing = () => ENV.filter((k) => !String(env[k] || '').trim());
  let engine = null, busy = '';

  function build() {
    if (engine) return engine;
    if (backupFactory) return (engine = backupFactory());
    const store = createS3Store({ endpoint: env.OFFSITE_BACKUP_S3_ENDPOINT, bucket: env.OFFSITE_BACKUP_S3_BUCKET, region: env.OFFSITE_BACKUP_S3_REGION || 'us-east-1',
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
        retention: 'Keeps 7 daily, 4 weekly and 6 monthly snapshots', destination: env.OFFSITE_BACKUP_S3_ENDPOINT ? `${new URL(env.OFFSITE_BACKUP_S3_ENDPOINT).host} / ${env.OFFSITE_BACKUP_S3_BUCKET || '?'}` : null,
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

module.exports = { createOffsiteService, sqliteSnapshot, ENV };
