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
// States: 'up' (2xx; also 401/403 when no key applies: reason 'needs-auth', the service is there and wants a login),
// 'down' (it answered, not 2xx; `reason` http-NNN; also a 401/403 to a key we sent), 'unreachable' (no answer; `reason`
// refused / timeout / not-found / not-on-this-network / network).
// #1856: a target may carry `headers` (the key the real client sends to that same host, nothing else) and a `path`.

const { serviceFetch, decisionServiceFetch } = require('./service-endpoint.cjs');

/** The health URL of a service base URL: /health at its origin (llama-server, TEI and the decision service all answer it). */
function healthUrl(base, path = '/health') {
  try {
    const u = new URL(String(base || '').trim());
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return `${u.protocol}//${u.host}${path}`;
  } catch { return null; }
}

function createMachineHealth({ fetchImpl = serviceFetch, decisionFetchImpl = decisionServiceFetch, ttlMs = 30000, timeoutMs = 2500, maxEntries = 32, now = Date.now } = {}) {
  const cache = new Map(); // url -> { at, result } | { pending }

  async function probeOnce(url, fetcher, headers, fallbackUrl = null) {
    const first = await probeUrl(url, fetcher, headers);
    // #1861: an OpenAI-style server (Kev) has no /health; a 404 there says "no such path", not "down". Ask the path its client uses.
    if (fallbackUrl && first.state === 'down' && first.reason === 'http-404') return probeUrl(fallbackUrl, fetcher, headers);
    return first;
  }

  async function probeUrl(url, fetcher, headers) {
    const sent = !!(headers && Object.keys(headers).length);
    try {
      const r = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), ...(sent ? { headers } : {}) });
      try { await r.body?.cancel?.(); } catch { /* nothing to read */ }
      const status = Number(r.status) || 0;
      if (r.ok) return { state: 'up' };
      // It answered and wants a login: it is there. Only a key we sent and it refused is a fault.
      if ((status === 401 || status === 403) && !sent) return { state: 'up', reason: 'needs-auth' };
      return { state: 'down', reason: `http-${status}` };
    } catch (err) {
      const code = err?.code || err?.cause?.code;
      const reason = code === 'EPUBLICADDR' ? 'not-on-this-network'
        : code === 'ECONNREFUSED' ? 'refused'
          : err?.name === 'TimeoutError' || err?.name === 'AbortError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' ? 'timeout'
            : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'not-found' : 'network';
      return { state: 'unreachable', reason };
    }
  }

  function probe(base, { decision = false, headers = null, path = '/health', fallbackPath = null } = {}) {
    const url = healthUrl(base, path);
    const fallbackUrl = fallbackPath ? healthUrl(base, fallbackPath) : null;
    if (!url) return Promise.resolve({ state: 'unknown' });
    const hit = cache.get(url);
    if (hit?.pending) return hit.pending;
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.result);
    const pending = probeOnce(url, decision ? decisionFetchImpl : fetchImpl, headers, fallbackUrl).then((result) => {
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
   * @param {{service:string, url:string|null, decision?:boolean, headers?:object, path?:string}[]} targets
   * @returns {Promise<Record<string, {state:string, reason?:string, checkedAt?:string}>>}
   */
  async function check(targets) {
    const out = {};
    await Promise.all(targets.map(async (t) => {
      out[t.service] = t.url ? await probe(t.url, { decision: !!t.decision, headers: t.headers || null, path: t.path || '/health', fallbackPath: t.fallbackPath || null }) : { state: 'unknown' };
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

/** #1861: the service behind machineReason (same pick), so a degraded machine can name it. */
function machineFailing(entries) {
  const list = entries.filter((e) => e && e.result && e.result.state !== 'unknown');
  return (list.find((e) => e.result.state === 'unreachable') || list.find((e) => e.result.state === 'down'))?.service || '';
}

/** #1856: the reason of the worst probed service on a machine (unreachable, then down), or '' when it is healthy. */
function machineReason(states) {
  const list = states.filter((s) => s && s.state !== 'unknown');
  const worst = list.find((s) => s.state === 'unreachable') || list.find((s) => s.state === 'down');
  return worst?.reason || '';
}

module.exports = { createMachineHealth, machineState, machineReason, machineFailing, healthUrl };
