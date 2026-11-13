'use strict';
// Port contract row H: the latch of the Rust front's inference admission lease authority (noevia-rs
// crates/engine-admission authority.rs). The front issues every lease, owns its renewal, hard cap and expiry, orders
// this process's starts and decides when a lease no longer covers its holder. What a lease holds here are this
// process's own counts, which its synchronous chat and workers read: the maintenance gate's inference count, the
// inference budget (#697) and the gate's one-model queue, a machine's turn (#1849, #1880), the Diary exchange's
// throttle and the backfill's pause. This module takes them for a ticket the front issued and holds them until the
// front gives the ticket back; it never issues a lease of its own. Partial port: the admission decisions themselves
// (maintenance permit, budget/quarantine, machine assignment and readiness, the Diary throttle) are still made here
// (createAdmission) and trusted by the front, until their owners (maintenance lease, model budget, machines, chat)
// move them.
//
//   PUT    /internal/inference-admission/lease/<id>        {model} | {role, machine, model} | {diaryExchange: {user}}
//          201 {lease: <id>, ttlMs, headers?}; 400/409/429/503 {error, code?}; 410 when the epoch or incarnation
//          is not this process's current session; 404 when <id> was already given back (its answer was lost)
//   POST   /internal/inference-admission/lease/<id>/renew  200 {ttlMs}; 404 when it has ended; 410 as above
//   DELETE /internal/inference-admission/lease/<id>        204, also when it has ended or is still being taken
//
// Every PUT and renewal carries x-noevia-admission-epoch and x-noevia-admission-incarnation: the front's process
// start and the incarnation it issued this process start (session below, POST /v1/inference-admission/session on
// the front's private store listener). Without a session nothing is latched (503, fail closed); a newer front epoch
// or a retirement ends every latch at once, so a restarted front never inherits an earlier front's holds and a
// retired start holds nothing. A latch not renewed within ttlMs still ends by itself (a front that dies frees chat
// and tune). Only the front may ask (the same check as its other loopback calls), and a caller that goes away
// while waiting holds nothing. Engine: maintenance enter, then the gate's lease when a gate is configured (which
// includes the budget check), else the budget check alone. Machine: the machine's health and served model are
// checked, and it counts a turn while the latch lasts. Diary exchange (the front's /api/diary/local-exchange): the
// maintenance gate waited for briefly (chat-admission.cjs), then the model throttle chat shares (429, counted once
// per exchange), and the long-document backfill's pause (rag.cjs foreground).
const crypto = require('node:crypto');
const { trustedFront } = require('./trusted-front.cjs');
const { enterChatInference } = require('./chat-admission.cjs');
const { readCappedJson } = require('./http.cjs');

const PREFIX = '/internal/inference-admission/lease';
const SESSION_PATH = '/v1/inference-admission/session';
const SESSION_EVERY_MS = 10000;
const CALL_TIMEOUT_MS = 5000;
/** The release marker the release assembly pairs with the front's `noevia-inference-admission-authority/1`. */
const LATCH_MARKER = 'noevia-inference-admission-latch/1';
const TTL_MS = 30000;
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

function createAdmission({ modelManager, admitEngineModel, chatMachines = null, diaryExchange = null }) {
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

/** This process start's session with the front's authority: {current() → {epoch, incarnation} | null, retired(),
 *  onChange(fn), start(), stop()}. Re-registered every `everyMs`: the same start keeps its incarnation; a front that
 *  restarted answers a new epoch (every latch of the old one ends); a 410 retires this start for good. */
function createAuthoritySession({ port, token, fetchImpl = globalThis.fetch, boot = crypto.randomBytes(16).toString('hex'), startedAt = Date.now(), everyMs = SESSION_EVERY_MS, timeoutMs = CALL_TIMEOUT_MS, log = (m) => console.warn(m) }) {
  const ok = Number.isInteger(port) && port > 0 && port < 65536 && String(token || '').length > 0;
  let current = null, retired = false, timer = null;
  const listeners = [];
  const set = (next) => {
    const changed = (current?.epoch !== next?.epoch) || (current?.incarnation !== next?.incarnation);
    current = next;
    if (changed) for (const fn of listeners) fn(next);
  };
  async function register() {
    if (!ok || retired) return current;
    let res;
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}${SESSION_PATH}`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', 'x-noevia-store-token': token },
        body: JSON.stringify({ boot, startedAt }),
      });
    } catch { return current; /* the latches already held end by their own TTL if the front is gone */ }
    let body = null;
    try { body = await readCappedJson(res, 4096); } catch { /* unreadable or oversize: no change */ }
    if (res.status === 410) {
      retired = true;
      log('[models] a newer start of this server registered with the inference admission authority; this one admits nothing');
      set(null);
    } else if (res.status === 200 && Number.isSafeInteger(body?.incarnation) && typeof body?.epoch === 'string' && /^[0-9a-f]{32}$/.test(body.epoch)) {
      set({ epoch: body.epoch, incarnation: body.incarnation });
    }
    return current;
  }
  return {
    current: () => (retired ? null : current),
    retired: () => retired,
    onChange: (fn) => { listeners.push(fn); },
    register,
    start() { void register(); timer = setInterval(() => { void register(); }, everyMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}

/** The latches, keyed by the front's ticket. */
function createLatches({ ttlMs = TTL_MS, log = (m) => console.warn(m) } = {}) {
  const latches = new Map();
  // Tickets given back before (or while) their latch was taken: a late grant for one is released at once.
  const given = new Set();
  function end(id, why) {
    const latch = latches.get(id);
    if (!latch) return false;
    latches.delete(id);
    clearTimeout(latch.timer);
    latch.release();
    if (why) log(`[models] the front's inference lease ${why}; it no longer holds the engine`);
    return true;
  }
  function arm(id) {
    const latch = latches.get(id);
    if (!latch) return;
    clearTimeout(latch.timer);
    latch.timer = setTimeout(() => end(id, 'was not renewed'), ttlMs);
    latch.timer.unref?.();
  }
  return {
    add(id, held, epoch) {
      latches.set(id, { release: held.release, timer: null, epoch });
      arm(id);
    },
    has: (id) => latches.has(id),
    renew(id) {
      if (!latches.has(id)) return false;
      arm(id);
      return true;
    },
    giveBack(id) {
      given.add(id);
      if (given.size > 4096) given.delete(given.values().next().value);
      return end(id, null);
    },
    given: (id) => given.has(id),
    /** Ends every latch not of `epoch` (all of them for null). */
    endOthers(epoch, why) { for (const [id, l] of [...latches]) if (!epoch || l.epoch !== epoch) end(id, why); },
    size: () => latches.size,
    ttlMs,
  };
}

/** The route, answered before authentication and the request gate. True when it was this route's. */
function createAdmissionRoutes({ secret, modelManager, admitEngineModel, chatMachines, diaryExchange = null, authority, json, readJson, ...options }) {
  const latches = createLatches(options);
  const admit = createAdmission({ modelManager, admitEngineModel, chatMachines, diaryExchange });
  // A new front epoch or a retirement: what an earlier front (or this retired start) latched ends now.
  authority?.onChange?.((next) => latches.endOthers(next?.epoch || null, next ? 'belonged to an earlier front' : 'belonged to a retired start'));
  /** Null when the call is for the current session; else the refusal to send. */
  function fenced(req) {
    const now = authority?.current?.() || null;
    if (!now) return 503;
    const epoch = req.headers['x-noevia-admission-epoch'];
    const incarnation = req.headers['x-noevia-admission-incarnation'];
    return epoch === now.epoch && incarnation === String(now.incarnation) ? null : 410;
  }
  async function handle(req, res) {
    const target = String(req.url || '').split('?')[0];
    if (target !== PREFIX && !target.startsWith(`${PREFIX}/`)) return false;
    const notFound = () => { json(res, 404, { error: 'Not found' }); return true; };
    if (!trustedFront(req, secret)) return notFound();
    const match = /^\/([0-9a-f]{32})(\/renew)?$/.exec(target.slice(PREFIX.length));
    if (!match) return notFound();
    const id = match[1];
    if (req.method === 'PUT' && !match[2]) {
      const signal = callerGone(req, res);
      const refusedBy = fenced(req);
      if (refusedBy) { json(res, refusedBy, { error: BUSY }); return true; }
      if (latches.given(id) || latches.has(id)) { json(res, latches.has(id) ? 409 : 404, { error: BUSY }); return true; }
      const epoch = authority.current().epoch;
      let held = null;
      try {
        const ask = await readJson(req);
        held = await admit(ask, signal);
        // A wait the caller gave up on, a ticket given back meanwhile, or a session that changed: hold nothing.
        if (signal.aborted || latches.given(id) || authority.current()?.epoch !== epoch) {
          held.release();
          if (signal.aborted) return true;
          json(res, 503, { error: BUSY });
          return true;
        }
        latches.add(id, held, epoch);
        json(res, 201, { lease: id, ttlMs: latches.ttlMs, ...(held.headers ? { headers: held.headers } : {}) });
      } catch (e) {
        if (signal.aborted) { res.destroy?.(); return true; }
        const status = KEPT.includes(e?.status) ? e.status : 503;
        json(res, status, { error: e?.publicMessage || BUSY, ...(e?.code ? { code: e.code } : {}) });
      }
      return true;
    }
    if (req.method === 'POST' && match[2]) {
      const refusedBy = fenced(req);
      if (refusedBy) { json(res, refusedBy === 503 ? 410 : refusedBy, { error: BUSY }); return true; }
      if (!latches.renew(id)) return notFound();
      json(res, 200, { ttlMs: latches.ttlMs });
      return true;
    }
    if (req.method === 'DELETE' && !match[2]) {
      latches.giveBack(id);
      res.statusCode = 204;
      res.end();
      return true;
    }
    return notFound();
  }
  return { handle, latches };
}

module.exports = { createAdmissionRoutes, createAdmission, createLatches, createAuthoritySession, callerGone, PREFIX, SESSION_PATH, TTL_MS, MAX_WAIT_MS, THROTTLED, LATCH_MARKER };
