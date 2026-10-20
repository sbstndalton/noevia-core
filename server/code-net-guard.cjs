'use strict';
// ── Refuse requests that arrive over the internal code network (#853) ──────
//
// `deploy/examples/code-sandbox.override.yml` puts web on the internal `code` network so the
// sandbox can reach the egress proxy (code-egress.cjs) — and only that. But web's UI listener and
// its file-sharing (DAV) listener bind every interface, so they were reachable from the sandbox
// too: an approved `curl` could reach the sign-in and DAV surfaces directly, bypassing the tunnel
// in front of one and the private-network-only relay in front of the other.
//
// The listeners keep their binds; instead, a request whose connection arrived on web's OWN
// address on the code network (`req.socket.localAddress`) is answered 403 with no body. That
// address is named by `COWORK_CODE_NET_ADDR`: IP literals and/or host names, comma separated.
// The override sets it to `egress` — web's alias on the code network, the same name the egress
// proxy resolves to bind there — so the address follows the container network's assignment. Unset: no check.
//
// The egress proxy is a different listener on its own port and never goes through this guard.
//
// The decisions are Rust's (#1071; CODE_NET_GUARD_IMPL is retired and the JavaScript that used to
// make them is gone): noevia-rs's code-net-guard crate, through dav-parse.wasm's code_net_guard,
// reads the spec, keeps the addresses a lookup returned and says whether a request arrived on one
// of them. Nothing here weighs an answer against another or falls back to a reading of its own, so
// every failure to get a usable answer refuses: a spec the crate refuses, cannot be sent or answers
// in the wrong shape stops startup, as a malformed entry does; a fault, refusal, unsendable input or
// wrong-shape reply while reading a lookup's answers refuses every request from then on; the same on
// a request refuses that request. Only the mechanical parts stay here: DNS lookups, retries, timers,
// logs and the 403 itself, and turning whatever a lookup returned into text for the crate: the
// address of each answer is read once and coerced with String, as the old reading coerced it, so the
// crate is shown every address the old reading could have kept. A missing or tampered
// dav-parse.wasm stops startup.
// Stricter than the old JavaScript (the crate docs): a spec with non-ASCII text, a %zone literal, or
// a host name with an xn-- label, all-numeric/0x labels or an all-digit last label is refused; a local
// address that is the same IP as a guarded one in another spelling (0:0::1 / ::1, ::ffff:7f00:1 /
// 127.0.0.1) is refused; a non-ASCII local address or lookup answer is a fault.
// tests/reference/code-net-guard-js.cjs is the old guard, byte-pinned, for the tests only.
const dns = require('node:dns');

const RESOLVE_TIMEOUT_MS = 5000;
const RETRY_MS = 5000;
const MAX_RETRY_MS = 5 * 60_000;
const LOG_EVERY_MS = 60_000;

const defaultLoader = () => require('./dav-parse-wasm.cjs');

const isTextList = (xs) => Array.isArray(xs) && xs.every((x) => typeof x === 'string');

/** `COWORK_CODE_NET_ADDR` as the crate reads it: IP literals and host names. A malformed entry, a
 *  refusal, a fault or a reply of the wrong shape is a startup error. */
function readSpec(raw, wasmLoader) {
  let spec, text;
  try {
    text = String(raw || '');
    spec = wasmLoader().codeNetSpec(text);
  } catch (err) {
    throw Error(`the Rust port refused COWORK_CODE_NET_ADDR (${String(err?.reason || 'unexpected')}); list plain IP addresses or host names`);
  }
  if (spec !== null && typeof spec === 'object' && spec.malformed !== undefined) {
    if (typeof spec.malformed !== 'string' || !spec.malformed) throw Error('the Rust port answered COWORK_CODE_NET_ADDR in an unexpected shape; refusing to start');
    throw Error(`COWORK_CODE_NET_ADDR should list IP addresses or host names, not "${spec.malformed}"`);
  }
  if (spec === null || typeof spec !== 'object' || !isTextList(spec.literals) || !isTextList(spec.hosts)) {
    throw Error('the Rust port answered COWORK_CODE_NET_ADDR in an unexpected shape; refusing to start');
  }
  // Text that is not just white space and commas names something (an address, a host name, or a
  // malformed entry the crate reports). Both lists empty for it means the crate dropped the entry:
  // the guard would be off, so refuse to start rather than serve unguarded.
  if (/[^\s,]/.test(text) && spec.literals.length === 0 && spec.hosts.length === 0) {
    throw Error('the Rust port read no address or host name in COWORK_CODE_NET_ADDR; refusing to start');
  }
  return { literals: spec.literals, hosts: spec.hosts };
}

/** What a lookup returned, as text for the crate: each answer's address (the answer itself when it is
 *  a string) read once and coerced. Throws if reading or coercing does. */
function answerTexts(answers) {
  return (Array.isArray(answers) ? answers : [answers]).map((a) => String((typeof a === 'string' ? a : a?.address) || ''));
}

async function defaultLookup(host) {
  return dns.promises.lookup(host, { all: true, verbatim: true });
}

/**
 * @param {{spec?: string, lookup?: (host: string) => Promise<Array<{address: string}|string>>,
 *          log?: (entry: object) => void, resolveTimeoutMs?: number, retryMs?: number,
 *          now?: () => number, wasmLoader?: () => object}} options
 */
function createCodeNetGuard({ spec = '', lookup = defaultLookup, log = () => {}, resolveTimeoutMs = RESOLVE_TIMEOUT_MS,
  retryMs = RETRY_MS, maxRetryMs = MAX_RETRY_MS, now = Date.now,
  wasmLoader = defaultLoader } = {}) {
  const { literals, hosts } = readSpec(spec, wasmLoader);
  const enabled = literals.length > 0 || hosts.length > 0;
  // The guarded addresses: the spec's literals, then what the lookups returned (as the crate kept them).
  const addresses = new Set(literals);
  let broken = false, warnedPort = '';
  function portFault(err, where) {
    let reason = 'unexpected';
    try { reason = String(err?.reason || 'unexpected'); } catch { /* a reason that will not print */ }
    if (warnedPort !== `${where}:${reason}`) {
      warnedPort = `${where}:${reason}`;
      log({ event: 'codenet.wasm_fault', where, reason });
    }
  }
  let unresolved = hosts.slice();
  let retryTimer = null, nextRetryMs = retryMs;

  async function resolveOnce() {
    const still = [];
    for (const host of unresolved) {
      // Once the crate's view is incomplete every request is refused, so nothing is left to resolve.
      if (broken) continue;
      let timer;
      try {
        const answers = await Promise.race([lookup(host), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('lookup timed out')), resolveTimeoutMs);
          timer.unref?.();
        })]);
        let kept;
        try {
          kept = wasmLoader().codeNetResolved(answerTexts(answers));
          if (!isTextList(kept)) throw Object.assign(Error('code net guard reply is not a list of addresses'), { reason: 'reply' });
        } catch (err) {
          // The crate's view of what to refuse is now incomplete: refuse everything (fails closed).
          broken = true;
          portFault(err, 'resolve');
          continue;
        }
        if (!kept.length) throw Error('no address');
        for (const address of kept) addresses.add(address);
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
      // A retry that throws (only a logger can) must not become an unhandled rejection (#213), and it
      // leaves the address set possibly incomplete with no retry scheduled: refuse everything (fails closed).
      retryTimer = setTimeout(() => { retryTimer = null; resolveOnce().catch(() => { broken = true; }); }, wait);
      retryTimer.unref?.();
    } else if (enabled && !broken) {
      log({ event: 'codenet.guarding', addresses: [...addresses] });
    }
  }
  // The first resolution is awaited by the first requests, so none slips through at startup.
  const ready = enabled ? resolveOnce() : Promise.resolve();
  // Nothing in production awaits `ready` (#213): if resolution throws (only a logger can), the
  // rejection is marked handled here so it cannot crash the process. Callers that do await `ready`
  // still see the rejection, and a request then fails closed as before (it is destroyed).
  ready.catch(() => {});

  let refused = 0, lastLogged = -Infinity;
  /** Whether a connection that arrived on `localAddress` came in over the code network. */
  async function refuses(localAddress) {
    if (!enabled) return false;
    await ready;
    if (broken) return true;
    try {
      const local = typeof localAddress === 'string' ? localAddress : (localAddress ? String(localAddress) : null);
      const answer = wasmLoader().codeNetRefuses([...addresses], local);
      if (typeof answer !== 'boolean') throw Object.assign(Error('code net guard reply is not a boolean'), { reason: 'reply' });
      return answer;
    } catch (err) {
      portFault(err, 'request');
      return true;
    }
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

module.exports = { createCodeNetGuard };
