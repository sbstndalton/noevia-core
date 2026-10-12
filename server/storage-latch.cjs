'use strict';

// #1429: automatic storage calls must not feed Nextcloud's brute-force protection. Once a saved
// login is refused (401), or storage throttles it (429), the account's automatic calls (the
// project source refresh, the Diary storage backup) stop until the saved credentials change, the
// person asks again (an explicit request, which always runs and re-latches on another refusal), any
// explicit storage call works (clear), or the hold's backoff ends and one automatic call is let through
// as a probe (#1589). The backoff doubles after each failed probe, so a login that stays refused is tried
// rarely, while one transient 401 does not stop backups for good. A throttle holds automatic calls
// until its Retry-After has passed.
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
  const latches = new Map(); // userId -> { fingerprint, kind, until, strikes, probing }

  /** Records a failure of a call made with `connection`. Only login and throttle failures latch;
   *  anything else (a 404, a timeout, a network failure) is left for the next call to find out. */
  function note(userId, connection, failure) {
    if (!userId || !failure) return;
    const fingerprint = fingerprintOf(connection);
    if (failure.kind === 'login') {
      const before = latches.get(userId);
      const same = before && before.fingerprint === fingerprint && before.kind === 'login';
      // A probe that was refused again doubles the wait; an explicit press that was refused only renews it.
      const strikes = same ? (before.probing ? before.strikes + 1 : before.strikes) : 1;
      const wait = Math.min(LOGIN_PROBE_MAX_MS, LOGIN_PROBE_BASE_MS * 2 ** Math.min(strikes - 1, 16));
      latches.set(userId, { fingerprint, kind: 'login', until: now() + wait, strikes, probing: false });
    } else if (failure.kind === 'throttled') {
      const wait = Number.isFinite(failure.retryAfter) && failure.retryAfter > 0 ? failure.retryAfter * 1000 : DEFAULT_THROTTLE_WAIT_MS;
      latches.set(userId, { fingerprint, kind: 'throttled', until: now() + wait, strikes: 0, probing: false });
    }
  }

  /** The latch holding this account, or null, without changing anything. A latch for other credentials
   *  and a throttle that has run its course are dropped. */
  function inspect(userId, connection) {
    const latch = latches.get(userId);
    if (!latch) return null;
    if (latch.fingerprint !== fingerprintOf(connection)) { latches.delete(userId); return null; }
    if (latch.kind === 'throttled' && now() >= latch.until) { latches.delete(userId); return null; }
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
   *  throttle latches the account, a success clears the latch. Returns nothing. */
  function noteDiaryReply(userId, readConnection, reply, ok) {
    const conn = connectionOf(readConnection, userId);
    if (!conn) return;
    const failure = failureFromDiaryReply(reply);
    if (failure) note(userId, conn, failure);
    else if (ok) clear(userId);
  }

  return { note, blocked, status, statusFor, clear, fingerprintOf, suspendedFor, noteDiaryReply };
}

/** The storage failure a Diary reply reports, in the shape `note` takes, or null. The Diary tags a
 *  refused login (424 storageLoginRejected) and a throttle (503 storageThrottled + retryAfter). */
function failureFromDiaryReply(reply) {
  if (!reply || typeof reply !== 'object') return null;
  if (reply.code === 'storageLoginRejected') return { kind: 'login' };
  if (reply.code === 'storageThrottled') {
    const wait = Number(reply.retryAfter);
    return { kind: 'throttled', ...(Number.isFinite(wait) && wait > 0 ? { retryAfter: wait } : {}) };
  }
  return null;
}

module.exports = { createStorageLatch, fingerprintOf, failureFromDiaryReply, DEFAULT_THROTTLE_WAIT_MS, LOGIN_PROBE_BASE_MS, LOGIN_PROBE_MAX_MS, PROBE_HOLD_MS };
