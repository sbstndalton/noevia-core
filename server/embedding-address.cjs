'use strict';
// #1636 / #1645: where an embeddings server may be. A re-index sends every account's project text
// (and the Diary its entries) to that address, so it must be on this network: loopback, a private
// range, or a compose service name that resolves to one.
//
// The decision is positive. The URL must parse, the host must resolve (a literal is its own answer)
// and EVERY answer must be private: not public by the Rust port of ssrf.cjs (a trap refuses), and
// not one of the unspecified, link-local, multicast or reserved addresses it also calls private.
// Anything unparseable, unresolvable or mixed private/public is refused. The earlier check asked
// "is it public" (ssrf.cjs isPublicUrl), which answers false on every failure, so a trailing-dot
// host, a name that did not resolve or a name with one public answer slipped through. A name is
// looked up here, once, when the address is set; the socket resolves it again later, which is why
// the fetches in rag.cjs also refuse redirects.

const dns = require('node:dns');
const { checkServiceEndpoint, deniedAddress: serviceDenied } = require('./service-endpoint.cjs');
const { ssrfWasm } = require('./ssrf.cjs');

// A start-up check that cannot get an answer (a resolver that is not up yet, a compose service that
// is still starting) is retried for about half a minute, then re-checked every minute; only a
// public answer or a malformed address is a permanent refusal.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
const RECHECK_MS = 60000;

// #1755: the address rule is the shared one (service-endpoint.cjs), with link-local refused: an
// embeddings server is never reached at 169.254/16 or fe80::/10 (cloud metadata lives there).
// Loopback, RFC 1918, ULA and 100.64.0.0/10 (Tailscale) stay allowed; any path is accepted.
/** Why `ip` cannot be an address on this network although it is not public, or null. */
const deniedAddress = (ip) => serviceDenied(ip, { linkLocal: false });

/**
 * @param {string} rawUrl
 * @param {object} [o]
 * @param {(host:string, opts:object) => Promise<Array<{address:string}>>} [o.lookup]
 * @param {(addresses:string[]) => boolean} [o.addressesPublic]  true when all are public (the Rust port)
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, transient: boolean }>}  never throws.
 *   transient: the name did not resolve (this time); everything else is a permanent refusal.
 */
async function checkEmbeddingAddress(rawUrl, { lookup = dns.promises.lookup, addressesPublic = (a) => ssrfWasm().ssrfAddressesPublic(a) } = {}) {
  // The Rust port (ssrf.cjs) is asked too, as before #1755: both must agree the address is not public.
  return checkServiceEndpoint(rawUrl, { lookup, paths: null, linkLocal: false, addressesPublic });
}

/**
 * Start-up guard for the values the environment seeded (EMBEDDING_BASE_URL, EMBEDDING_NEXT_BASE_URL).
 * A saved configuration was checked when it was set. A refused value is logged and not used, in
 * memory only (embedding-config.cjs refuseSeeded); it never stops web from starting. A name that
 * does not resolve is retried (RETRY_DELAYS_MS); if it still does not, the value is held back and
 * re-checked every RECHECK_MS, and used again as soon as it resolves to private addresses. Resolves
 * once the first round has decided; later re-checks run on unref'd timers.
 */
async function guardSeededAddresses(config, { check = checkEmbeddingAddress, log = (line) => console.error(line),
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
  schedule = (fn, ms) => setTimeout(fn, ms).unref?.(), retryDelaysMs = RETRY_DELAYS_MS, recheckMs = RECHECK_MS } = {}) {
  const names = { active: 'EMBEDDING_BASE_URL', next: 'EMBEDDING_NEXT_BASE_URL' };
  async function one(which, url) {
    const label = `${names[which]} ${url}`;
    let r = await check(url);
    for (const delay of retryDelaysMs) {
      if (r.ok || !r.transient) break;
      await sleep(delay);
      r = await check(url);
    }
    if (r.ok) return;
    if (!r.transient) {
      log(`[embedding] ${label} refused: ${r.reason}. The embeddings server must be on this network.`);
      config.refuseSeeded({ [which]: `${label} refused: ${r.reason}` });
      return;
    }
    log(`[embedding] ${label} not used yet: ${r.reason}. Checking again every ${Math.round(recheckMs / 1000)} s.`);
    config.refuseSeeded({ [which]: `${label} not used yet: ${r.reason}` }, { transient: true });
    const again = async () => {
      if (config.get().source !== 'environment') return; // an administrator has chosen since: the seed no longer matters
      try {
        const next = await check(url);
        if (next.ok) { config.releaseSeeded(which); log(`[embedding] ${label} resolves to this network now; in use.`); return; }
        if (!next.transient) {
          log(`[embedding] ${label} refused: ${next.reason}. The embeddings server must be on this network.`);
          config.refuseSeeded({ [which]: `${label} refused: ${next.reason}` });
          return;
        }
      } catch { /* try again at the next round */ }
      schedule(again, recheckMs);
    };
    schedule(again, recheckMs);
  }
  try {
    const c = config.get();
    if (c.source !== 'environment' || typeof config.refuseSeeded !== 'function') return;
    await Promise.all(['active', 'next'].filter((which) => c[which]?.baseUrl).map((which) => one(which, c[which].baseUrl).catch((err) => log(`[embedding] could not check ${names[which]} (${String(err?.message || err).slice(0, 120)})`))));
  } catch (err) { log(`[embedding] could not check the seeded embeddings address (${String(err?.message || err).slice(0, 120)})`); }
}

module.exports = { checkEmbeddingAddress, guardSeededAddresses, deniedAddress };
