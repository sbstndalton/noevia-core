'use strict';

// #1429: automatic storage calls must not feed Nextcloud's brute-force protection. Once a saved
// login is refused (401), or storage throttles it (429), the account's automatic calls (the
// project source refresh, the Diary storage backup) stop until the saved credentials change or the
// person asks again (an explicit request, which always runs and re-latches on another refusal).
// A throttle also holds automatic calls until its Retry-After has passed.
//
// The latch is per account (userId), in memory: a restart allows one automatic attempt per account,
// which is the bounded cost this design accepts. It stores a fingerprint of the connection
// (kind, server, username and app password), never the secret itself, so a change of credentials
// clears it on its own.

const crypto = require('node:crypto');

const DEFAULT_THROTTLE_WAIT_MS = 60 * 1000;

function fingerprintOf(connection) {
  const c = connection && typeof connection === 'object' ? connection : {};
  return crypto.createHash('sha256').update(JSON.stringify([
    String(c.kind || ''), String(c.baseUrl || ''), String(c.bucket || ''), String(c.username || ''), String(c.secret || ''),
  ])).digest('hex');
}

function createStorageLatch({ now = Date.now } = {}) {
  const latches = new Map(); // userId -> { fingerprint, kind, until }

  /** Records a failure of a call made with `connection`. Only login and throttle failures latch;
   *  anything else (a 404, a timeout, a network failure) is left for the next call to find out. */
  function note(userId, connection, failure) {
    if (!userId || !failure) return;
    if (failure.kind === 'login') {
      latches.set(userId, { fingerprint: fingerprintOf(connection), kind: 'login', until: Infinity });
    } else if (failure.kind === 'throttled') {
      const wait = Number.isFinite(failure.retryAfter) && failure.retryAfter > 0 ? failure.retryAfter * 1000 : DEFAULT_THROTTLE_WAIT_MS;
      latches.set(userId, { fingerprint: fingerprintOf(connection), kind: 'throttled', until: now() + wait });
    }
  }

  /** The latch that holds this account's automatic calls, or null. A latch for other credentials
   *  is dropped, and a throttle that has run its course is dropped. */
  function blocked(userId, connection) {
    const latch = latches.get(userId);
    if (!latch) return null;
    if (latch.fingerprint !== fingerprintOf(connection)) { latches.delete(userId); return null; }
    if (latch.kind === 'throttled' && now() >= latch.until) { latches.delete(userId); return null; }
    return { kind: latch.kind, ...(latch.kind === 'throttled' ? { retryAfter: Math.max(1, Math.ceil((latch.until - now()) / 1000)) } : {}) };
  }

  /** A call that worked proves the credentials are good again. */
  function clear(userId) { latches.delete(userId); }

  /** The saved connection of an account, or null when there is none (or it cannot be read). */
  function connectionOf(readConnection, userId) {
    try { return readConnection(userId) || null; } catch { return null; }
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

  return { note, blocked, clear, fingerprintOf, suspendedFor, noteDiaryReply };
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

module.exports = { createStorageLatch, fingerprintOf, failureFromDiaryReply, DEFAULT_THROTTLE_WAIT_MS };
