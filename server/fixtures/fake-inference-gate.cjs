'use strict';
// A synthetic stand-in for the inference gate client (inference-gate-client.cjs), for tests of the
// model manager and its callers (noevia#2115). It records every lease asked for and given back, can
// hold a lease until the test grants it (another chat's model is in use), and can refuse like the
// gate does. No network, no model, no request content.
const { GateError, LEASE_HEADER, createGateClient } = require('../inference-gate-client.cjs');

/**
 * @param {{ admin?: string|null, refuse?: { code: string, status?: number, retryable?: boolean, message: string } | null, hold?: boolean, absent?: boolean }} [options]
 */
function fakeGate({ admin = null, refuse = null, hold = false, absent = false } = {}) {
  const log = { acquired: [], released: [], aborted: [], queued: [] };
  const pending = [];
  let waiting = 0, issued = 0;
  const { refusal } = createGateClient({ baseUrl: 'http://fake-gate.invalid' });
  const lease = (model) => {
    const token = (++issued).toString(16).padStart(32, '0');
    let given = false;
    return {
      model, token,
      headers: () => ({ [LEASE_HEADER]: token }),
      release: async () => { if (given) return; given = true; log.released.push(model); },
      fetch: (base) => (url, init = {}) => base(url, { ...init, headers: { ...(init.headers || {}), [LEASE_HEADER]: token } }),
    };
  };
  return {
    log,
    async acquire(model, { signal, onQueued } = {}) {
      signal?.throwIfAborted();
      if (refuse) throw new GateError(refuse);
      if (absent) return null;
      waiting++;
      try {
        if (hold) {
          log.queued.push(model);
          const granted = new Promise((resolve, reject) => {
            const leave = () => { const i = pending.indexOf(resolve); if (i >= 0) pending.splice(i, 1); log.aborted.push(model); reject(signal.reason); };
            pending.push(resolve);
            signal?.addEventListener('abort', leave, { once: true });
          });
          onQueued?.({ position: pending.length, waitedMs: 0 });
          await granted;
        }
      } finally { waiting--; }
      log.acquired.push(model);
      return lease(model);
    },
    /** Grants the oldest held lease. */
    grant: () => { const next = pending.shift(); next?.(); return !!next; },
    waiting: () => waiting,
    adminHeaders: () => (admin ? { 'X-Noevia-Gate-Admin': admin } : null),
    hasAdmin: () => !!admin,
    refusal,
  };
}

/** The gate's JSON refusal for a forwarded request, as the router-shaped fetchJson fakes return it. */
const gateRefusal = (status, code, message, retryable = false) => ({ ok: false, status, body: { error: { code, message, type: 'gate_error', retryable } } });

module.exports = { fakeGate, gateRefusal };
