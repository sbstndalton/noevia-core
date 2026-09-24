'use strict';
// Google Drive for off-site backups, done entirely by noevia's backend (D24, replacing D23's
// host rclone). An administrator clicks Connect; noevia starts Google's device sign-in, shows a
// short code, and polls Google in the background until they approve it. From then on noevia
// uploads its already-encrypted backup store to a `noevia-offsite` folder in their Drive.
//
// What noevia holds, and how:
//   * Scope `drive.file`: noevia sees only the files it created, never the rest of the Drive.
//     Plus `openid email`, only to show which account is connected.
//   * The refresh token is sealed with AES-256-GCM under a key derived from the backup key, so
//     the token file alone is useless, and it never reaches the browser.
//   * Disconnect revokes the token at Google and deletes the file.
//
// The mirror keeps the safety rules the rclone script had: refuse a store that is not a healthy
// backup (a wiped disk must never wipe Drive), upload first and prune second, never delete more
// than MAX_DELETE objects (or a quarter of what is on Drive) in one run, never prune a folder that
// holds a different store (identified by a hash of its `config` object), and treat a same-named object of a different size as
// corruption rather than overwriting it.
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const crypto = require('node:crypto');

const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';
const FOLDER = 'noevia-offsite';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_DELETE = 500;
// Never prune more than this share of what is on Drive in one run: a larger share means the local
// store is not the one that was copied there (a lost disk, a replaced backup key), not retention.
const MAX_DELETE_SHARE = 0.25;
const SHARE_FLOOR = 8; // tiny stores: pruning a handful of files is ordinary retention
const STORE_PROP = 'noeviaStoreId';
const FOLDER_NAME = /^noevia-offsite(?: \((\d+)\))?$/;
const fail = (message, status = 502) => Object.assign(Error(message), { status, publicMessage: message });

function sealer(backupKey) {
  const key = Buffer.from(crypto.hkdfSync('sha256', backupKey, Buffer.alloc(0), 'noevia google token v1', 32));
  return {
    seal(obj) {
      const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
    },
    open(text) {
      const raw = Buffer.from(text, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
    },
  };
}

/** The email in an ID token, for display only (it came straight from Google over TLS). */
function emailOf(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email || null; }
  catch { return null; }
}

/**
 * @param {{clientId?: string, clientSecret?: string, tokenFile: string, backupKey: () => Buffer,
 *   fetch?: typeof fetch, oauthBase?: string, apiBase?: string, uploadBase?: string,
 *   now?: () => number, log?: (e: object) => void, setTimeout?: typeof setTimeout, fs?: typeof nodeFs}} o
 */
function createGoogleDrive(o) {
  const fs = o.fs || nodeFs, http = o.fetch || fetch, now = o.now || Date.now, log = o.log || (() => {});
  const wait = o.setTimeout || setTimeout;
  const oauth = o.oauthBase || 'https://oauth2.googleapis.com';
  const api = o.apiBase || 'https://www.googleapis.com/drive/v3';
  const upload = o.uploadBase || 'https://www.googleapis.com/upload/drive/v3';
  const configured = () => !!(o.clientId && o.clientSecret);
  let pending = null, pollError = null, access = null, generation = 0, mirrorQueue = Promise.resolve();

  const readSaved = () => {
    let text; try { text = fs.readFileSync(o.tokenFile, 'utf8'); } catch { return null; }
    try { return sealer(o.backupKey()).open(text); } catch { return { broken: true }; }
  };
  const save = (obj) => {
    const tmp = `${o.tokenFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, sealer(o.backupKey()).seal(obj), { mode: 0o600 });
    fs.renameSync(tmp, o.tokenFile);
  };
  /** Adds fields to a readable, connected record; never re-saves a broken or missing one. */
  const savePatch = (patch) => {
    const cur = readSaved();
    if (!cur || cur.broken || !cur.refreshToken) return false;
    save({ ...cur, ...patch });
    return true;
  };

  async function form(url, fields) {
    const r = await http(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }

  function state() {
    if (!configured()) return { configured: false, state: 'not-configured', message: 'This noevia build has no Google sign-in registered.' };
    if (pending && pending.expiresAt > now()) return { configured: true, state: 'pending', userCode: pending.userCode, verificationUrl: pending.verificationUrl, expiresAt: pending.expiresAt };
    const saved = readSaved();
    if (saved?.broken) return { configured: true, state: 'error', message: 'The saved Google connection could not be read (was the backup key replaced?). Connect again.' };
    if (saved?.refreshToken) return { configured: true, state: 'connected', email: saved.email || null, connectedAt: saved.connectedAt || null, owner: saved.owner || null };
    return { configured: true, state: 'disconnected', ...(pollError ? { message: pollError } : {}) };
  }

  /** Starts Google's device sign-in and polls for approval in the background. */
  async function connect(onConnected = () => {}, { owner = null } = {}) {
    if (!configured()) throw fail('This noevia build has no Google sign-in registered.', 409);
    const cur = state();
    if (cur.state === 'pending') return cur;
    const r = await form(`${oauth}/device/code`, { client_id: o.clientId, scope: SCOPE });
    if (r.status !== 200 || !r.body.device_code) throw fail('Google did not start the sign-in. Try again in a minute.');
    const mine = ++generation;
    pollError = null;
    pending = { userCode: r.body.user_code, verificationUrl: r.body.verification_url || r.body.verification_uri, expiresAt: now() + (r.body.expires_in || 1800) * 1000 };
    let interval = Math.max(1, r.body.interval || 5) * 1000;
    const poll = async () => {
      if (mine !== generation) return;
      if (now() > pending.expiresAt) { pending = null; pollError = 'The code expired before it was used. Connect again.'; return; }
      let t;
      try { t = await form(`${oauth}/token`, { client_id: o.clientId, client_secret: o.clientSecret, device_code: r.body.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }); }
      catch { wait(poll, interval); return; } // offline for a moment: keep trying until the code expires
      if (mine !== generation) return;
      if (t.status === 200 && t.body.refresh_token) {
        save({ refreshToken: t.body.refresh_token, email: emailOf(t.body.id_token), connectedAt: now(), ...(owner ? { owner } : {}) });
        access = t.body.access_token ? { token: t.body.access_token, until: now() + ((t.body.expires_in || 3600) - 60) * 1000 } : null;
        pending = null;
        log({ event: 'gdrive.connected' });
        Promise.resolve().then(onConnected).catch(() => {});
        return;
      }
      const err = t.body.error;
      if (err === 'authorization_pending') { wait(poll, interval); return; }
      if (err === 'slow_down') { interval += 5000; wait(poll, interval); return; }
      pending = null;
      pollError = err === 'access_denied' ? 'Access was declined on Google’s page. Connect again to retry.' : 'Google ended the sign-in. Connect again.';
    };
    wait(poll, interval);
    return state();
  }

  async function disconnect() {
    generation++; pending = null; pollError = null; access = null;
    const saved = readSaved();
    if (saved?.refreshToken) await form(`${oauth}/revoke`, { token: saved.refreshToken }).catch(() => {});
    try { fs.unlinkSync(o.tokenFile); } catch { /* already gone */ }
    return state();
  }

  async function token() {
    if (access && access.until > now()) return access.token;
    const saved = readSaved();
    if (!saved?.refreshToken) throw fail('Google Drive is not connected.', 409);
    const r = await form(`${oauth}/token`, { client_id: o.clientId, client_secret: o.clientSecret, refresh_token: saved.refreshToken, grant_type: 'refresh_token' });
    if (r.status !== 200 || !r.body.access_token) {
      if (r.body.error === 'invalid_grant') throw fail('Google no longer accepts this connection (access was removed in your Google account). Connect again.', 409);
      throw fail('Google could not be reached to refresh the connection.');
    }
    access = { token: r.body.access_token, until: now() + ((r.body.expires_in || 3600) - 60) * 1000 };
    return access.token;
  }

  /** An authorized fetch that hands back the raw response, for downloads (alt=media, export). */
  async function request(url, init = {}) {
    return http(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${await token()}` } });
  }

  async function call(url, init = {}) {
    const r = await request(url, init);
    if (!r.ok) throw fail(r.status === 404 ? 'Google Drive has no such file, or noevia cannot see it.' : `Google Drive answered ${r.status}.`, r.status === 404 ? 404 : 502);
    return r.status === 204 ? null : r.json();
  }

  const folderQuery = (extra) => `${api}/files?q=${encodeURIComponent(extra)}`;

  /** Whether a Drive folder holds a copy of the store whose `config` object is `localConfig`. */
  async function folderMatches(folder, storeId, localConfig) {
    const stamped = folder.appProperties?.[STORE_PROP];
    if (stamped) return stamped === storeId;
    // An older (unstamped) folder: compare its `config` object byte for byte.
    const q = `'${folder.id}' in parents and trashed=false`;
    const listed = await call(`${folderQuery(q)}&fields=files(id,name)&pageSize=1000`);
    const files = listed.files || [];
    if (!files.length) return true; // empty: nothing to lose, adopt it
    const cfg = files.find((f) => f.name === 'config');
    if (!cfg) return false;
    const r = await request(`${api}/files/${encodeURIComponent(cfg.id)}?alt=media`);
    if (!r.ok) throw fail(`Google Drive answered ${r.status}.`);
    return Buffer.from(await r.arrayBuffer()).equals(localConfig);
  }

  /**
   * The Drive folder that holds THIS store. A folder that holds a different store (the disk was
   * lost, or the backup key replaced) is left untouched, and the new store goes to a sibling
   * folder "noevia-offsite (2)", so the old off-site copy is never pruned away.
   */
  async function folderId(storeId, localConfig) {
    const saved = readSaved();
    if (saved?.folderId && saved.storeId === storeId) {
      const f = await call(`${api}/files/${encodeURIComponent(saved.folderId)}?fields=id,name,trashed`).catch(() => null);
      if (f && !f.trashed) return { id: saved.folderId, name: f.name || FOLDER, created: false };
    }
    const found = await call(`${folderQuery(`name contains '${FOLDER}' and mimeType='${FOLDER_MIME}' and trashed=false`)}&fields=files(id,name,appProperties)&pageSize=100`);
    const candidates = (found.files || []).filter((f) => FOLDER_NAME.test(f.name || ''))
      .sort((a, b) => Number(FOLDER_NAME.exec(a.name)[1] || 1) - Number(FOLDER_NAME.exec(b.name)[1] || 1));
    let hit = null;
    for (const f of candidates) if (await folderMatches(f, storeId, localConfig)) { hit = f; break; }
    let created = false;
    if (hit) {
      if (hit.appProperties?.[STORE_PROP] !== storeId) {
        await call(`${api}/files/${encodeURIComponent(hit.id)}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appProperties: { [STORE_PROP]: storeId } }) });
      }
    } else {
      const used = new Set(candidates.map((f) => Number(FOLDER_NAME.exec(f.name)[1] || 1)));
      let n = 1; while (used.has(n)) n++;
      const name = n === 1 ? FOLDER : `${FOLDER} (${n})`;
      const r = await call(`${api}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER_MIME, appProperties: { [STORE_PROP]: storeId } }) });
      hit = { id: r.id, name };
      created = true;
      if (candidates.length) log({ event: 'gdrive.new-folder', folder: name, reason: 'existing folders hold a different backup store' });
    }
    savePatch({ folderId: hit.id, storeId });
    return { id: hit.id, name: hit.name, created };
  }

  async function remoteFiles(parent) {
    const out = new Map();
    let page = '';
    do {
      const q = encodeURIComponent(`'${parent}' in parents and trashed=false`);
      const r = await call(`${api}/files?q=${q}&fields=nextPageToken,files(id,name,size)&pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
      for (const f of r.files || []) out.set(f.name, { id: f.id, size: Number(f.size) });
      page = r.nextPageToken || '';
    } while (page);
    return out;
  }

  /**
   * Copies the encrypted store to Drive. Object keys become file names in one flat folder.
   * Runs are serialized: a manual copy that overlaps the scheduled one waits for it.
   */
  function mirror(store, opts) {
    const run = mirrorQueue.then(() => mirrorOnce(store, opts));
    mirrorQueue = run.catch(() => {});
    return run;
  }

  async function mirrorOnce(store, { maxDelete = MAX_DELETE } = {}) {
    const keys = await store.list('');
    if (!keys.includes('config')) throw fail('The local backup store looks empty, so nothing was copied (this protects the copy on Drive).', 409);
    const snapshots = keys.filter((k) => k.startsWith('snapshots/')).length;
    if (!snapshots) throw fail('Waiting for the first backup before copying.', 409);
    const localConfig = await store.get('config');
    if (!localConfig) throw fail('The local backup store looks empty, so nothing was copied (this protects the copy on Drive).', 409);
    const storeId = crypto.createHash('sha256').update(localConfig).digest('hex');
    const folder = await folderId(storeId, localConfig);
    const parent = folder.id;
    const remote = await remoteFiles(parent);
    const sizeOf = async (key) => (store.root ? fs.statSync(nodePath.join(store.root, ...key.split('/'))).size : (await store.get(key))?.length);
    // A same-named `config` of another size means another store: never mix or prune it.
    if (remote.has('config') && remote.get('config').size !== localConfig.length) {
      throw fail('The Drive folder holds a different backup store; nothing was copied or removed.', 409);
    }
    let uploaded = 0, bytes = 0;
    for (const key of keys) {
      const have = remote.get(key);
      if (have) {
        // Names are content hashes, so a size difference can only be corruption on one side.
        if (have.size !== await sizeOf(key)) throw fail(`A file on Drive differs from the local copy (${key.split('/')[0]}); nothing was replaced or pruned.`);
        continue;
      }
      const body = await store.get(key);
      if (!body) continue;
      const boundary = `noevia${crypto.randomBytes(8).toString('hex')}`;
      const multipart = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: key, parents: [parent] })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        body, Buffer.from(`\r\n--${boundary}--`),
      ]);
      await call(`${upload}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
      uploaded++; bytes += body.length;
    }
    const local = new Set(keys);
    const stale = [...remote.entries()].filter(([name]) => !local.has(name));
    // Decide before deleting anything: a run either prunes everything stale or nothing.
    if (stale.length > maxDelete) throw fail(`Copied, but more than ${maxDelete} old files would be removed from Drive at once; nothing was removed, to be safe.`);
    if (stale.length > Math.max(SHARE_FLOOR, remote.size * MAX_DELETE_SHARE)) {
      throw fail(`Copied, but ${stale.length} of the ${remote.size} files on Drive are not in the local store; nothing was removed, to be safe.`);
    }
    for (const [, f] of stale) await call(`${api}/files/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
    log({ event: 'gdrive.mirrored', uploaded, removed: stale.length, folder: folder.name });
    return { uploaded, bytes, removed: stale.length, snapshots, folder: folder.name, newFolder: folder.created };
  }

  return { configured, state, connect, disconnect, mirror, FOLDER, call, request, api, upload };
}

module.exports = { createGoogleDrive, SCOPE, FOLDER, emailOf };
