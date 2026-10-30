'use strict';
// Whose Google Drive a chat tool reaches, and how it reaches it (sbstndalton/noevia#2190 round 7).
// The Rust front owns every Google OAuth state (rust-google-drive.cjs): the sign-in, the sealed refresh
// tokens and the refresh. This process holds none. It keeps the shape drive-accounts.cjs and gdrive.cjs
// gave the chat tools (`forUser(user)` -> `{ drive, backup }`, with `drive.state()`, `call`, `request`,
// `api`, `upload`), so gdrive-tools.cjs and gdrive-files.cjs are unchanged, and fills it from two things:
//
//   * gdrive-connections.json, which the broker rewrites after every committed change (no secret, no
//     email): which accounts have a connection file and in what state, and the backup slot's. A re-reader
//     on its file signal answers the sync `state()` and `connected(user)` with no round trip. The rule
//     that says whose Drive an account reaches (ownsBackup) is the broker's, kept equal here and proven by
//     the shared cases in gdrive-owns-backup.v1.json (the Rust test reads the same file).
//   * the broker's `session` (internal store, project-store-client.cjs gdriveSession): a short-lived
//     access token, cached here for at most a minute and dropped when the state file moves. A 401 drops
//     the cache entry and asks once more with the rejected token; a second 401 calls `reject` with the
//     sign-in's generation. If the broker is unreachable the tool gets "try again", never "disconnected".
const path = require('node:path');
const { createReread, fileSignal } = require('./shared-reread.cjs');
const { SIGNAL_FILE } = require('./rust-google-drive.cjs');
const { readCappedJson } = require('./http.cjs');

const SESSION_CACHE_MS = 60 * 1000;
const SESSION_CACHE_MAX = 1000;
const fail = (message, status = 502, extra = {}) => Object.assign(Error(message), { status, publicMessage: message, ...extra });
const MESSAGES = {
  disconnected: 'Google Drive is not connected.',
  reconnect: 'Google no longer accepts this connection (access was removed in your Google account). Connect again.',
  transient: 'Google could not be reached to refresh the connection.',
  unavailable: 'Google Drive is unavailable right now. Try again in a moment.',
};
const ID = /^[\w-]+$/;

/** drive-accounts.cjs `ownsBackup`: whether the backup slot is this account's Drive. */
function ownsBackup({ admin, userId, backup, personalFile }) {
  if (!admin || !backup || !backup.usable) return false;
  const s = backup.state;
  if (s === 'connected' || s === 'error') return !backup.owner || backup.owner === userId;
  // Someone's sign-in is waiting for approval: only the administrator who started it may see its code
  // or finish it (#868). A pending sign-in with no recorded initiator keeps the old rule.
  if (s === 'pending' && backup.owner) return backup.owner === userId;
  // Nothing saved yet: an administrator connecting from Connectors fills the backup slot, unless they
  // already have a personal connection.
  return !personalFile;
}

/**
 * @param {object} deps
 * @param {{gdriveSession, gdriveReject, gdriveDisconnect, gdriveForget, gdriveView}} deps.broker  the project-store client
 * @param {string} deps.dataDir
 * @param {string} [deps.apiBase] @param {string} [deps.uploadBase]
 */
function createDriveAccounts({ broker, dataDir, apiBase = 'https://www.googleapis.com/drive/v3', uploadBase = 'https://www.googleapis.com/upload/drive/v3',
  fetchImpl = (...args) => globalThis.fetch(...args), now = () => Date.now(), signalFile = path.join(dataDir, SIGNAL_FILE), warn = console.warn }) {
  const snapshot = createReread({
    signal: () => fileSignal(signalFile),
    load: () => {
      const doc = JSON.parse(require('node:fs').readFileSync(signalFile, 'utf8'));
      if (!doc || typeof doc !== 'object' || !doc.backup || typeof doc.personal !== 'object') throw new Error('unexpected state file');
      return doc;
    },
    // No file yet (the broker has not published) or unreadable: nobody is known to be connected.
    fallback: () => null,
  });
  // '' is no file: nothing is cached without a state file that exists and can be read.
  const markOf = () => { try { return fileSignal(signalFile) || null; } catch { return null; } };

  const admin = (user) => user.role === 'admin';
  const owns = (user, doc) => !!doc && ownsBackup({ admin: admin(user), userId: user.id, backup: doc.backup, personalFile: Object.hasOwn(doc.personal, user.id) });
  /** The effective connection state of this account: 'connected', 'error', 'pending', 'disconnected'. */
  function stateOf(user) {
    const doc = snapshot.current();
    if (!doc) return 'disconnected';
    if (owns(user, doc)) {
      const b = doc.backup;
      return b.state === 'pending' && !(Number(b.expiresAt) > now()) ? 'disconnected' : b.state;
    }
    return typeof doc.personal[user.id] === 'string' ? doc.personal[user.id] : 'disconnected';
  }

  const sessions = new Map(); // userId -> { session, until, mark }
  const brokerError = (r) => {
    const code = typeof r?.code === 'string' ? r.code : undefined;
    const text = code && MESSAGES[code] ? MESSAGES[code] : (typeof r?.error === 'string' && Number.isInteger(r?.status) ? r.error.slice(0, 300) : MESSAGES.unavailable);
    return fail(text, Number.isInteger(r?.status) && r.status >= 400 && r.status < 600 ? r.status : 503, code ? { code } : {});
  };

  async function token(user, { rejected = null } = {}) {
    const key = String(user.id);
    const mark = markOf();
    if (!rejected && mark !== null) {
      const hit = sessions.get(key);
      if (hit && hit.mark === mark && hit.until > now()) return hit.session;
    }
    sessions.delete(key);
    let r;
    try { r = await broker.gdriveSession(key, admin(user), rejected); } catch { throw fail(MESSAGES.unavailable, 503); }
    if (!r || !r.ok) throw brokerError(r);
    const s = r.session;
    const until = Math.min(now() + SESSION_CACHE_MS, Number.isFinite(s.expiresAt) && s.expiresAt > 0 ? s.expiresAt : Infinity);
    if (mark !== null && until > now()) {
      sessions.set(key, { session: s, until, mark });
      while (sessions.size > SESSION_CACHE_MAX) sessions.delete(sessions.keys().next().value);
    }
    return s;
  }

  function driveFor(user) {
    /** An authorized fetch that hands back the raw response, for downloads (alt=media, export). */
    async function request(url, init = {}) {
      let t = await token(user);
      const send = (accessToken) => fetchImpl(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${accessToken}` } });
      let r = await send(t.accessToken);
      if (r.status !== 401) return r;
      // The cached token may have been revoked or aged out: ask once more, naming the rejected one.
      try { await r.body?.cancel?.(); } catch { /* already closed */ }
      sessions.delete(String(user.id));
      t = await token(user, { rejected: t.accessToken });
      r = await send(t.accessToken);
      if (r.status === 401) {
        // A fresh token refused too: drop that sign-in's cache in the broker; the tool reports Google's answer.
        try { await broker.gdriveReject(String(user.id), admin(user), t.generation); } catch { /* the next call asks again */ }
        sessions.delete(String(user.id));
      }
      return r;
    }
    async function call(url, init = {}) {
      const r = await request(url, init);
      if (!r.ok) throw fail(r.status === 404 ? 'Google Drive has no such file, or noevia cannot see it.' : `Google Drive answered ${r.status}.`, r.status === 404 ? 404 : 502, r.status === 404 ? {} : { messageId: 'driveAnswered', messageParams: { status: r.status } });
      return r.status === 204 ? null : readCappedJson(r, 8 * 1024 * 1024);
    }
    return { state: () => ({ state: stateOf(user) }), request, call, api: apiBase, upload: uploadBase };
  }

  function forUser(user) {
    if (!user || !user.id) throw fail('Sign in first.', 401);
    if (!ID.test(user.id)) throw new Error('unexpected user id');
    return { drive: driveFor(user), backup: owns(user, snapshot.current()) };
  }

  /** The broker deletes an account's connection (revoked at Google first); a failure never undoes the deletion. */
  async function removeUser(userId) {
    sessions.delete(String(userId));
    try {
      const r = await broker.gdriveForget(String(userId));
      if (!r || !r.ok) warn(`Google Drive connection of a deleted account was not removed (${r?.status || 'error'}).`);
    } catch (e) { warn(`Google Drive connection of a deleted account was not removed (${e?.code || e?.status || 'error'}).`); }
  }

  /** The Google Drive half of GET /api/connectors, from the broker. */
  async function view(user) {
    let r;
    try { r = await broker.gdriveView(String(user.id), admin(user)); } catch { r = null; }
    if (r && r.ok) return r.view;
    // The broker cannot answer: the page still lists Nextcloud, and says why this one is missing.
    return { id: 'gdrive', name: 'Google Drive', configured: true, state: 'error', email: null, connectedAt: null, message: MESSAGES.unavailable, backup: null, tools: [] };
  }

  /** A change signal for everything that decides which Drive tools an account is offered: the broker's state file. */
  const fingerprint = () => { try { return fileSignal(signalFile); } catch { return 'unreadable'; } };

  return { forUser, removeUser, fingerprint, connected: (user) => !!user && !!user.id && stateOf(user) === 'connected', view, ownsBackup };
}

module.exports = { createDriveAccounts, ownsBackup, MESSAGES };
