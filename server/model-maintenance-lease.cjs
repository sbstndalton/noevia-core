'use strict';
// sbstndalton/noevia#2210: with no inference gate configured (the normal production case), the Rust front's
// reload has to be mutually exclusive with this process's chat, tune, calibration, sweep, idle-unload, delete and
// prune, exactly as when the reload ran here. While chat lives in Node, this process's own maintenance gate
// (inference-maintenance.cjs) is the one arbiter: the front asks it for a lease over the loopback connection it
// already proxies through, and a lease IS a hold of that gate. hold() checks and sets in one synchronous step, and
// enter() (chat admission) reads the same flag, so there is no window between the check and the act.
//
//   POST   /internal/model-maintenance/lease             201 {lease, ttlMs, renewMs, hardMs}; 409 {error, chatActive} while busy
//          body (optional): {maxMs}: the hard cap this lease asks for (a calibration run), clamped to
//          [HARD_MS, MAX_MS]; absent, HARD_MS. A maxMs that is not an integer is a 400 and holds nothing.
//   POST   /internal/model-maintenance/lease/<id>/renew  200 {ttlMs}; 404 when it has ended
//   DELETE /internal/model-maintenance/lease/<id>        204, also when it has already ended
//
// A lease not renewed within ttlMs ends by itself, so a front that dies frees chat and tune; hardMs caps it however
// often it is renewed. ttlMs outlasts the longest single router call (120 s): the front starts a step only if its last
// confirmation, and hardMs, still cover that step's whole limit, so a Node that stops hearing renewals cannot end the
// lease under a call in flight. Only the front may ask: the connection must come from loopback, carry the per-start secret
// the web supervisor hands both processes (NOEVIA_PROJECT_STORE_TOKEN), and not be a request the front is proxying
// (a proxied request carries the client's address). Anything else is the same 404 as an unknown path, because with
// file sharing on this listener is not bound to loopback alone. A front that cannot get a lease changes nothing.
const crypto = require('node:crypto');
const { trustedFront } = require('./trusted-front.cjs');

const PREFIX = '/internal/model-maintenance/lease';
const TTL_MS = 180000;
const RENEW_MS = 10000;
const HARD_MS = 60 * 60 * 1000;
// The longest hard cap a lease may ask for. Liveness is unchanged: an unrenewed lease still ends after ttlMs.
const MAX_MS = 8 * 60 * 60 * 1000;
const BODY_LIMIT = 4096;
/** The cap a lease gets for `requested` (undefined: the default). */
const capFor = (requested, hardMs, maxMs) => (requested === undefined ? hardMs : Math.min(Math.max(requested, hardMs), Math.max(hardMs, maxMs)));
function createLeases({ hold, ttlMs = TTL_MS, hardMs = HARD_MS, maxMs = MAX_MS, log = (m) => console.warn(m), now = () => Date.now() }) {
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
    async acquire(requested) {
      const cap = capFor(requested, hardMs, maxMs);
      const release = await hold();
      const id = crypto.randomBytes(16).toString('hex');
      leases.set(id, { release, timer: null, hardAt: now() + cap });
      arm(id);
      return { lease: id, ttlMs, renewMs: Math.min(RENEW_MS, Math.max(1, Math.floor(ttlMs / 3))), hardMs: cap };
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

/** The acquire body: `{ maxMs }` or `{}` (empty is `{}`); null when it is not one (a 400). Bounded in size and time. */
function readAsk(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0, done = false;
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish(null), 10000);
    timer.unref?.();
    req.on('data', (chunk) => { size += chunk.length; if (size > BODY_LIMIT) { finish(null); req.resume(); } else chunks.push(chunk); });
    req.on('error', () => finish(null));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return finish({});
      let ask;
      try { ask = JSON.parse(text); } catch { return finish(null); }
      if (!ask || typeof ask !== 'object' || Array.isArray(ask)) return finish(null);
      if (Object.keys(ask).some((k) => k !== 'maxMs')) return finish(null);
      if (Object.hasOwn(ask, 'maxMs') && !Number.isSafeInteger(ask.maxMs)) return finish(null);
      finish(ask);
    });
  });
}

/** The route, answered before authentication and the request gate. True when it was this route's. */
function createLeaseRoutes({ secret, hold, json, ...options }) {
  const leases = hold ? createLeases({ hold, ...options }) : null;
  const trusted = (req) => trustedFront(req, secret);
  async function handle(req, res) {
    const target = String(req.url || '').split('?')[0];
    if (target !== PREFIX && !target.startsWith(`${PREFIX}/`)) return false;
    const notFound = () => { json(res, 404, { error: 'Not found' }); return true; };
    if (!trusted(req) || !leases) return notFound();
    if (target === PREFIX) {
      if (req.method !== 'POST') return notFound();
      const ask = await readAsk(req);
      if (!ask) { json(res, 400, { error: 'maxMs must be a whole number of milliseconds.' }); return true; }
      try { json(res, 201, await leases.acquire(ask.maxMs)); }
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
      json(res, 200, {});
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

module.exports = { createLeaseRoutes, createLeases, PREFIX, TTL_MS, HARD_MS, MAX_MS };
