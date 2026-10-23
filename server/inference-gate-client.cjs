'use strict';
// sbstndalton/noevia#2115, #2117: the web's client of the inference gate (noevia-rs
// bins/noevia-inference-gate). The gate is the only published entry to the chat engine router and
// the only process that unloads a model; it unloads only an idle one, and only while another model
// waits. This process no longer evicts anything itself.
//
// A chat turn (and every other stage that makes several requests on one model) takes a lease first:
// `POST /gate/v1/leases` answers with an event stream that reports the queue position (`queued`)
// until the lease is `granted`, or an `error`. Every request of the turn then carries the lease in
// `X-Noevia-Lease`, so the gate never switches the model away between the turn's rounds, retries,
// compaction and title. The lease is released when the turn ends; the gate also ends it on its own
// after an idle time (a turn that waits minutes for an approval or a slow tool loses its lease, and
// a gate that restarted has forgotten its leases): a request answered 409 `lease_unknown` takes a
// new lease and is sent again, once per request, however often that happens in one turn.
//
// Without a gate in front of the router (a development setup: the router answers the lease request
// 404 with its own error), turns run without a lease and the router's own queue decides; this is
// said once in the log. The gate's refusals are GateErrors with a stable code, an HTTP status, a
// retryable flag and plain text for people; never a model's output or a request body.
const { readCappedText } = require('./http.cjs');
const LEASE_HEADER = 'X-Noevia-Lease';
const ADMIN_HEADER = 'X-Noevia-Gate-Admin';
const CLIENT_HEADER = 'X-Noevia-Client';
const REFUSAL_HEADER = 'x-noevia-gate-refusal';
const LEASE_TOKEN = /^[0-9a-f]{32}$/;
// The largest single event the gate sends is well under 1 KiB; a stream that grows past this is
// not the gate's.
const MAX_EVENT_BYTES = 16384;
const RELEASE_TIMEOUT_MS = 5000;

class GateError extends Error {
  constructor({ code, message, status = 503, retryable = false }) {
    super(message);
    this.name = 'GateError';
    this.code = code;
    this.status = status;
    this.retryable = retryable === true;
    this.publicMessage = message;
  }
}

const unavailable = () => new GateError({ code: 'engine_unavailable', status: 502, retryable: true,
  message: 'The local model engine is not answering. Try again shortly.' });

// A gate refusal from its JSON body, or null when the body is not the gate's.
function refusalOf(status, body) {
  const e = body && typeof body === 'object' ? body.error : null;
  if (!e || typeof e !== 'object' || e.type !== 'gate_error' || typeof e.code !== 'string') return null;
  return new GateError({ code: e.code, status, retryable: e.retryable === true,
    message: typeof e.message === 'string' && e.message ? e.message.slice(0, 300) : 'The inference gate refused the request.' });
}

// Splits an event stream into { event, data } records, bounded per event.
async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message', data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      let parsed = null;
      try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
      yield { event, data: parsed };
    }
    if (buffer.length > MAX_EVENT_BYTES) throw unavailable();
  }
}

/**
 * @param {{ baseUrl: string, fetch?: typeof fetch, adminToken?: string|null, holder?: string, log?: (line: string) => void }} options
 */
function createGateClient({ baseUrl, fetch = (url, init) => globalThis.fetch(url, init), adminToken = null, holder = 'web', log = (line) => console.log(line) }) {
  const base = String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
  const origin = (() => { try { return new URL(base).origin; } catch { return null; } })();
  const token = typeof adminToken === 'string' && adminToken.trim() ? adminToken.trim() : null;
  let waiting = 0;
  let absentLogged = false;
  const held = new Set(); // leases not yet given back, for a shutdown
  const detachedLogged = new Set(); // addresses a lease was not attached to, said once each

  /**
   * Waits for a lease on `model`. Resolves to a lease, or to null when no gate is in front of the
   * router. Throws a GateError for a refusal (queue full or timed out, engine down, unknown model)
   * and the signal's reason when it is aborted (leaving the queue).
   * @param {string} model
   * @param {{ signal?: AbortSignal, maxWaitMs?: number, onQueued?: (q: { position: number, waitedMs: number }) => void }} [options]
   */
  async function acquire(model, { signal, maxWaitMs, onQueued } = {}) {
    signal?.throwIfAborted();
    waiting++;
    try {
      const raw = await take(model, { signal, maxWaitMs, onQueued });
      if (raw === null) return null;
      // Stopped at the moment of the grant: nobody will use the lease, so give it back at once.
      if (signal?.aborted) { await release(raw); throw signal.reason; }
      return makeLease(model, raw, { signal, maxWaitMs, onQueued });
    } finally { waiting--; }
  }

  async function take(model, { signal, maxWaitMs, onQueued }) {
    const body = { model, holder, ...(Number.isSafeInteger(maxWaitMs) && maxWaitMs > 0 ? { max_wait_ms: maxWaitMs } : {}) };
    let response;
    try {
      response = await fetch(`${base}/gate/v1/leases`, { method: 'POST', headers: { 'Content-Type': 'application/json', [CLIENT_HEADER]: holder },
        body: JSON.stringify(body), signal, redirect: 'error' });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw unavailable();
    }
    const type = String(response.headers.get('content-type') || '');
    if (!response.ok || !type.startsWith('text/event-stream')) {
      let parsed = null;
      try { parsed = JSON.parse((await readCappedText(response, MAX_EVENT_BYTES)).text); } catch { parsed = null; }
      const refusal = refusalOf(response.status, parsed);
      if (refusal) throw refusal;
      if (response.status === 404) {
        if (!absentLogged) { absentLogged = true; log('[inference-gate] no gate answers at the engine address; turns run without a lease'); }
        return null;
      }
      throw unavailable();
    }
    try {
      for await (const { event, data } of sseEvents(response.body)) {
        if (event === 'queued') {
          try { onQueued?.({ position: Number(data?.position) || 1, waitedMs: Number(data?.waited_ms) || 0 }); } catch { /* status only */ }
        } else if (event === 'granted') {
          if (typeof data?.lease !== 'string' || !LEASE_TOKEN.test(data.lease)) throw unavailable();
          return data.lease;
        } else if (event === 'error') {
          throw new GateError({ code: typeof data?.code === 'string' ? data.code : 'gate_error', status: 503, retryable: data?.retryable === true,
            message: typeof data?.message === 'string' && data.message ? data.message.slice(0, 300) : 'The inference gate refused the request.' });
        }
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof GateError) throw error;
      throw unavailable();
    } finally {
      response.body?.cancel?.().catch(() => {});
    }
    if (signal?.aborted) throw signal.reason;
    throw unavailable();
  }

  async function release(leaseToken) {
    try {
      const r = await fetch(`${base}/gate/v1/leases/${leaseToken}`, { method: 'DELETE', signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS), redirect: 'error' });
      await r.body?.cancel?.().catch(() => {});
    } catch { /* the gate ends an idle lease on its own */ }
  }

  function makeLease(model, first, retake) {
    let current = first, released = false, renewing = null;
    const lease = {
      model,
      get token() { return current; },
      headers: () => ({ [LEASE_HEADER]: current }),
      /** Gives the lease back (once). Never throws. */
      release: async () => {
        if (released) return;
        released = true;
        held.delete(lease);
        if (renewing) await renewing.catch(() => {});
        await release(current);
      },
      /**
       * A new lease after the gate forgot the one a request was sent with (`stale`): it ended while
       * the turn was idle, or the gate restarted. Callers that hit the same ended lease share one
       * renewal, and one that finds the lease already renewed gets the new token without another.
       * Every ended lease may be renewed: this is not limited to once per lease.
       */
      renew: async (stale = current) => {
        if (released) throw unavailable();
        if (current !== stale) return current;
        if (!renewing) {
          const flight = renewing = take(model, retake)
            .then((t) => { if (t) current = t; return t; })
            .finally(() => { if (renewing === flight) renewing = null; });
        }
        return renewing;
      },
      /**
       * `baseFetch` with this lease on every request to the gate (never to another host). A request
       * answered `lease_unknown` takes a new lease and is sent again once; a second refusal, or a
       * renewal the gate refuses (a GateError), goes back to the caller as it is.
       */
      fetch: (baseFetch) => async (url, init = {}) => {
        if (!sameOrigin(url)) { noteDetached(url); return baseFetch(url, init); }
        const sentWith = current;
        const send = () => baseFetch(url, { ...init, headers: withHeader(init.headers, LEASE_HEADER, current) });
        const response = await send();
        if (response.status !== 409 || response.headers?.get?.(REFUSAL_HEADER) !== 'lease_unknown' || released || !replayable(init.body)) return response;
        await response.body?.cancel?.().catch(() => {});
        log(`[inference-gate] ${JSON.stringify({ event: 'lease-renew', model })}`);
        await lease.renew(sentWith);
        return send();
      },
    };
    held.add(lease);
    return lease;
  }

  // A request that would have carried a lease went to another address than the gate's: the turn runs
  // without one. Said once per address (the origin only: no path, no query).
  function noteDetached(url) {
    let other;
    try { other = new URL(String(url)).origin; } catch { return; }
    if (detachedLogged.has(other)) return;
    detachedLogged.add(other);
    log(`[inference-gate] ${JSON.stringify({ event: 'lease-not-attached', address: other, reason: 'differs from the gate address' })}`);
  }

  function sameOrigin(url) {
    if (!origin) return false;
    try { return new URL(String(url)).origin === origin; } catch { return false; }
  }

  return {
    acquire,
    /** Gives back every lease still held (a shutdown); best effort, bounded by `timeoutMs`. Never throws. */
    releaseAll: async ({ timeoutMs = 2000 } = {}) => {
      const open = [...held];
      if (!open.length) return open.length;
      let timer;
      await Promise.race([Promise.allSettled(open.map((l) => l.release())), new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
      clearTimeout(timer);
      return open.length;
    },
    /** Leases this process is waiting for now (read-only, for "is the engine busy"). */
    waiting: () => waiting,
    /** The admin header for an unload of a model in use, or null when no admin token is set. */
    adminHeaders: () => (token ? { [ADMIN_HEADER]: token } : null),
    hasAdmin: () => token !== null,
    /** A refusal the gate answered, from a JSON response `{ status, body }`, or null. */
    refusal: (status, body) => refusalOf(status, body),
  };
}

function withHeader(headers, name, value) {
  if (headers && typeof headers.entries === 'function' && !Array.isArray(headers)) {
    const copy = new Headers(headers);
    copy.set(name, value);
    return copy;
  }
  const list = Array.isArray(headers) ? Object.fromEntries(headers) : { ...(headers || {}) };
  for (const key of Object.keys(list)) if (key.toLowerCase() === name.toLowerCase()) delete list[key];
  return { ...list, [name]: value };
}

// A body that can be sent a second time unchanged.
const replayable = (body) => body === undefined || body === null || typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof URLSearchParams;

// The boot warning when the gate's admin token is not set (the key name only, never a value).
const adminTokenWarning = () => '[inference-gate] INFERENCE_GATE_ADMIN_TOKEN is not set: the memory watchdog cannot unload a model that is answering a request, and "unload anyway" on the Models page is unavailable. Set it to the admin token of the gate.';

module.exports = { adminTokenWarning, createGateClient, GateError, LEASE_HEADER, ADMIN_HEADER, REFUSAL_HEADER, sseEvents };
