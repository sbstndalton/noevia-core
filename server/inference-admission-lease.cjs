'use strict';
// sbstndalton/noevia#2218: the Rust front's model steps enter this process's own admission (noevia-rs crates/engine-admission):
// while chat, tuning and the engine manager live here, this process is the one arbiter of the one-model rule, the
// inference budget (#697) and the maintenance gate. A lease IS a hold of what a local request holds here.
//
//   POST   /internal/inference-admission/lease             {model} | {role, machine, model}
//          201 {lease, ttlMs, headers?}; 409/503 {error, code?}
//   POST   /internal/inference-admission/lease/<id>/renew  200 {ttlMs}; 404 when it has ended
//   DELETE /internal/inference-admission/lease/<id>        204, also when it has already ended
//
// Engine: maintenance enter, then the gate's lease when a gate is configured (which includes the budget check), else
// the budget check alone. Machine: nothing is admitted here; the machine's health and served model are checked, and it
// counts a turn while the lease lasts (#1849, #1880). A lease not renewed within ttlMs ends by itself, so a front that
// dies frees chat and tune. Only the front may ask (the same check as its other loopback calls), and a caller that
// goes away while waiting holds nothing.
const crypto = require('node:crypto');
const { trustedFront } = require('./trusted-front.cjs');

const PREFIX = '/internal/inference-admission/lease';
const TTL_MS = 30000;
const HARD_MS = 6 * 60 * 60 * 1000;
const MAX_WAIT_MS = 120000;
const BUSY = 'The model is busy. Try again shortly.';

/** Aborts when the caller goes away before this answer has been sent. */
function callerGone(req, res) {
  const controller = new AbortController();
  const gone = () => { if (!res.writableEnded) controller.abort(); };
  req.once('close', () => { if (req.destroyed && !req.complete) gone(); });
  res.once('close', gone);
  return controller.signal;
}

function refusal(status, message, code) {
  return Object.assign(Error(message), { status, publicMessage: message, code });
}

function createAdmission({ modelManager, admitEngineModel, chatMachines = null }) {
  /** What one local step holds, or a refusal in that step's words. */
  async function holdEngine(model, signal) {
    let leave;
    try { leave = modelManager.enterInference?.() || (() => {}); }
    catch (e) { throw Object.assign(e, { publicMessage: e.publicMessage || (e.status === 503 ? e.message : BUSY) }); }
    let gate = null;
    try {
      if (typeof modelManager.acquireLease === 'function') gate = await modelManager.acquireLease(model, { signal, maxWaitMs: MAX_WAIT_MS });
      else await admitEngineModel(model, signal);
      signal?.throwIfAborted();
    } catch (e) {
      leave();
      if (gate) await gate.release?.().catch?.(() => {});
      throw e;
    }
    return {
      headers: gate?.headers?.() || null,
      release() {
        Promise.resolve(gate?.release?.()).catch(() => {});
        leave();
      },
    };
  }
  async function holdMachine({ role, machine, model }) {
    const target = chatMachines?.target(role);
    // The assignment moved since the front read it: say so rather than count a turn on the wrong machine.
    if (!target || target.machine?.id !== machine || target.model !== model) throw refusal(409, BUSY);
    const ready = await chatMachines.ready(target);
    if (!ready.ok) throw refusal(409, ready.error, ready.code || 'machineUnreachable');
    const release = typeof chatMachines.beginTurn === 'function' ? chatMachines.beginTurn(machine) : () => {};
    return { headers: null, release };
  }
  return (ask, signal) => {
    const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 1024;
    if (!text(ask?.model)) throw refusal(400, 'A model is required.');
    if (ask.role === undefined && ask.machine === undefined) return holdEngine(ask.model, signal);
    if (ask.role !== 'smart' || !text(ask.machine)) throw refusal(400, 'Only the Smart role runs research.');
    return holdMachine(ask);
  };
}

function createLeases({ ttlMs = TTL_MS, hardMs = HARD_MS, log = (m) => console.warn(m), now = () => Date.now() } = {}) {
  const leases = new Map();
  function end(id, why) {
    const lease = leases.get(id);
    if (!lease) return false;
    leases.delete(id);
    clearTimeout(lease.timer);
    lease.release();
    if (why) log(`[models] the front's inference lease ${why}; it no longer holds the engine`);
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
    add(held) {
      const id = crypto.randomBytes(16).toString('hex');
      leases.set(id, { release: held.release, timer: null, hardAt: now() + hardMs });
      arm(id);
      return id;
    },
    renew(id) {
      const lease = leases.get(id);
      if (!lease || lease.hardAt <= now()) return false;
      arm(id);
      return true;
    },
    release: (id) => end(id, null),
    size: () => leases.size,
    ttlMs,
  };
}

/** The route, answered before authentication and the request gate. True when it was this route's. */
function createAdmissionRoutes({ secret, modelManager, admitEngineModel, chatMachines, json, readJson, ...options }) {
  const leases = createLeases(options);
  const admit = createAdmission({ modelManager, admitEngineModel, chatMachines });
  async function handle(req, res) {
    const target = String(req.url || '').split('?')[0];
    if (target !== PREFIX && !target.startsWith(`${PREFIX}/`)) return false;
    const notFound = () => { json(res, 404, { error: 'Not found' }); return true; };
    if (!trustedFront(req, secret)) return notFound();
    if (target === PREFIX) {
      if (req.method !== 'POST') return notFound();
      const signal = callerGone(req, res);
      let held = null;
      try {
        const ask = await readJson(req);
        held = await admit(ask, signal);
        // A wait the caller gave up on must not leave the model held for the lease's whole life.
        if (signal.aborted) { held.release(); return true; }
        const id = leases.add(held);
        json(res, 201, { lease: id, ttlMs: leases.ttlMs, ...(held.headers ? { headers: held.headers } : {}) });
      } catch (e) {
        if (signal.aborted) { res.destroy?.(); return true; }
        const status = [400, 409, 503].includes(e?.status) ? e.status : 503;
        json(res, status, { error: e?.publicMessage || BUSY, ...(e?.code ? { code: e.code } : {}) });
      }
      return true;
    }
    const match = /^\/([0-9a-f]{32})(\/renew)?$/.exec(target.slice(PREFIX.length));
    if (!match) return notFound();
    if (req.method === 'POST' && match[2]) {
      if (!leases.renew(match[1])) return notFound();
      json(res, 200, { ttlMs: leases.ttlMs });
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

module.exports = { createAdmissionRoutes, createAdmission, createLeases, callerGone, PREFIX, TTL_MS, MAX_WAIT_MS };
