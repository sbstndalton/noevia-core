'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createOffsiteService, sqliteSnapshot } = require('./offsite-service.cjs');
const { createOffsiteBackup } = require('./offsite-backup.cjs');
const { createOffsiteRoutes } = require('./routes/offsite-backup.cjs');

const memoryStore = () => { const m = new Map(); return { put: async (k, v) => { m.set(k, v); }, get: async (k) => m.get(k) || null, list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)), delete: async (k) => { m.delete(k); } }; };
function setup(t, { enabled = true, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-offsite-svc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'projects.json'), '{}');
  let clock = Date.parse('2026-09-17T03:05:00');
  const flags = { enabled };
  const store = memoryStore();
  const service = createOffsiteService({ env, dataDir: dir, now: () => clock, features: { enabled: () => flags.enabled },
    backupFactory: env.real ? null : () => createOffsiteBackup({ store, key: crypto.randomBytes(32), paths: [dir], now: () => clock }) });
  return { service, dir, flags, advance: (ms) => { clock += ms; } };
}

test('off by default and unconfigured deployments refuse to run and say why', async (t) => {
  const { service, flags } = setup(t, { enabled: false, env: { real: true } });
  assert.match(service.status().reason, /turned off/);
  await assert.rejects(() => service.runNow(), /turned off/);
  flags.enabled = true;
  assert.match(service.status().reason, /OFFSITE_BACKUP_S3_ENDPOINT/);
  await assert.rejects(() => service.verifyNow(), /Not configured/);
});

test('run now snapshots, applies retention, records status; restore test verifies', async (t) => {
  const { service } = setup(t);
  await assert.rejects(() => service.verifyNow(), /no snapshot/);
  assert.equal(service.status().lastError.during, 'restore test');
  const last = await service.runNow();
  assert.equal(last.files, 2);
  const status = service.status();
  assert.deepEqual([status.snapshots, status.lastError, status.ready], [1, null, true]);
  assert.equal((await service.verifyNow()).files, 2);
});

test('schedule runs once in the configured hour, not again within 20 hours', async (t) => {
  const { service, advance } = setup(t);
  let tick; service.schedule((fn) => { tick = fn; return { unref() {} }; }, () => {});
  tick(); for (let i = 0; i < 50 && !service.status().lastBackup; i++) await new Promise((r) => setTimeout(r, 5));
  const first = service.status().lastBackup.at;
  advance(30 * 60000); tick(); await new Promise((r) => setTimeout(r, 30));
  assert.equal(service.status().lastBackup.at, first);
  advance(5 * 3600000); tick(); await new Promise((r) => setTimeout(r, 30));
  assert.equal(service.status().lastBackup.at, first, 'outside the hour nothing runs');
});

test('status never exposes credentials', (t) => {
  const { service } = setup(t, { env: { OFFSITE_BACKUP_S3_ENDPOINT: 'https://s3.example.test', OFFSITE_BACKUP_S3_BUCKET: 'b', OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY: 'TOPSECRET', OFFSITE_BACKUP_S3_ACCESS_KEY_ID: 'AKID' } });
  const text = JSON.stringify(service.status());
  assert.ok(!text.includes('TOPSECRET') && !text.includes('AKID'));
  assert.match(service.status().destination, /s3\.example\.test \/ b/);
});

test('routes are admin-only', async () => {
  const route = createOffsiteRoutes({ service: { status: () => ({ ok: 1 }), runNow: async () => ({ ran: 1 }), verifyNow: async () => { throw Object.assign(Error('x'), { status: 409, publicMessage: 'nothing yet' }); } }, json: (res, status, body) => Object.assign(res, { status, body }) });
  const call = async (method, p, role) => { const res = {}; await route({ method }, res, { path: p, authn: role ? { user: { role } } : null }); return res; };
  assert.equal((await call('GET', '/api/admin/offsite-backup', 'member')).status, 403);
  assert.deepEqual((await call('POST', '/api/admin/offsite-backup/run', 'admin')).body, { ran: 1 });
  assert.deepEqual((await call('POST', '/api/admin/offsite-backup/verify', 'admin')).body, { error: 'nothing yet' });
  assert.equal((await call('GET', '/api/admin/offsite-backup/run', 'admin')).status, 405);
});

test('sqlite snapshot copies a live database consistently', async (t) => {
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-sqlite-live-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'auth.db'); const db = new Database(file); db.pragma('journal_mode = WAL');
  db.exec("CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('synthetic')");
  const copy = await sqliteSnapshot(file);
  db.close();
  const restored = path.join(dir, 'restored.db'); fs.writeFileSync(restored, copy);
  const check = new Database(restored, { readonly: true });
  assert.equal(check.prepare('SELECT v FROM t').get().v, 'synthetic', 'WAL content is included');
  check.close();
  assert.equal(await sqliteSnapshot(path.join(dir, 'notes.json')), null);
});
