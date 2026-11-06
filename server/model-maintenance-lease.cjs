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
//    it expires by the same ttl/hard limits when the front stops renewing, transferring admission to
//    recovery-required exclusion until a fresh covered repair confirms settlement.
//
//   POST   /internal/model-maintenance/lease             201 {lease, ttlMs, renewMs, hardMs}; 409 {error, chatActive} while busy
//          body (optional): {maxMs}: the hard cap the front's lease has (a calibration run), clamped to
//          [HARD_MS, MAX_MS]; absent, HARD_MS. A maxMs that is not an integer is a 400 and holds nothing.
//   POST   /internal/model-maintenance/lease/<id>/renew  200 {ttlMs}; 404 when it has ended
//   DELETE /internal/model-maintenance/lease/<id>        204, also when it has already ended
//   DELETE /internal/model-maintenance/lease/ticket/<t>  204: ends the latch asked for with body {ticket: t}
//          (the front's lease id), also when the grant's answer never reached the front
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
/** Cancellation retention capacity. With no enforced arrival lifetime, retention lasts until restart;
 *  saturation refuses new admissions rather than evicting a still-admissible cancellation. */
const TICKET_TOMBSTONE_MS = 10 * 60 * 1000;
const TICKET_TOMBSTONES = 1024;

function cancelledTicket() {
  return Object.assign(new Error('That maintenance hold was given back before it was granted.'), { status: 410 });
}

function createLeases({ hold, ttlMs = TTL_MS, hardMs = HARD_MS, maxMs = MAX_MS, log = (m) => console.warn(m), now = () => Date.now(),
  ticketTombstoneMs = TICKET_TOMBSTONE_MS, ticketTombstones = TICKET_TOMBSTONES, barrier = null }) {
  const leases = new Map();
  const tombstones = new Map(); // ticket -> expiry, oldest first
  let inflight = 0;
  const pending = new Map(); // ticket -> the grant being taken under it
  // Tickets have no enforced arrival lifetime. Never forget a cancellation within this process.
  // At capacity refuse new admissions rather than resurrecting delayed requests.
  let saturated = false, unbar = null;
  const recoveryKeys = new Set(), completedRecoveries = new Set();
  let recoveryOverflow=false;
  function requireRecovery(ticket='legacy') {
    if(completedRecoveries.has(ticket))return;
    if(!recoveryKeys.has(ticket) && recoveryKeys.size >= ticketTombstones) { recoveryOverflow=true;saturated=true; }
    else recoveryKeys.add(ticket);
    if (!unbar && barrier) unbar = barrier();
  }
  function completeRecovery(ticket='legacy') {
    if(recoveryOverflow || new Set([...completedRecoveries,...recoveryKeys,ticket]).size > ticketTombstones) {
      recoveryOverflow=true;saturated=true;if(!unbar&&barrier)unbar=barrier();return;
    }
    // One exclusive repair settles every earlier latch. Retire its ticket too, so a delayed
    // barrier POST from a released hold cannot re-arm an already completed incident.
    completedRecoveries.add(ticket);
    for(const key of recoveryKeys)completedRecoveries.add(key);
    recoveryKeys.clear();
    if(completedRecoveries.size >= ticketTombstones)saturated=true;
    const lift = unbar; unbar = null; lift?.();
  }
  function tombstoned(ticket) { return !!ticket && tombstones.has(ticket); }
  function end(id, why) {
    const lease = leases.get(id);
    if (!lease) return false;
    leases.delete(id);
    clearTimeout(lease.timer);
    if (why) requireRecovery(lease.ticket || id);
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
  const grantOf = (id, lease) => ({ lease: id, ttlMs, renewMs: Math.min(RENEW_MS, Math.max(1, Math.floor(ttlMs / 3))), hardMs: lease.cap });
  async function take(requested, ticket, state, recovery=false) {
    const cap = capFor(requested, hardMs, maxMs);
    inflight++;
    let release;
    try { release = await hold({recovery}); } finally { inflight--; }
    // A DELETE that came while the hold was being taken: give it back at once.
    if (state?.cancelled || tombstoned(ticket)) { release(); throw cancelledTicket(); }
    const id = crypto.randomBytes(16).toString('hex');
    const lease = { release, timer: null, hardAt: now() + cap, cap, ticket: ticket || null };
    leases.set(id, lease);
    arm(id);
    return grantOf(id, lease);
  }
  return {
    /** Takes the hold, or rejects as hold() does (409 while busy); 410 for a ticket already given back.
     *  One ticket is one latch: a repeated ask returns the grant taken (or being taken) under it. */
    async acquire(requested, ticket, recovery=false) {
      if (tombstoned(ticket)) throw cancelledTicket();
      if (ticket) {
        for (const [id, lease] of leases) if (lease.ticket === ticket) return grantOf(id, lease);
        if (pending.has(ticket)) return pending.get(ticket).promise;
        if (saturated || inflight >= ticketTombstones) throw unavailable();
        const state = { cancelled: false, promise: null };
        const taking = take(requested, ticket, state, recovery).finally(() => pending.delete(ticket));
        state.promise = taking;
        pending.set(ticket, state);
        return taking;
      }
      if (saturated || inflight >= ticketTombstones) throw unavailable();
      return take(requested, null, null, recovery);
    },
    renew(id) {
      const lease = leases.get(id);
      if (!lease || lease.hardAt <= now()) return false;
      arm(id);
      return true;
    },
    release: (id) => end(id, null),
    /** Row J review: ends the latch the front asked for under `ticket`, whether or not its grant reached it,
     *  and remembers the ticket (bounded) so a grant that lands later is refused or given back. */
    releaseTicket(ticket) {
      if (!ticket) return false;
      const state = pending.get(ticket);
      if (state) state.cancelled = true;
      if (tombstones.has(ticket) || tombstones.size < ticketTombstones) tombstones.set(ticket, true);
      else saturated = true;
      for (const [id, lease] of leases) if (lease.ticket === ticket) return end(id, null);
      return false;
    },
    requireRecovery, completeRecovery,
    size: () => leases.size,
  };
}

function unavailable(cause) {
  return Object.assign(new Error('The maintenance lease authority is not answering, so nothing was changed. Try again shortly.'), { status: 503, code: 'maintenanceAuthorityUnavailable', cause });
}

/** The maintenance gate's `remote` over the front's authority (see the header). Never answers null: a
 *  hold it cannot take is a 409 (busy) or a 503 (no answer), so the gate never falls back to a local hold.
 *
 *  Row J review: this process start registers first (`session {boot, startedAt}`); the authority issues an
 *  ordered incarnation that every later call carries, and answers 410 once a newer start has registered.
 *  ready() resolves once the start is registered and no lease the front holds remains (the gate keeps chat
 *  closed until then). Grants are `native`: the gate gives them their own fail-closed lifecycle. Holds of
 *  this process ask for the longest cap (MAX_MS) unless the caller asks less; liveness is the TTL. */
function createNativeLeaseClient({ port, token, fetchImpl = globalThis.fetch, boot = crypto.randomBytes(16).toString('hex'), startedAt = Date.now(), timeoutMs = CALL_TIMEOUT_MS, retryMs = 1000, now = () => Date.now() }) {
  const ok = Number.isInteger(port) && port > 0 && port < 65536 && String(token || '').length > 0;
  let incarnation = null, retired = false;
  async function call(op, body, wait = timeoutMs, signal = null) {
    if (!ok) throw unavailable();
    const deadline = AbortSignal.timeout(wait);
    let res;
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}${NATIVE_PREFIX}/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-noevia-store-token': token },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
      });
    } catch (err) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      throw unavailable(err);
    }
    let parsed = null;
    try { const text = await res.text(); parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (res.status === 410) { retired = true; incarnation = null; }
    return { status: res.status, body: parsed };
  }
  /** Registers this start; {incarnation, frontHeld}. Throws 503 when it cannot (also once retired). */
  async function session() {
    if (retired) throw unavailable();
    const { status, body } = await call('session', { boot, startedAt });
    if (status === 200 && Number.isSafeInteger(body?.incarnation)) {
      incarnation = body.incarnation;
      return { incarnation, frontHeld: body.frontHeld === true };
    }
    throw unavailable();
  }
  async function registered() { if (incarnation === null) await session(); return incarnation; }
  const pause = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
  let readiness = null;
  /** Resolves once this start is registered and the front holds no lease (retrying every retryMs). */
  function ready() {
    if (!readiness) readiness = (async () => {
      for (;;) {
        try {
          const { frontHeld } = await session();
          if (!frontHeld) return;
          const { status, body } = await call('held', { incarnation });
          if (status === 200 && body?.front === false) return;
        } catch { /* not answering yet: chat stays closed */ }
        if (retired) return new Promise(() => {}); // a newer start of this process exists: stay closed
        await pause(retryMs);
      }
    })();
    return readiness;
  }
  return {
    marker: LEASE_CLIENT_MARKER,
    hasAdmin: () => true,
    ready,
    /** A native grant {token, native, askedAt, ttlMs, renewMs, hardMs, generation, header: false} | throws
     *  409 (held) | throws 503 (no answer, or this start was retired). */
    async holdMaintenance(reason, { waitMs = 0, signal, maxMs = MAX_MS } = {}) {
      const wait = Math.max(0, Math.min(MAX_WAIT_MS, Number(waitMs) || 0));
      const inc = await registered();
      const askedAt = now();
      const ask = { incarnation: inc, reason: String(reason || '').slice(0, 300), waitMs: wait, maxMs };
      const { status, body } = await call('acquire', ask, wait + timeoutMs, signal);
      if (status === 201 && body && typeof body.lease === 'string' && /^[0-9a-f]{32}$/.test(body.lease)
        && [body.ttlMs, body.renewMs, body.hardMs].every((v) => Number.isSafeInteger(v) && v > 0)) {
        return { token: body.lease, native: true, askedAt, ttlMs: body.ttlMs, renewMs: body.renewMs, hardMs: body.hardMs, generation: body.generation, epoch: body.epoch, idleTtlMs: body.renewMs * 3, header: false };
      }
      if (status === 409) throw Object.assign(new Error(body?.error || 'Inference is busy.'), { status: 409, code: 'maintenance_held', chatActive: false });
      throw unavailable();
    },
    /** true: renewed; false: the lease has ended (or this start was retired); null: no answer. */
    async renewMaintenance(lease, reason) {
      if (retired || incarnation === null) return false;
      try {
        const { status } = await call('renew', { incarnation, lease, ...(reason ? { reason: String(reason).slice(0, 300) } : {}) });
        return status === 200 ? true : status === 404 || status === 410 ? false : null;
      } catch { return null; }
    },
    async releaseMaintenance(lease) {
      if (retired || incarnation === null) return;
      try { await call('release', { incarnation, lease }); } catch { /* an unreleased lease ends by itself */ }
    },
    async maintenanceHeld() {
      try {
        const inc = await registered();
        const { status, body } = await call('held', { incarnation: inc });
        return status === 200 && typeof body?.held === 'boolean' ? body.held : null;
      } catch { return null; }
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
    ...(typeof native.ready === 'function' ? { ready: () => native.ready() } : {}),
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
      if (Object.keys(ask).some((k) => k !== 'maxMs' && k !== 'ticket' && k !== 'recovery')) return finish(null);
      if (Object.hasOwn(ask, 'recovery') && typeof ask.recovery !== 'boolean') return finish(null);
      if (Object.hasOwn(ask, 'ticket') && !(typeof ask.ticket === 'string' && /^[0-9a-f]{32}$/.test(ask.ticket))) return finish(null);
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
    if (target.startsWith(`${PREFIX}/recovery/`)) {
      const ticket=target.slice(`${PREFIX}/recovery/`.length);
      if(!/^[0-9a-f]{32}$/.test(ticket))return notFound();
      if (req.method === 'POST') { leases.requireRecovery(ticket); json(res, 204, null); return true; }
      if (req.method === 'DELETE') { leases.completeRecovery(ticket); json(res, 204, null); return true; }
      return notFound();
    }
    if (target === PREFIX) {
      if (req.method !== 'POST') return notFound();
      const ask = await readAsk(req);
      if (!ask) { json(res, 400, { error: 'maxMs must be a whole number of milliseconds.' }); return true; }
      try { json(res, 201, await leases.acquire(ask.maxMs, ask.ticket, ask.recovery===true)); }
      catch (e) {
        if (e?.status === 409) json(res, 409, { error: e.message, chatActive: e.chatActive === true });
        else if (e?.status === 410) json(res, 410, { error: e.message, code: 'ticketCancelled' });
        else json(res, 503, { error: 'The maintenance hold could not be taken.' });
      }
      return true;
    }
    const ticket = /^\/ticket\/([0-9a-f]{32})$/.exec(target.slice(PREFIX.length));
    if (ticket) {
      if (req.method !== 'DELETE') return notFound();
      leases.releaseTicket(ticket[1]);
      res.statusCode = 204;
      res.end();
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
