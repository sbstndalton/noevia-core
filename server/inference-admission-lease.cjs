'use strict';
// sbstndalton/noevia#2218: the Rust front's model steps enter this process's own admission (noevia-rs crates/engine-admission):
// while chat, tuning and the engine manager live here, this process is the one arbiter of the one-model rule, the
// inference budget (#697) and the maintenance gate. A lease IS a hold of what a local request holds here.
//
//   POST   /internal/inference-admission/lease             {model} | {role, machine, model} | {gate} | {diaryExchange: {user}}
//          201 {lease, ttlMs, headers?}; 409/503 {error, code?}
//   POST   /internal/inference-admission/lease/<id>/renew  200 {ttlMs}; 404 when it has ended
//   DELETE /internal/inference-admission/lease/<id>        204, also when it has already ended
//
// Engine: maintenance enter, then the gate's lease when a gate is configured (which includes the budget check), else
// the budget check alone. Machine: nothing is admitted here; the machine's health and served model are checked, and it
// counts a turn while the lease lasts (#1849, #1880). Gate (chat port S8, rust-chat-admission.cjs): the inference gate
// as POST /api/chat ({gate:'chat'}) meets it, waiting at most CHAT_GATE_WAIT_MS; the call the front then sends with the
// lease is covered by it and enters nothing again. Diary exchange (the front's /api/diary/local-exchange): the
// maintenance gate waited for briefly (chat-admission.cjs, a 503 in the gate's words) and the long-document backfill's
// pause (rag.cjs foreground), held until the lease ends; the model throttle chat shares is the front's (chat port S6), so
// `diaryExchange.rateLimited` answers false in index.cjs. A lease not renewed within ttlMs ends by itself, so a front that
// dies frees chat and tune. Only the front may ask (the same check as its other loopback calls), and a caller that
// goes away while waiting holds nothing.
const crypto = require('node:crypto');
const { trustedFront } = require('./trusted-front.cjs');
const chatAdmission = require('./chat-admission.cjs');
const { enterChatInference } = chatAdmission;
const frontAdmission = require('./rust-chat-admission.cjs');

const PREFIX = '/internal/inference-admission/lease';
const TTL_MS = 30000;
const HARD_MS = 6 * 60 * 60 * 1000;
// #2495: how long an ended covering lease waits for its call to settle before it gives the count back anyway.
const SETTLE_MS = 5000;
const MAX_WAIT_MS = 120000;
const BUSY = 'The model is busy. Try again shortly.';
const THROTTLED = 'Please wait before sending another message';
/** The statuses a refusal keeps; anything else is the 503 BUSY. */
const KEPT = [400, 409, 429, 503];

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

function createAdmission({ modelManager, admitEngineModel, chatMachines = null, gateWaitMs = chatAdmission.CHAT_GATE_WAIT_MS, diaryExchange = null }) {
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
  /** Chat port S8: the inference gate alone, as a chat turn (or the Diary local exchange) meets it: <= 3 s, the gate's words. */
  async function holdGate(route, signal) {
    let leave;
    try { leave = await chatAdmission.enterChatInference(modelManager, { waitMs: Math.min(gateWaitMs, chatAdmission.CHAT_GATE_WAIT_MS), signal }); }
    catch (e) { throw Object.assign(e, { status: e.status || 503, publicMessage: e.message }); }
    const release = typeof leave === 'function' ? leave : () => {};
    // The front went away as the gate let it in (review P2-2): give the count back before refusing.
    if (signal?.aborted) { release(); signal.throwIfAborted(); }
    return { headers: null, gate: route, release };
  }
  async function holdExchange(user, signal) {
    let leave;
    try { leave = (await enterChatInference(modelManager, { signal })) || (() => {}); }
    catch (e) { throw Object.assign(e, { status: e.status || 503, publicMessage: e.publicMessage || e.message || BUSY }); }
    let throttled = true;
    // Chat port S6: the front counts the shared `llm:` budget; a Core without a limiter passes none.
    try { throttled = typeof diaryExchange.rateLimited === 'function' ? diaryExchange.rateLimited(user) : false; }
    finally { if (throttled) leave(); }
    if (throttled) throw refusal(429, THROTTLED);
    let resume = () => {};
    try { resume = diaryExchange.foreground?.() || resume; } catch { /* the pause is advisory, the gate is not */ }
    return { headers: null, release() { try { resume(); } finally { leave(); } } };
  }
  return (ask, signal) => {
    const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 1024;
    if (ask && ask.gate !== undefined) {
      if (!frontAdmission.GATE_ROUTES.includes(ask.gate) || Object.keys(ask).length !== 1) throw refusal(400, 'Unknown gate.');
      return holdGate(ask.gate, signal);
    }
    if (ask && typeof ask === 'object' && 'diaryExchange' in ask) {
      if (!diaryExchange || typeof diaryExchange !== 'object') throw refusal(400, 'Diary exchanges are not admitted here.');
      if ('model' in ask || 'role' in ask || 'machine' in ask || !text(ask.diaryExchange?.user)) throw refusal(400, 'A user is required.');
      return holdExchange(ask.diaryExchange.user, signal);
    }
    if (!text(ask?.model)) throw refusal(400, 'A model is required.');
    if (ask.embedding !== undefined) {
      if (ask.embedding !== true || Object.keys(ask).some(k => !['embedding', 'model'].includes(k))) throw refusal(400, 'Invalid embedding lease.');
      signal?.throwIfAborted();
      const leave = modelManager.enterInference?.() || (() => {});
      let released = false;
      return Promise.resolve({ headers: null, release() { if (!released) { released = true; leave(); } } });
    }
    if (ask.role === undefined && ask.machine === undefined) return holdEngine(ask.model, signal);
    if (ask.role !== 'smart' || !text(ask.machine)) throw refusal(400, 'Only the Smart role runs research.');
    return holdMachine(ask);
  };
}

function createLeases({ ttlMs = TTL_MS, hardMs = HARD_MS, settleMs = SETTLE_MS, log = (m) => console.warn(m), now = () => Date.now() } = {}) {
  const leases = new Map();
  function end(id, why) {
    const lease = leases.get(id);
    if (!lease) return false;
    leases.delete(id);
    clearTimeout(lease.timer);
    // Exclusion-settle rule: a lease covering a call that is still running (the front gave up, timed out or stopped
    // renewing) keeps its gate count until that call has settled; the covered call's settle() releases it.
    if (lease.covering && !lease.settled) {
      lease.ended = true;
      // #2495: bounded, failing closed: a call that never settles (an await ignoring the abort) must not hold the
      // gate count for ever. Node's own path gives its count back when the response closes; this is that bound.
      const bound = setTimeout(() => {
        if (lease.settled) return;
        lease.settled = true;
        log('[models] a covered call did not settle after its front lease ended; its gate count is given back');
        lease.release();
      }, settleMs);
      bound.unref?.();
      lease.settleTimer = bound;
    } else lease.release();
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
      leases.set(id, { release: held.release, gate: held.gate || null, covering: false, settled: false, ended: false, timer: null, hardAt: now() + hardMs });
      arm(id);
      return id;
    },
    /**
     * Chat port S8: whether live gate lease `id` covers one call on `route`; each lease covers one call only. Covered,
     * the answer is that call's settle(): called once the call has settled, it lets an ended lease give its count back.
     */
    cover(id, route) {
      const lease = typeof id === 'string' ? leases.get(id) : undefined;
      if (!lease || !lease.gate || lease.gate !== route || lease.covering || lease.hardAt <= now()) return false;
      lease.covering = true;
      return () => {
        if (lease.settled) return;
        lease.settled = true;
        clearTimeout(lease.settleTimer);
        if (lease.ended) lease.release();
      };
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
function createAdmissionRoutes({ secret, modelManager, admitEngineModel, chatMachines, json, readJson, gateWaitMs, diaryExchange = null, ...options }) {
  const leases = createLeases(options);
  const admit = createAdmission({ modelManager, admitEngineModel, chatMachines, diaryExchange, ...(gateWaitMs === undefined ? {} : { gateWaitMs }) });
  async function handle(req, res) {
    const target = String(req.url || '').split('?')[0];
    if (target !== PREFIX && !target.startsWith(`${PREFIX}/`)) return false;
    const notFound = () => { json(res, 404, { error: 'Not found' }); return true; };
    if (!trustedFront(req, secret)) return notFound();
    if (target === PREFIX) {
      if (req.method !== 'POST') return notFound();
      const signal = callerGone(req, res);
      let held = null;
      let chatGate = false;
      try {
        const ask = await readJson(req);
        chatGate = ask?.gate === 'chat';
        held = await admit(ask, signal);
        // A wait the caller gave up on must not leave the model held for the lease's whole life.
        if (signal.aborted) { held.release(); return true; }
        const id = leases.add(held);
        json(res, 201, { lease: id, ttlMs: leases.ttlMs, ...(held.headers ? { headers: held.headers } : {}) });
      } catch (e) {
        if (signal.aborted) { res.destroy?.(); return true; }
        const status = KEPT.includes(e?.status) ? e.status : 503;
        // Bounded metadata survives a front declining to buffer an oversized refusal body.
        if (status === 503 || status === 409) {
          if (typeof e?.code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(e.code)) res.setHeader('X-Noevia-Admission-Code', e.code);
          if (status === 503 && chatGate) res.setHeader('Retry-After', '3');
        }
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
  /**
   * Chat port S8: whether `req` is covered by the front's live gate lease for `route` ('chat' or 'diary'), in which case
   * it must not enter the gate again (one gate count per call, chat.cjs engineBusy). The header is always removed.
   * Covered, the answer is the call's settle() (createLeases cover), which the caller runs once the call has ended.
   */
  function covers(req, route) {
    const id = req?.headers?.[frontAdmission.LEASE_HEADER];
    if (req?.headers) delete req.headers[frontAdmission.LEASE_HEADER];
    return (Boolean(route) && leases.cover(id, route)) || false;
  }
  return { handle, leases, covers };
}

module.exports = { createAdmissionRoutes, createAdmission, createLeases, callerGone, PREFIX, TTL_MS, MAX_WAIT_MS, THROTTLED };
