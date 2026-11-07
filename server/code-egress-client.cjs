'use strict';
// Row V: Node is a fail-closed CLIENT of the native egress issuer. The Rust front (noevia-rs
// crates/egress-issuer, bins/noevia-server src/code_egress.rs) generates, persists, publishes and
// rotates the proxy's control key, keeps the authenticated session with the proxy and signs every task
// grant and revoke. Node holds no key material: it asks the front, over the internal store listener
// (127.0.0.1:NOEVIA_PROJECT_STORE_PORT, header x-noevia-store-token), for a grant and hands the token to
// the task. Anything that goes wrong (front unreachable, refusing, answering oddly, a handle from an
// earlier front incarnation) refuses: no grant is invented, none is re-acquired, and a cleanup that
// cannot be confirmed says so (`confirmed: false`).
const { readCappedText } = require('./http.cjs');
const CAPABILITY = 'noevia-code-egress-control/1';
// Keep the quoted literal: noevia deploy/tools/assemble-release.sh pairs this core with a front that
// carries "noevia-code-egress-issuer/1" (and refuses the reverse pairings).
const CODE_EGRESS_CLIENT_MARKER = 'noevia-code-egress-client/1';
const STATUS_EVERY_MS = 2000, STATUS_FRESH_MS = 6000, GRANT_WAIT_MS = 30000, CLEANUP_WAIT_MS = 15000, REPLY_CAP = 256 * 1024;

class EgressUnavailableError extends Error {
  constructor(reason = 'unavailable') { super('native egress is unavailable'); this.name = 'EgressControlError'; this.code = 'EGRESS_UNAVAILABLE'; this.status = 503; this.reason = reason; }
}
const unavailableReport = () => Object.freeze({ confirmed: false, report: Object.freeze({ available: false, state: 'uncertain', final: false, partial: true }) });

function createEgressClient({ port, token, endpoint, fetchImpl = globalThis.fetch, now = Date.now, log = () => {}, statusEveryMs = STATUS_EVERY_MS, statusFreshMs = STATUS_FRESH_MS } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || token.length < 32) throw new EgressUnavailableError('store');
  const note = (entry) => { try { log(entry); } catch { /* diagnostics cannot change authority */ } };
  const handles = new WeakMap(), active = new Set();
  let ok = false, okAt = -Infinity, timer = null, closed = false, polling = null, reported = null;
  async function post(op, body, waitMs) {
    let res;
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}/v1/egress/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-noevia-store-token': token }, body: JSON.stringify(body), signal: AbortSignal.timeout(waitMs) });
    } catch { throw new EgressUnavailableError('transport'); }
    let text;
    try {
      const reply = await readCappedText(res, REPLY_CAP);
      if (reply.capped) throw new EgressUnavailableError('response');
      text = reply.text;
    } catch { throw new EgressUnavailableError('response'); }
    let value = null; try { value = text ? JSON.parse(text) : null; } catch { /* answered below */ }
    return { status: res.status, value };
  }
  const refusal = (reply) => new EgressUnavailableError(reply.value && typeof reply.value.reason === 'string' ? reply.value.reason : 'refused');
  async function poll() {
    if (polling) return polling;
    polling = (async () => {
      try {
        const reply = await post('status', {}, 5000);
        const up = reply.status === 200 && reply.value && reply.value.configured === true && reply.value.available === true;
        ok = up; if (up) okAt = now();
        if (up && reported !== 'up') { reported = 'up'; note({ event: 'egress.client_ready' }); }
        if (!up && reported !== 'down') { reported = 'down'; note({ event: 'egress.client_unavailable', reason: reply.status === 200 ? 'not-ready' : `status-${reply.status}` }); }
      } catch {
        ok = false;
        if (reported !== 'down') { reported = 'down'; note({ event: 'egress.client_unavailable', reason: 'transport' }); }
      } finally { polling = null; }
    })();
    return polling;
  }
  /** Poll the front; an outage is logged, retried and refused per grant, never fatal to the web. */
  function start() {
    if (timer || closed) return;
    poll();
    timer = setInterval(poll, statusEveryMs); timer.unref?.();
  }
  /** The front's own word, recent: a stale or failed answer is "not available" (fail closed). */
  function available() { return !closed && ok && now() - okAt < statusFreshMs; }
  function recordFor(handle) { const r = handle && typeof handle === 'object' && handles.get(handle); if (!r) throw new EgressUnavailableError('handle'); return r; }

  async function grant({ taskId, domains = [] } = {}) {
    if (closed) throw new EgressUnavailableError('closed');
    if (typeof taskId !== 'string' || !Array.isArray(domains) || domains.some((d) => typeof d !== 'string')) throw new EgressUnavailableError('task');
    let reply;
    try { reply = await post('grant', { taskId, domains }, GRANT_WAIT_MS); } catch (e) { ok = false; throw e; }
    const v = reply.value;
    if (reply.status !== 200 || !v || typeof v.handle !== 'string' || typeof v.token !== 'string' || !Array.isArray(v.domains) || v.taskId !== taskId) throw refusal(reply);
    const handle = { taskId, domains: Object.freeze([...v.domains]) };
    Object.defineProperty(handle, 'token', { value: v.token }); Object.freeze(handle);
    const record = { id: v.handle, cleanup: null, forget: null };
    handles.set(handle, record); active.add(record);
    return handle;
  }
  async function activity(handle, budgetMs = 10000) {
    const r = recordFor(handle);
    const reply = await post('activity', { handle: r.id, budgetMs }, CLEANUP_WAIT_MS);
    if (reply.status !== 200 || !reply.value || !reply.value.report) throw refusal(reply);
    return Object.freeze(reply.value.report);
  }
  function revoke(handle, budgetMs = 10000) {
    const r = recordFor(handle); if (r.cleanup) return r.cleanup;
    r.cleanup = (async () => {
      try {
        const reply = await post('revoke', { handle: r.id, budgetMs }, Math.max(1000, Math.min(budgetMs, 10000)) + 5000);
        const v = reply.value;
        if (reply.status !== 200 || !v || v.confirmed !== true || !v.report || v.report.final !== true) return unavailableReport();
        return Object.freeze({ confirmed: true, report: Object.freeze(v.report) });
      } catch { return unavailableReport(); }
      // One-shot flight: once it has settled (confirmed or not) Node drops its strong reference. A handle
      // still held keeps its answer through the WeakMap (confirmed:false stays confirmed:false, no second
      // request, nothing re-acquired); an abandoned one is collectable instead of growing `active` across
      // recoveries.
      finally { active.delete(r); }
    })();
    return r.cleanup;
  }
  function forget(handle, snapshotId) {
    const r = recordFor(handle); if (r.forget) return r.forget;
    r.forget = (async () => {
      try {
        const reply = await post('forget', { handle: r.id, snapshotId }, CLEANUP_WAIT_MS);
        if (reply.status === 503 && reply.value && reply.value.reason === 'snapshot') { r.forget = null; throw new EgressUnavailableError('snapshot'); }
        return Object.freeze({ confirmed: reply.status === 200 && !!reply.value && reply.value.confirmed === true });
      } catch (e) { if (e instanceof EgressUnavailableError && e.reason === 'snapshot') throw e; return Object.freeze({ confirmed: false }); }
    })();
    return r.forget;
  }
  async function close() {
    closed = true; clearInterval(timer); timer = null;
    const pending = [...active]; const results = [];
    for (const r of pending) {
      const handle = { }; handles.set(handle, r); results.push(await revoke(handle, 5000));
    }
    return results;
  }
  // Diagnostics only: how many grants Node still holds a strong reference to (held or cleanup in flight).
  const retained = () => active.size;
  return Object.freeze({ impl: 'rust-controlled', retained, capability: CAPABILITY, endpoint, start, available, ready: () => poll().then(() => ({ capability: CAPABILITY, available: available() })), grant, activity, revoke, forget, close, sweep: () => 0 });
}

module.exports = { CAPABILITY, CODE_EGRESS_CLIENT_MARKER, EgressUnavailableError, createEgressClient };
