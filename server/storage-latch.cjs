'use strict';

// #1429: automatic storage calls must not feed Nextcloud's brute-force protection. Once a saved
// login is refused (401), or storage throttles it (429), the account's automatic calls (the
// project source refresh, the Diary storage backup) stop until the saved credentials change, the
// person asks again (an explicit request, which always runs and re-latches on another refusal), any
// explicit storage call works (clear), or the hold's backoff ends and one automatic call is let through
// as a probe (#1589). The backoff doubles after each failed probe, so a login that stays refused is tried
// rarely, while one transient 401 does not stop backups for good. A throttle holds automatic calls
// until its Retry-After has passed. A throttle that lands on a still-refused login (the probe itself drew the
// 429) keeps that login's strikes (#1607): when the throttle has run its course the login latch is back, so the
// next probe that is refused doubles the wait instead of starting again at the base.
//
// The latch is per account (userId), in memory: a restart allows one automatic attempt per account,
// which is the bounded cost this design accepts. It stores a fingerprint of the connection
// (kind, server, username and app password), never the secret itself, so a change of credentials
// clears it on its own.

const crypto = require('node:crypto');

const DEFAULT_THROTTLE_WAIT_MS = 60 * 1000;
// #1589: how long a refused login holds automatic calls before one probe is let through, doubling after
// each failed probe up to the maximum; and how long the other callers are held while a probe runs.
const LOGIN_PROBE_BASE_MS = 15 * 60 * 1000;
const LOGIN_PROBE_MAX_MS = 6 * 60 * 60 * 1000;
const PROBE_HOLD_MS = 60 * 1000;

function fingerprintOf(connection) {
  const c = connection && typeof connection === 'object' ? connection : {};
  return crypto.createHash('sha256').update(JSON.stringify([
    String(c.kind || ''), String(c.baseUrl || ''), String(c.bucket || ''), String(c.username || ''), String(c.secret || ''),
  ])).digest('hex');
}

function createStorageLatch({ now = Date.now } = {}) {
  // userId -> { fingerprint, kind, until, strikes, probing }. A throttle over a refused login also has
  // `login: { strikes, until }`, what the login latch is restored to when the throttle has passed (#1607).
  const latches = new Map();

  /** A throttle that has run its course is dropped, or, when it sat on a refused login of the same
   *  credentials, gives way to that login latch with the strikes it had. A login that is already due
   *  is still the probe in flight, so a refusal that follows counts as the probe's. */
  function settle(userId) {
    const latch = latches.get(userId);
    if (latch && latch.kind === 'throttled' && now() >= latch.until) {
      if (latch.login) latches.set(userId, { fingerprint: latch.fingerprint, kind: 'login', until: latch.login.until, strikes: latch.login.strikes, probing: latch.login.until <= now() });
      else latches.delete(userId);
    }
    return latches.get(userId) || null;
  }

  /** Records a failure of a call made with `connection`. Only login and throttle failures latch;
   *  anything else (a 404, a timeout, a network failure) is left for the next call to find out. */
  function note(userId, connection, failure) {
    if (!userId || !failure) return;
    const fingerprint = fingerprintOf(connection);
    const before = settle(userId);
    if (failure.kind === 'login') {
      const sameLogin = before && before.fingerprint === fingerprint && before.kind === 'login';
      const sameThrottle = before && before.fingerprint === fingerprint && before.kind === 'throttled' && before.login;
      // A probe that was refused again doubles the wait; an explicit press that was refused only renews it.
      const strikes = sameLogin ? (before.probing ? before.strikes + 1 : before.strikes) : sameThrottle ? before.login.strikes : 1;
      const wait = Math.min(LOGIN_PROBE_MAX_MS, LOGIN_PROBE_BASE_MS * 2 ** Math.min(strikes - 1, 16));
      latches.set(userId, { fingerprint, kind: 'login', until: now() + wait, strikes, probing: false });
    } else if (failure.kind === 'throttled') {
      const wait = Number.isFinite(failure.retryAfter) && failure.retryAfter > 0 ? failure.retryAfter * 1000 : DEFAULT_THROTTLE_WAIT_MS;
      // The login strikes survive a throttle on the same credentials. A probe was past its base wait, so
      // the login is due again the moment the throttle ends; any other 429 leaves the login hold as it was.
      let login = null;
      if (before && before.fingerprint === fingerprint) {
        if (before.kind === 'login') login = { strikes: before.strikes, until: before.probing ? 0 : before.until };
        else if (before.kind === 'throttled' && before.login) login = before.login;
      }
      latches.set(userId, { fingerprint, kind: 'throttled', until: now() + wait, strikes: 0, probing: false, ...(login ? { login } : {}) });
    }
  }

  /** The latch holding this account, or null. A latch for other credentials is dropped; a throttle that
   *  has run its course is dropped too, or gives way to the refused login it sat on (#1607). */
  function inspect(userId, connection) {
    const latch = settle(userId);
    if (!latch) return null;
    if (latch.fingerprint !== fingerprintOf(connection)) { latches.delete(userId); return null; }
    return latch;
  }

  /** The latch that holds this account's automatic calls, or null. A refused login whose backoff has
   *  passed lets this one call through as a probe and holds the others for a minute; if the probe works
   *  the caller clears the latch, and if it is refused again `note` renews it with a longer wait. */
  function blocked(userId, connection) {
    const latch = inspect(userId, connection);
    if (!latch) return null;
    if (latch.kind === 'login' && now() >= latch.until) {
      latch.probing = true;
      latch.until = now() + PROBE_HOLD_MS;
      return null;
    }
    return { kind: latch.kind, ...(latch.kind === 'throttled' ? { retryAfter: Math.max(1, Math.ceil((latch.until - now()) / 1000)) } : {}) };
  }

  /** What a status view shows about an account's held automatic calls, or null: the kind, and when the
   *  next automatic attempt is due (epoch ms). Reading it never lets a probe through. */
  function status(userId, connection) {
    const latch = inspect(userId, connection);
    if (!latch) return null;
    return { kind: latch.kind, nextAttemptAt: latch.until };
  }

  /** A call that worked proves the credentials are good again. */
  function clear(userId) { latches.delete(userId); }

  /** The saved connection of an account, or null when there is none (or it cannot be read). */
  function connectionOf(readConnection, userId) {
    try { return readConnection(userId) || null; } catch { return null; }
  }

  /** The held state of an account's automatic calls from its saved connection, or null (a status view). */
  function statusFor(userId, readConnection) {
    const conn = connectionOf(readConnection, userId);
    return conn ? status(userId, conn) : null;
  }

  /** Whether an account's automatic calls are held right now (the Diary backup worker's `suspended`). */
  function suspendedFor(userId, readConnection) {
    const conn = connectionOf(readConnection, userId);
    return !!conn && !!blocked(userId, conn);
  }

  /** Records a Diary reply to an automatic storage call (its storage-backup): a refused login or a
   *  throttle latches the account; a success clears the latch only when the reply proves the storage
   *  server was reached (`storageContacted: true`, set by the Diary only for a run that read and wrote
   *  the remote and verified it, #1609). The Diary answers 200 without leaving its host when the
   *  account is kept in the app, has no backup destination, is not due, is already complete or is
   *  busy, and when a run failed: none of those proves the saved login, so the hold stays.
   *  Returns nothing. */
  function noteDiaryReply(userId, readConnection, reply, ok) {
    const conn = connectionOf(readConnection, userId);
    if (!conn) return;
    const failure = failureFromDiaryReply(reply);
    if (failure) note(userId, conn, failure);
    else if (ok && reply && typeof reply === 'object' && reply.storageContacted === true) clear(userId);
    else giveBackProbe(userId, conn);
  }

  /** A reply that neither failed nor reached the storage server (a legacy account, no destination, a backup
   *  that is not due, a run that could not be verified) tested nothing, so the probe that call took is handed
   *  back: the login latch is due again at once, with its strikes and its hold intact, and the next automatic
   *  caller (the project refresh) gets it instead of the backup worker taking it every tick (#1615). Only a
   *  login latch whose probe is out is touched; a hold still inside its wait is never shortened. */
  function giveBackProbe(userId, conn) {
    const latch = latches.get(userId);
    if (latch && latch.kind === 'login' && latch.probing && latch.fingerprint === fingerprintOf(conn)) {
      latch.until = now();
      latch.probing = false;
    }
  }

  return { note, blocked, status, statusFor, clear, fingerprintOf, suspendedFor, noteDiaryReply };
}

/** The storage failure a Diary reply reports, in the shape `note` takes, or null. The Diary tags a
 *  refused login (424 storageLoginRejected, or `loginRefused: true` on a backup's 200 reply) and a throttle
 *  (503 storageThrottled + retryAfter). */
function failureFromDiaryReply(reply) {
  if (!reply || typeof reply !== 'object') return null;
  if (reply.code === 'storageLoginRejected') return { kind: 'login' };
  // #1617: the Diary answers a storage-backup the remote refused the login for as a 200 'failed' status, with this flag.
  if (reply.loginRefused === true) return { kind: 'login' };
  if (reply.code === 'storageThrottled') {
    const wait = Number(reply.retryAfter);
    return { kind: 'throttled', ...(Number.isFinite(wait) && wait > 0 ? { retryAfter: wait } : {}) };
  }
  return null;
}

module.exports = { createStorageLatch, fingerprintOf, failureFromDiaryReply, DEFAULT_THROTTLE_WAIT_MS, LOGIN_PROBE_BASE_MS, LOGIN_PROBE_MAX_MS, PROBE_HOLD_MS };
