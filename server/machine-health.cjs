'use strict';
// #1638: is each assigned service answering? One GET of its health endpoint, bounded and cached, so
// opening (or refreshing) Settings → Inference machines never turns into a probe storm:
//   - one probe per address at a time (later callers share the one in flight);
//   - a result is reused for `ttlMs` (default 30 s), a failure as well;
//   - each probe has a short deadline and reads no body (it is cancelled at once);
//   - the cache holds at most `maxEntries` addresses (oldest dropped first);
//   - only on request (GET /api/models/machines?health=1), never on a timer.
// Every probe goes through the on-this-network fetch (service-endpoint.cjs): a name that now
// resolves to a public address is refused at connect time and reads "unreachable".
// States: 'up' (2xx), 'down' (it answered, not 2xx; `reason` http-NNN), 'unreachable' (no answer).

const { serviceFetch, decisionServiceFetch } = require('./service-endpoint.cjs');

/** The health URL of a service base URL: /health at its origin (llama-server, TEI and the decision service all answer it). */
function healthUrl(base) {
  try {
    const u = new URL(String(base || '').trim());
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return `${u.protocol}//${u.host}/health`;
  } catch { return null; }
}

function createMachineHealth({ fetchImpl = serviceFetch, decisionFetchImpl = decisionServiceFetch, ttlMs = 30000, timeoutMs = 2500, maxEntries = 32, now = Date.now } = {}) {
  const cache = new Map(); // url -> { at, result } | { pending }

  async function probeOnce(url, fetcher) {
    try {
      const r = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      try { await r.body?.cancel?.(); } catch { /* nothing to read */ }
      return r.ok ? { state: 'up' } : { state: 'down', reason: `http-${Number(r.status) || 0}` };
    } catch (err) {
      return { state: 'unreachable', reason: err?.code === 'EPUBLICADDR' ? 'not-on-this-network' : err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network' };
    }
  }

  function probe(base, { decision = false } = {}) {
    const url = healthUrl(base);
    if (!url) return Promise.resolve({ state: 'unknown' });
    const hit = cache.get(url);
    if (hit?.pending) return hit.pending;
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.result);
    const pending = probeOnce(url, decision ? decisionFetchImpl : fetchImpl).then((result) => {
      const out = { ...result, checkedAt: new Date(now()).toISOString() };
      cache.delete(url);
      cache.set(url, { at: now(), result: out });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return out;
    });
    cache.set(url, { pending });
    return pending;
  }

  /**
   * #1851: extra facts about a service (the models it serves, its context) kept beside its health result: the same
   * cache, TTL, one-in-flight rule and size cap. `load(previous)` resolves the new value and must not throw; it gets
   * the last known value so a failed read can keep it instead of losing it. Resolves the value (undefined: never known).
   */
  function remember(key, load) {
    const hit = cache.get(key);
    if (hit?.pending) return hit.pending;
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value);
    const last = hit?.value;
    const pending = Promise.resolve().then(() => load(last)).catch(() => last).then((value) => {
      cache.delete(key);
      cache.set(key, { at: now(), value });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return value;
    });
    cache.set(key, { pending, value: last });
    return pending;
  }

  /**
   * @param {{service:string, url:string|null, decision?:boolean}[]} targets
   * @returns {Promise<Record<string, {state:string, reason?:string, checkedAt?:string}>>}
   */
  async function check(targets) {
    const out = {};
    await Promise.all(targets.map(async (t) => {
      out[t.service] = t.url ? await probe(t.url, { decision: !!t.decision }) : { state: 'unknown' };
    }));
    return out;
  }

  return { check, probe, remember, clear: () => cache.clear() };
}

/** A machine's state from its services' states: the worst one ('idle' when nothing on it is probed). */
function machineState(states) {
  const list = states.filter((s) => s && s.state !== 'unknown');
  if (!list.length) return 'idle';
  if (list.some((s) => s.state === 'unreachable')) return 'unreachable';
  if (list.some((s) => s.state === 'down')) return 'down';
  return 'up';
}

module.exports = { createMachineHealth, machineState, healthUrl };
