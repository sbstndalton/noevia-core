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
// than MAX_DELETE objects in one run, and treat a same-named object of a different size as
// corruption rather than overwriting it.
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const crypto = require('node:crypto');

const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';
const FOLDER = 'noevia-offsite';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_DELETE = 500;
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
  let pending = null, pollError = null, access = null, generation = 0;

  const readSaved = () => {
    let text; try { text = fs.readFileSync(o.tokenFile, 'utf8'); } catch { return null; }
    try { return sealer(o.backupKey()).open(text); } catch { return { broken: true }; }
  };
  const save = (obj) => {
    const tmp = `${o.tokenFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, sealer(o.backupKey()).seal(obj), { mode: 0o600 });
    fs.renameSync(tmp, o.tokenFile);
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

  async function folderId() {
    const saved = readSaved();
    if (saved?.folderId) {
      const f = await call(`${api}/files/${encodeURIComponent(saved.folderId)}?fields=id,trashed`).catch(() => null);
      if (f && !f.trashed) return saved.folderId;
    }
    const q = encodeURIComponent(`name='${FOLDER}' and mimeType='${FOLDER_MIME}' and trashed=false`);
    const found = await call(`${api}/files?q=${q}&fields=files(id)&pageSize=1`);
    const id = found.files?.[0]?.id || (await call(`${api}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER, mimeType: FOLDER_MIME }) })).id;
    save({ ...readSaved(), folderId: id });
    return id;
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

  /** Copies the encrypted store to Drive. Object keys become file names in one flat folder. */
  async function mirror(store, { maxDelete = MAX_DELETE } = {}) {
    const keys = await store.list('');
    if (!keys.includes('config')) throw fail('The local backup store looks empty, so nothing was copied (this protects the copy on Drive).', 409);
    const snapshots = keys.filter((k) => k.startsWith('snapshots/')).length;
    if (!snapshots) throw fail('Waiting for the first backup before copying.', 409);
    const parent = await folderId();
    const remote = await remoteFiles(parent);
    let uploaded = 0, bytes = 0;
    for (const key of keys) {
      const have = remote.get(key);
      if (have) {
        // Names are content hashes, so a size difference can only be corruption on one side.
        const size = store.root ? fs.statSync(nodePath.join(store.root, ...key.split('/'))).size : (await store.get(key))?.length;
        if (have.size !== size) throw fail(`A file on Drive differs from the local copy (${key.split('/')[0]}); nothing was replaced or pruned.`);
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
    for (const [, f] of stale.slice(0, maxDelete)) await call(`${api}/files/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
    if (stale.length > maxDelete) throw fail(`Copied, but more than ${maxDelete} old files would be removed from Drive at once; stopped to be safe.`);
    log({ event: 'gdrive.mirrored', uploaded, removed: stale.length });
    return { uploaded, bytes, removed: stale.length, snapshots };
  }

  return { configured, state, connect, disconnect, mirror, FOLDER, call, request, api, upload };
}

module.exports = { createGoogleDrive, SCOPE, FOLDER, emailOf };
