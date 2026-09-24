'use strict';
// D7: destination-agnostic, client-side encrypted, versioned snapshots (restic-style) with
// retention and a restore test. Off by default behind features.offsiteBackup; the provider,
// bucket and budget are the operator's.
//
// Layout in the store (every object is encrypted; names reveal nothing about content):
//   config                 encrypted {format, created} — proves the key before any write
//   data/<aa>/<id>         one encrypted chunk; id = HMAC-SHA256(idKey, plaintext)
//   snapshots/<time>-<rnd> encrypted manifest {time, paths, files:[{path, size, mode, mtime, sha256, chunks}]}
//
// Crypto: AES-256-GCM (node:crypto) with separate derived keys for encryption and chunk ids.
// Deviation from D7's "age or libsodium": Node's built-in AEAD gives the same guarantees
// without adding a dependency to the image. The master key is 32 random bytes, read from a
// file that must not sit inside any backed-up path.

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const FORMAT = 'noevia-offsite-v1';
const CHUNK = 4 * 1024 * 1024;
const RETENTION = Object.freeze({ daily: 7, weekly: 4, monthly: 6 });

const fail = (message, status = 400) => Object.assign(Error(message), { status, publicMessage: message });

function deriveKeys(master) {
  if (!Buffer.isBuffer(master) || master.length !== 32) throw fail('The backup key must be 32 bytes (64 hex characters).');
  const derive = (label) => crypto.createHmac('sha256', master).update(`${FORMAT}:${label}`).digest();
  return { enc: derive('encrypt'), id: derive('chunk-id') };
}

function seal(keys, plaintext) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys.enc, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function open(keys, sealed) {
  if (!Buffer.isBuffer(sealed) || sealed.length < 28) throw fail('A backup object is truncated.', 422);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keys.enc, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  try { return Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]); }
  catch { throw fail('A backup object failed authentication (wrong key or tampered data).', 422); }
}

/** Keep the newest snapshot per day/ISO-week/month buckets, restic-style. Returns ids to keep. */
function retain(snapshots, policy = RETENTION) {
  const sorted = [...snapshots].sort((a, b) => b.time - a.time);
  const keep = new Set();
  if (sorted[0]) keep.add(sorted[0].id); // never forget the newest
  const bucket = (time, kind) => {
    const d = new Date(time);
    if (kind === 'daily') return d.toISOString().slice(0, 10);
    if (kind === 'monthly') return d.toISOString().slice(0, 7);
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
    const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
    return `${t.getUTCFullYear()}-W${Math.ceil(((t - yearStart) / 86400000 + 1) / 7)}`;
  };
  for (const kind of ['daily', 'weekly', 'monthly']) {
    const seen = new Set();
    for (const s of sorted) {
      const b = bucket(s.time, kind);
      if (seen.has(b)) continue;
      if (seen.size >= policy[kind]) break;
      seen.add(b); keep.add(s.id);
    }
  }
  return keep;
}

/**
 * @param {{ store: { put(key, bytes), get(key): Promise<Buffer|null>, list(prefix): Promise<string[]>, delete(key) },
 *           key: Buffer, paths: string[], fs?: typeof import('node:fs'), now?: () => number,
 *           snapshotFile?: (absPath: string) => Promise<Buffer|null> }} deps
 */
function createOffsiteBackup({ store, key, paths, fs = nodeFs, now = Date.now, snapshotFile = null, log = () => {} }) {
  const keys = deriveKeys(key);
  const chunkId = (bytes) => crypto.createHmac('sha256', keys.id).update(bytes).digest('hex');
  const dataKey = (id) => `data/${id.slice(0, 2)}/${id}`;
  let running = null;

  async function ensureConfig() {
    const existing = await store.get('config');
    if (existing) {
      const config = JSON.parse(open(keys, existing).toString('utf8'));
      if (config.format !== FORMAT) throw fail('The destination holds a different backup format.', 409);
      return;
    }
    await store.put('config', seal(keys, Buffer.from(JSON.stringify({ format: FORMAT, created: now() }))));
  }

  function walk(root) {
    const out = [];
    const visit = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const abs = nodePath.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue; // never follow links out of the tree
        if (entry.isDirectory()) visit(abs);
        else if (entry.isFile() && !/-(wal|shm|journal)$/.test(entry.name)) out.push(abs);
      }
    };
    visit(root);
    return out;
  }

  // Yields a file's content in CHUNK-sized pieces (an empty file yields one empty piece, so it
  // still has a chunk list). Only one piece is in memory at a time.
  async function* readPieces(abs, snap) {
    if (snap) {
      for (let offset = 0; offset < snap.length || offset === 0; offset += CHUNK) {
        yield snap.subarray(offset, offset + CHUNK);
        if (snap.length === 0) return;
      }
      return;
    }
    const fd = fs.openSync(abs, 'r');
    try {
      let first = true;
      for (;;) {
        const buffer = Buffer.allocUnsafe(CHUNK);
        let filled = 0;
        while (filled < CHUNK) {
          const n = fs.readSync(fd, buffer, filled, CHUNK - filled, null);
          if (!n) break;
          filled += n;
        }
        if (filled || first) yield buffer.subarray(0, filled);
        first = false;
        if (filled < CHUNK) return;
      }
    } finally { fs.closeSync(fd); }
  }

  async function backup() {
    if (running) throw fail('A backup is already running.', 409);
    running = (async () => {
      await ensureConfig();
      const known = new Set((await store.list('data/')).map((k) => k.split('/').pop()));
      const files = [];
      let uploaded = 0, bytes = 0, incomplete = false;
      const isSqlite = (abs) => /\.(db|sqlite3?)$/.test(abs);
      for (const [index, root] of paths.entries()) {
        for (const abs of walk(root)) {
          // A snapshot hook hands back a Buffer (a consistent sqlite copy); anything else is
          // streamed from disk CHUNK bytes at a time, so a large file is never held whole (#139).
          let snap = null;
          if (snapshotFile && isSqlite(abs)) {
            // A live .db/.sqlite file must never be raw-read: without a
            // consistent snapshot (WAL not checkpointed, page writes
            // in-flight) the copy is torn and can pass a restore test while
            // being unusable. Skip the file and flag the manifest instead of
            // silently falling back to a raw read.
            try { snap = await snapshotFile(abs); } catch { snap = null; }
            if (!snap) {
              log({ event: 'offsite.snapshot.skip', path: abs, reason: 'sqlite-snapshot-failed' });
              incomplete = true;
              continue;
            }
          } else if (snapshotFile) {
            try { snap = await snapshotFile(abs); } catch { continue; }
          }
          const stat = fs.statSync(abs, { throwIfNoEntry: false });
          const chunks = [];
          const whole = crypto.createHash('sha256');
          let size = 0;
          const store1 = async (piece) => {
            const id = chunkId(piece);
            if (!known.has(id)) { await store.put(dataKey(id), seal(keys, piece)); known.add(id); uploaded++; bytes += piece.length; }
            chunks.push(id);
            whole.update(piece); size += piece.length;
          };
          try {
            for await (const piece of readPieces(abs, snap)) await store1(piece);
          } catch (err) {
            // A file that vanished or became unreadable is skipped, as a failed read always was;
            // any chunks it already uploaded are unreferenced and go at the next forget().
            if (err && typeof err.code === 'string') { log({ event: 'offsite.read.skip', path: abs, code: err.code }); continue; }
            throw err;
          }
          files.push({ root: index, path: nodePath.relative(root, abs).split(nodePath.sep).join('/'), size,
            mode: stat ? stat.mode & 0o777 : 0o600, mtime: stat ? Math.round(stat.mtimeMs) : 0,
            sha256: whole.digest('hex'), chunks });
        }
      }
      const time = now();
      const id = `${new Date(time).toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
      await store.put(`snapshots/${id}`, seal(keys, Buffer.from(JSON.stringify({ format: FORMAT, time, roots: paths.length, files, incomplete }))));
      log({ event: 'offsite.snapshot', id, files: files.length, uploadedChunks: uploaded, uploadedBytes: bytes, incomplete });
      return { id, time, files: files.length, uploadedChunks: uploaded, uploadedBytes: bytes, incomplete };
    })();
    try { return await running; } finally { running = null; }
  }

  async function snapshots() {
    const ids = (await store.list('snapshots/')).map((k) => k.slice('snapshots/'.length));
    const out = [];
    for (const id of ids) {
      let manifest;
      try { manifest = await readManifest(id); }
      catch (err) {
        // One corrupt manifest must not take down retention or the restore
        // test for every other snapshot: skip it and log, don't throw.
        log({ event: 'offsite.snapshot.corrupt', id, message: err?.message });
        continue;
      }
      out.push({ id, time: manifest.time, files: manifest.files.length, bytes: manifest.files.reduce((n, f) => n + f.size, 0), incomplete: !!manifest.incomplete });
    }
    return out.sort((a, b) => b.time - a.time);
  }

  async function readManifest(id) {
    if (!/^[\w-]{1,80}$/.test(String(id))) throw fail('Invalid snapshot id.');
    const sealed = await store.get(`snapshots/${id}`);
    if (!sealed) throw fail('No such snapshot.', 404);
    const manifest = JSON.parse(open(keys, sealed).toString('utf8'));
    if (manifest.format !== FORMAT || !Array.isArray(manifest.files)) throw fail('The snapshot manifest is invalid.', 422);
    return manifest;
  }

  /** Restore into an empty or new directory; never overwrites. Verifies every chunk and file hash. */
  async function restore(id, target) {
    const manifest = await readManifest(id);
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw fail('Restore needs an empty target directory.', 409);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const base = fs.realpathSync(target);
    for (const file of manifest.files) {
      const rel = String(file.path);
      if (!rel || rel.split('/').some((s) => !s || s === '.' || s === '..') || nodePath.isAbsolute(rel)) throw fail('The snapshot names an unsafe path.', 422);
      const dest = nodePath.join(base, String(file.root), ...rel.split('/'));
      if (!dest.startsWith(base + nodePath.sep)) throw fail('The snapshot names an unsafe path.', 422);
      // Verify and write one chunk at a time; the whole file is never assembled in memory (#139).
      // The file is created exclusively and removed again if it fails verification.
      for (const cid of file.chunks) if (!/^[a-f0-9]{64}$/.test(cid)) throw fail('The snapshot names an invalid chunk.', 422);
      fs.mkdirSync(nodePath.dirname(dest), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(dest, 'wx', file.mode || 0o600);
      let ok = false;
      try {
        const whole = crypto.createHash('sha256');
        let size = 0;
        for (const cid of file.chunks) {
          const sealed = await store.get(dataKey(cid));
          if (!sealed) throw fail(`A chunk of ${rel} is missing from the destination.`, 422);
          const plain = open(keys, sealed);
          if (chunkId(plain) !== cid) throw fail(`A chunk of ${rel} does not match its id.`, 422);
          whole.update(plain); size += plain.length;
          if (size > file.size) throw fail(`${rel} does not match the snapshot.`, 422);
          for (let written = 0; written < plain.length;) written += fs.writeSync(fd, plain, written, plain.length - written);
        }
        if (whole.digest('hex') !== file.sha256 || size !== file.size) throw fail(`${rel} does not match the snapshot.`, 422);
        ok = true;
      } finally {
        fs.closeSync(fd);
        if (!ok) fs.rmSync(dest, { force: true });
      }
    }
    return { id, files: manifest.files.length };
  }

  /** Restore test: restore the newest snapshot into a scratch dir, verify, delete the scratch dir. */
  async function verify(scratchRoot) {
    const [latest] = await snapshots();
    if (!latest) throw fail('There is no snapshot to verify yet.', 409);
    // mkdtemp creates a fresh 0700 directory only this process can write into; the restore goes
    // into a new child of it. The scratch dir is never deleted and recreated, which would leave a
    // window for another local user to plant a symlink at the shared-temp path (#140).
    const scratch = fs.mkdtempSync(nodePath.join(scratchRoot, 'noevia-restore-test-'));
    try {
      const result = await restore(latest.id, nodePath.join(scratch, 'restore'));
      log({ event: 'offsite.verify', id: latest.id, files: result.files });
      return { id: latest.id, files: result.files, verifiedAt: now() };
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }

  /** Apply retention, then delete chunks no remaining snapshot references. */
  async function forget(policy = RETENTION) {
    // A running backup has uploaded chunks no manifest references yet; pruning now would delete them.
    if (running) throw fail('A backup is running; apply retention after it finishes.', 409);
    const all = await snapshots();
    const keep = retain(all, policy);
    const removed = [];
    for (const s of all) if (!keep.has(s.id)) { await store.delete(`snapshots/${s.id}`); removed.push(s.id); }
    const referenced = new Set();
    for (const id of keep) for (const file of (await readManifest(id)).files) for (const c of file.chunks) referenced.add(c);
    let pruned = 0;
    for (const k of await store.list('data/')) {
      if (!referenced.has(k.split('/').pop())) { await store.delete(k); pruned++; }
    }
    log({ event: 'offsite.forget', removed: removed.length, prunedChunks: pruned });
    return { kept: keep.size, removed, prunedChunks: pruned };
  }

  return { backup, snapshots, restore, verify, forget, running: () => !!running };
}

/** Read a 32-byte key (hex) from a file that must not live inside a backed-up path. */
function loadKey(file, paths, fs = nodeFs) {
  if (!file) throw fail('Set OFFSITE_BACKUP_KEY_FILE to a file holding a 64-character hex key.');
  const real = fs.realpathSync(file);
  for (const root of paths) {
    let r; try { r = fs.realpathSync(root); } catch { continue; }
    if (real === r || real.startsWith(r + nodePath.sep)) throw fail('The backup key must be kept outside the backed-up folders.');
  }
  const hex = fs.readFileSync(real, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw fail('The backup key file must hold 64 hex characters (openssl rand -hex 32).');
  return Buffer.from(hex, 'hex');
}

module.exports = { createOffsiteBackup, retain, loadKey, deriveKeys, seal, open, FORMAT, RETENTION, CHUNK };
