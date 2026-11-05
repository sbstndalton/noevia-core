'use strict';
// Port contract row J: the Rust front is the one model-maintenance lease authority (noevia-rs
// bins/noevia-server src/model_maint/lease.rs). It keeps the single table of who holds the engine for
// maintenance (this process's chat-pausing work, or the front's reload and calibration), with the same
// timing this module used to apply itself: unrenewed for ttlMs (180 s) a lease ends; renewed every 10 s;
// a hard cap of 60 min, or what the holder asks for clamped to [60 min, 24 h]; a fresh id and growing
// generation per grant, so a holder that lost its lease cannot act or release a newer one; a new epoch per
// front start, so a restart grants nothing stale.
//
// This module is now two clients of that authority and nothing more:
//
// 1. createNativeLeaseClient: the `remote` of this process's maintenance gate (inference-maintenance.cjs),
//    over the front's private store listener (127.0.0.1:NOEVIA_PROJECT_STORE_PORT, the per-start secret
//    NOEVIA_PROJECT_STORE_TOKEN, as project-store-client.cjs). Tune, calibration, delete, prune, idle-unload,
//    preset writes and the sweep hold the gate; the gate asks the authority. An authority that does not
//    answer fails the hold closed (503): nothing runs without a lease. With an inference gate configured
//    (and its hold API present) the gate stays the authority (#2187); chainRemotes tries it first.
//
// 2. The latch (createLeaseRoutes): chat admission is synchronous and stays in this process
//    (inference-maintenance.cjs enter()), so a lease the front holds must also pause this process's chat.
//    The front, holding the authority's lease, asks for the latch over the loopback connection it already
//    proxies through; a latch is a local-only hold of this process's gate (holdLocal: no second trip to the
//    authority) and has no authority of its own. It ends with the front's lease: the front releases it, or
//    it expires by the same ttl/hard limits when the front stops renewing (a front that dies frees chat).
//
//   POST   /internal/model-maintenance/lease             201 {lease, ttlMs, renewMs, hardMs}; 409 {error, chatActive} while busy
//          body (optional): {maxMs}: the hard cap the front's lease has (a calibration run), clamped to
//          [HARD_MS, MAX_MS]; absent, HARD_MS. A maxMs that is not an integer is a 400 and holds nothing.
//   POST   /internal/model-maintenance/lease/<id>/renew  200 {ttlMs}; 404 when it has ended
//   DELETE /internal/model-maintenance/lease/<id>        204, also when it has already ended
//
// Only the front may ask: the connection must come from loopback, carry the per-start secret and not be a
// request the front is proxying. Anything else is the same 404 as an unknown path.
const crypto = require('node:crypto');
const { trustedFront } = require('./trusted-front.cjs');

const PREFIX = '/internal/model-maintenance/lease';
// noevia deploy/tools/assemble-release.sh pairs this core with a front whose authority carries
// "noevia-maintenance-lease-authority/1" (and refuses this client without it). Keep the quoted literal.
const LEASE_CLIENT_MARKER = 'noevia-maintenance-lease-client/1';
const NATIVE_PREFIX = '/v1/maintenance-lease';
const CALL_TIMEOUT_MS = 5000;
const MAX_WAIT_MS = 30000;
const TTL_MS = 180000;
const RENEW_MS = 10000;
const HARD_MS = 60 * 60 * 1000;
// The longest hard cap a lease may ask for (only the front's calibration asks: a run's worst case, which at 1M
// context passes 8 h). Liveness is unchanged: an unrenewed lease still ends after ttlMs (180 s).
const MAX_MS = 24 * 60 * 60 * 1000;
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

function unavailable(cause) {
  return Object.assign(new Error('The maintenance lease authority is not answering, so nothing was changed. Try again shortly.'), { status: 503, code: 'maintenanceAuthorityUnavailable', cause });
}

/** The maintenance gate's `remote` over the front's authority (see the header). Never answers null: a
 *  hold it cannot take is a 409 (busy) or a 503 (no answer), so the gate never falls back to a local hold. */
function createNativeLeaseClient({ port, token, fetchImpl = globalThis.fetch, boot = crypto.randomBytes(16).toString('hex'), timeoutMs = CALL_TIMEOUT_MS }) {
  const ok = Number.isInteger(port) && port > 0 && port < 65536 && String(token || '').length > 0;
  async function call(op, body, wait = timeoutMs, signal = null) {
    if (!ok) throw unavailable();
    const deadline = AbortSignal.timeout(wait);
    let res;
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}${NATIVE_PREFIX}/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-noevia-store-token': token },
        body: JSON.stringify({ boot, ...body }),
        signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
      });
    } catch (err) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      throw unavailable(err);
    }
    let parsed = null;
    try { const text = await res.text(); parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed };
  }
  const session = () => call('session', {}).catch(() => null);
  // This start's boot, so the authority drops any lease a previous (crashed) start of this process held.
  void session();
  return {
    marker: LEASE_CLIENT_MARKER,
    hasAdmin: () => true,
    /** {token, idleTtlMs, generation, header: false} | throws 409 (held) | throws 503 (no answer). */
    async holdMaintenance(reason, { waitMs = 0, signal, maxMs } = {}) {
      const wait = Math.max(0, Math.min(MAX_WAIT_MS, Number(waitMs) || 0));
      const ask = { reason: String(reason || '').slice(0, 300), waitMs: wait, ...(maxMs === undefined ? {} : { maxMs }) };
      const { status, body } = await call('acquire', ask, wait + timeoutMs, signal);
      if (status === 201 && body && typeof body.lease === 'string' && /^[0-9a-f]{32}$/.test(body.lease)) {
        const renewMs = Number.isSafeInteger(body.renewMs) && body.renewMs > 0 ? body.renewMs : 10000;
        // The gate renews every third of idleTtlMs: the authority's own cadence (renewMs).
        return { token: body.lease, idleTtlMs: renewMs * 3, generation: body.generation, epoch: body.epoch, ttlMs: body.ttlMs, hardMs: body.hardMs, header: false };
      }
      if (status === 409) throw Object.assign(new Error(body?.error || 'Inference is busy.'), { status: 409, code: 'maintenance_held', chatActive: false });
      throw unavailable();
    },
    /** true: renewed; false: the lease has ended; null: no answer. */
    async renewMaintenance(lease, reason) {
      try {
        const { status } = await call('renew', { lease, ...(reason ? { reason: String(reason).slice(0, 300) } : {}) });
        return status === 200 ? true : status === 404 ? false : null;
      } catch { return null; }
    },
    async releaseMaintenance(lease) {
      try { await call('release', { lease }); } catch { /* an unreleased lease ends by itself */ }
    },
    async maintenanceHeld() {
      try { const { status, body } = await call('held', {}); return status === 200 && typeof body?.held === 'boolean' ? body.held : null; } catch { return null; }
    },
    session,
  };
}

/** The inference gate first (#2187: the authority when it has the hold API), the native authority when
 *  the gate answers it has none (null). Each token is renewed and released where it was granted. */
function chainRemotes(gate, native) {
  const fromNative = new Set();
  return {
    hasAdmin: () => true,
    async holdMaintenance(reason, options) {
      const granted = await gate.holdMaintenance(reason, options);
      if (granted !== null) return granted;
      const own = await native.holdMaintenance(reason, options);
      fromNative.add(own.token);
      return own;
    },
    renewMaintenance: (t, reason) => (fromNative.has(t) ? native : gate).renewMaintenance(t, reason),
    releaseMaintenance(t) { const n = fromNative.delete(t); return (n ? native : gate).releaseMaintenance(t); },
    async maintenanceHeld() {
      const held = typeof gate.maintenanceHeld === 'function' ? await gate.maintenanceHeld().catch(() => null) : null;
      if (held === true) return true;
      const own = await native.maintenanceHeld();
      return held === false && own === null ? false : own;
    },
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

module.exports = { createLeaseRoutes, createLeases, createNativeLeaseClient, chainRemotes, LEASE_CLIENT_MARKER, PREFIX, NATIVE_PREFIX, TTL_MS, HARD_MS, MAX_MS };
