'use strict';
// ── Refuse requests that arrive over the internal code network (#853) ──────
//
// `deploy/examples/code-sandbox.override.yml` puts web on the internal `code` network so the
// sandbox can reach the egress proxy (code-egress.cjs) — and only that. But web's UI listener and
// its file-sharing (DAV) listener bind every interface, so they were reachable from the sandbox
// too: an approved `curl` could reach the sign-in and DAV surfaces directly, bypassing the tunnel
// in front of one and the Tailscale-only relay in front of the other.
//
// The listeners keep their binds; instead, a request whose connection arrived on web's OWN
// address on the code network (`req.socket.localAddress`) is answered 403 with no body. That
// address is named by `COWORK_CODE_NET_ADDR`: IP literals and/or host names, comma separated.
// The override sets it to `egress` — web's alias on the code network, the same name the egress
// proxy resolves to bind there — so the address follows Docker's assignment. Unset: no check.
//
// The egress proxy is a different listener on its own port and never goes through this guard.
const dns = require('node:dns'), net = require('node:net');

const RESOLVE_TIMEOUT_MS = 5000;
const RETRY_MS = 5000;
const MAX_RETRY_MS = 5 * 60_000;
const LOG_EVERY_MS = 60_000;

/** One address as `localAddress` reports it: lower case, an IPv4-mapped IPv6 address as IPv4. */
function normalizeAddress(address) {
  const text = String(address || '').trim().toLowerCase();
  const mapped = text.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return mapped ? mapped[1] : text;
}

/** `COWORK_CODE_NET_ADDR` → IP literals and host names. A malformed entry is a startup error. */
function parseCodeNetSpec(raw) {
  const literals = new Set(), hosts = [];
  for (const entry of String(raw || '').split(/[\s,]+/).filter(Boolean)) {
    if (net.isIP(entry)) literals.add(normalizeAddress(entry));
    else if (/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(entry)) hosts.push(entry.toLowerCase());
    else throw Error(`COWORK_CODE_NET_ADDR should list IP addresses or host names, not "${entry}"`);
  }
  return { literals, hosts };
}

async function defaultLookup(host) {
  return dns.promises.lookup(host, { all: true, verbatim: true });
}

/**
 * @param {{spec?: string, lookup?: (host: string) => Promise<Array<{address: string}|string>>,
 *          log?: (entry: object) => void, resolveTimeoutMs?: number, retryMs?: number,
 *          now?: () => number}} options
 */
function createCodeNetGuard({ spec = '', lookup = defaultLookup, log = () => {}, resolveTimeoutMs = RESOLVE_TIMEOUT_MS,
  retryMs = RETRY_MS, maxRetryMs = MAX_RETRY_MS, now = Date.now } = {}) {
  const { literals, hosts } = parseCodeNetSpec(spec);
  const enabled = literals.size > 0 || hosts.length > 0;
  const addresses = new Set(literals);
  let unresolved = hosts.slice();
  let retryTimer = null, nextRetryMs = retryMs;

  async function resolveOnce() {
    const still = [];
    for (const host of unresolved) {
      let timer;
      try {
        const answers = await Promise.race([lookup(host), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('lookup timed out')), resolveTimeoutMs);
          timer.unref?.();
        })]);
        const found = (Array.isArray(answers) ? answers : [answers])
          .map((a) => normalizeAddress(typeof a === 'string' ? a : a?.address)).filter((a) => net.isIP(a));
        if (!found.length) throw Error('no address');
        for (const address of found) addresses.add(address);
      } catch (err) {
        still.push(host);
        log({ event: 'codenet.resolve_failed', host, reason: String(err?.message || err).slice(0, 200) });
      } finally { clearTimeout(timer); }
    }
    unresolved = still;
    if (unresolved.length) {
      // Fails open until resolved — refusing every request because a name did not resolve would
      // take the whole UI down — so keep trying (backing off), and say so each time.
      const wait = nextRetryMs;
      nextRetryMs = Math.min(nextRetryMs * 2, maxRetryMs);
      retryTimer = setTimeout(() => { retryTimer = null; void resolveOnce(); }, wait);
      retryTimer.unref?.();
    } else if (enabled) {
      log({ event: 'codenet.guarding', addresses: [...addresses] });
    }
  }
  // The first resolution is awaited by the first requests, so none slips through at startup.
  const ready = enabled ? resolveOnce() : Promise.resolve();

  let refused = 0, lastLogged = -Infinity;
  /** Whether a connection that arrived on `localAddress` came in over the code network. */
  async function refuses(localAddress) {
    if (!enabled) return false;
    await ready;
    return addresses.has(normalizeAddress(localAddress));
  }
  function deny(res, where) {
    refused++;
    const t = now();
    if (t - lastLogged >= LOG_EVERY_MS) {
      lastLogged = t;
      log({ event: 'codenet.refused', listener: where, refused });
    }
    // No detail: whoever is asking from the sandbox learns nothing beyond "no".
    try {
      res.writeHead(403, { 'content-length': '0', 'cache-control': 'no-store', connection: 'close' });
      res.end();
    } catch { try { res.destroy(); } catch { /* gone */ } }
  }
  /** A request listener that refuses code-network requests before `handler` sees them. */
  function wrap(handler, where = 'ui') {
    if (!enabled) return handler;
    return (req, res) => refuses(req.socket?.localAddress)
      .then((no) => (no ? deny(res, where) : handler(req, res)))
      .catch(() => { try { res.destroy(); } catch { /* gone */ } });
  }
  return { enabled, ready, refuses, wrap, stop: () => { if (retryTimer) clearTimeout(retryTimer); } };
}

module.exports = { createCodeNetGuard, parseCodeNetSpec, normalizeAddress };
