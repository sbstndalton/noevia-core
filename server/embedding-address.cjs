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
const net = require('node:net');
const { ssrfWasm } = require('./ssrf.cjs');

const LOOKUP_TIMEOUT_MS = 5000;
// A start-up check that cannot get an answer (a resolver that is not up yet, a compose service that
// is still starting) is retried for about half a minute, then re-checked every minute; only a
// public answer or a malformed address is a permanent refusal.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
const RECHECK_MS = 60000;

/** A permanent refusal. */
function refuse(reason) { return { ok: false, reason, transient: false }; }
/** The name could not be resolved (yet): recoverable. */
function unresolved(reason) { return { ok: false, reason, transient: true }; }

// Addresses ssrf.cjs isPrivateIp calls "private" (it means: not a public one) but that name no host
// on this network: unspecified, link-local, multicast, reserved and documentation ranges, and the
// IPv6 forms that carry another address (v4-compatible, NAT64, Teredo). Loopback, RFC 1918, ULA and
// 100.64.0.0/10 (Tailscale) stay allowed.
function deniedV4([a, b, c]) {
  if (a === 0) return 'the unspecified address';
  if (a === 169 && b === 254) return 'a link-local address';
  if (a >= 224) return a === 255 && b === 255 ? 'the broadcast address' : a < 240 ? 'a multicast address' : 'a reserved address';
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'a reserved address';
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return 'a documentation address';
  return null;
}

function hextets(ip) {
  const text = ip.split('%')[0];
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  let head = text;
  if (dotted) {
    const q = dotted[2].split('.').map(Number);
    head = `${dotted[1]}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const [left, right, extra] = head.split('::');
  if (extra !== undefined) return null;
  const a = left ? left.split(':') : [];
  const b = right ? right.split(':') : [];
  const fill = right === undefined ? 0 : 8 - a.length - b.length;
  if (right === undefined ? a.length !== 8 : fill < 1) return null;
  const all = [...a, ...Array(fill).fill('0'), ...b].map((h) => parseInt(h, 16));
  return all.length === 8 && all.every((h) => Number.isInteger(h) && h >= 0 && h <= 0xffff) ? all : null;
}

/** Why `ip` cannot be an address on this network although it is not public, or a reason string. */
function deniedAddress(ip) {
  if (net.isIPv4(ip)) return deniedV4(ip.split('.').map(Number));
  const h = hextets(ip);
  if (!h) return 'not an address';
  const mapped = h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff;
  if (mapped) return deniedV4([h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255]);
  if (h.slice(0, 7).every((x) => x === 0)) return h[7] === 1 ? null : h[7] === 0 ? 'the unspecified address' : 'a reserved address'; // ::1 is loopback
  if (h.slice(0, 6).every((x) => x === 0)) return 'a reserved address'; // ::a.b.c.d, v4-compatible
  if ((h[0] & 0xffc0) === 0xfe80) return 'a link-local address';
  if ((h[0] & 0xff00) === 0xff00) return 'a multicast address';
  if (h[0] === 0x64 && h[1] === 0xff9b) return 'a reserved address'; // NAT64
  if (h[0] === 0x2001 && (h[1] === 0 || h[1] === 0xdb8)) return 'a reserved address'; // Teredo, documentation
  if (h[0] === 0x100 && h.slice(1, 4).every((x) => x === 0)) return 'a reserved address'; // discard-only
  return null;
}

/** null when `ip` is an address on this network, else why not. The policy module is asked
 *  directly: ssrf.cjs isPrivateIp turns a trap into "private", which is the wrong way round here. */
function whyNotLocal(ip, addressesPublic) {
  let isPublic;
  try { isPublic = addressesPublic([ip]); } catch { return 'the address policy could not decide'; }
  if (isPublic) return 'a public address';
  return deniedAddress(ip);
}

async function resolveAll(host, lookup) {
  let timer;
  try {
    const answers = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('lookup timed out')), LOOKUP_TIMEOUT_MS); timer.unref?.(); }),
    ]);
    return (Array.isArray(answers) ? answers : [answers]).map((a) => a?.address);
  } finally { clearTimeout(timer); }
}

/**
 * @param {string} rawUrl
 * @param {object} [o]
 * @param {(host:string, opts:object) => Promise<Array<{address:string}>>} [o.lookup]
 * @param {(addresses:string[]) => boolean} [o.addressesPublic]  true when all are public (the Rust port)
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, transient: boolean }>}  never throws.
 *   transient: the name did not resolve (this time); everything else is a permanent refusal.
 */
async function checkEmbeddingAddress(rawUrl, { lookup = dns.promises.lookup, addressesPublic = (a) => ssrfWasm().ssrfAddressesPublic(a) } = {}) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { return refuse('not a URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) return refuse('not an http(s) URL');
  if (url.username || url.password) return refuse('credentials in the URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return refuse('no host');
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else {
    try { addresses = await resolveAll(host, lookup); } catch (err) { return unresolved(`the name does not resolve (${String(err?.code || err?.message || err).slice(0, 60)})`); }
  }
  if (!addresses.length) return unresolved('the name does not resolve');
  if (addresses.some((a) => typeof a !== 'string' || !net.isIP(a))) return refuse('the name resolves to something that is not an address');
  for (const a of addresses) {
    const why = whyNotLocal(a, addressesPublic);
    if (why) return refuse(`${host} is not on this network (${a} is ${why})`);
  }
  return { ok: true };
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
