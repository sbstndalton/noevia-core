'use strict';
// sbstndalton/noevia#2210: with no inference gate configured (the normal production case), the Rust front's
// reload has to be mutually exclusive with this process's chat, tune, calibration, sweep, idle-unload, delete and
// prune, exactly as when the reload ran here. While chat lives in Node, this process's own maintenance gate
// (inference-maintenance.cjs) is the one arbiter: the front asks it for a lease over the loopback connection it
// already proxies through, and a lease IS a hold of that gate. hold() checks and sets in one synchronous step, and
// enter() (chat admission) reads the same flag, so there is no window between the check and the act.
//
//   POST   /internal/model-maintenance/lease             201 {lease, ttlMs}; 409 {error, chatActive} while busy
//   POST   /internal/model-maintenance/lease/<id>/renew  200 {ttlMs}; 404 when it has ended
//   DELETE /internal/model-maintenance/lease/<id>        204, also when it has already ended
//
// A lease not renewed within ttlMs ends by itself, so a front that dies frees chat and tune; hardMs caps it however
// often it is renewed. Only the front may ask: the connection must come from loopback, carry the per-start secret
// the web supervisor hands both processes (NOEVIA_PROJECT_STORE_TOKEN), and not be a request the front is proxying
// (a proxied request carries the client's address). Anything else is the same 404 as an unknown path, because with
// file sharing on this listener is not bound to loopback alone. A front that cannot get a lease changes nothing.
const crypto = require('node:crypto');

const PREFIX = '/internal/model-maintenance/lease';
const TTL_MS = 30000;
const HARD_MS = 60 * 60 * 1000;
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

function sameSecret(given, secret) {
  if (typeof given !== 'string' || !secret) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

function createLeases({ hold, ttlMs = TTL_MS, hardMs = HARD_MS, log = (m) => console.warn(m), now = () => Date.now() }) {
  const leases = new Map();
  function end(id, why) {
    const lease = leases.get(id);
    if (!lease) return false;
    leases.delete(id);
    clearTimeout(lease.timer);
    lease.release();
    if (why) log(`[models] the front's maintenance lease ${why}; chat and tuning may run again`);
    return true;
  }
  function arm(id) {
    const lease = leases.get(id);
    if (!lease) return;
    clearTimeout(lease.timer);
    const left = Math.min(ttlMs, lease.hardAt - now());
    lease.timer = setTimeout(() => end(id, lease.hardAt <= now() ? 'passed its limit' : 'was not renewed'), Math.max(0, left));
    lease.timer.unref?.();
  }
  return {
    /** Takes the hold, or rejects as hold() does (409 while busy). */
    async acquire() {
      const release = await hold();
      const id = crypto.randomBytes(16).toString('hex');
      leases.set(id, { release, timer: null, hardAt: now() + hardMs });
      arm(id);
      return { lease: id, ttlMs };
    },
    renew(id) {
      const lease = leases.get(id);
      if (!lease || lease.hardAt <= now()) return false;
      arm(id);
      return true;
    },
    release: (id) => end(id, null),
    size: () => leases.size,
  };
}

/** The route, answered before authentication and the request gate. True when it was this route's. */
function createLeaseRoutes({ secret, hold, json, ...options }) {
  const leases = hold ? createLeases({ hold, ...options }) : null;
  function trusted(req) {
    return LOOPBACK.test(req.socket?.remoteAddress || '')
      && !req.headers['x-noevia-client-ip'] && !req.headers['x-forwarded-for']
      && sameSecret(req.headers['x-noevia-store-token'], secret);
  }
  async function handle(req, res) {
    const target = String(req.url || '').split('?')[0];
    if (target !== PREFIX && !target.startsWith(`${PREFIX}/`)) return false;
    const notFound = () => { json(res, 404, { error: 'Not found' }); return true; };
    if (!trusted(req) || !leases) return notFound();
    if (target === PREFIX) {
      if (req.method !== 'POST') return notFound();
      try { json(res, 201, await leases.acquire()); }
      catch (e) {
        if (e?.status === 409) json(res, 409, { error: e.message, chatActive: e.chatActive === true });
        else json(res, 503, { error: 'The maintenance hold could not be taken.' });
      }
      return true;
    }
    const match = /^\/([0-9a-f]{32})(\/renew)?$/.exec(target.slice(PREFIX.length));
    if (!match) return notFound();
    if (req.method === 'POST' && match[2]) {
      if (!leases.renew(match[1])) return notFound();
      json(res, 200, { ttlMs: options.ttlMs || TTL_MS });
      return true;
    }
    if (req.method === 'DELETE' && !match[2]) {
      leases.release(match[1]);
      res.statusCode = 204;
      res.end();
      return true;
    }
    return notFound();
  }
  return { handle, leases };
}

module.exports = { createLeaseRoutes, createLeases, PREFIX, TTL_MS };
