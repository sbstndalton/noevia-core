'use strict';
// #1755: where an operator's own services may be (decision/Laya/Kev, sensitivity, System 1, embeddings):
// any address on this network, so a model can run on another LAN or Tailscale machine (a Pi 5, a
// Rock 5B), not only behind a Docker service name on this host.
//
// The rule, one place for every caller:
//  - http or https; no login, query string or fragment (each caller says which paths it takes);
//  - an IP literal must be on this network: loopback, RFC 1918, Tailscale CGNAT 100.64.0.0/10, IPv6
//    ULA fc00::/7 and, where the caller opts in (default: not), link-local (IPv4 169.254/16, IPv6 fe80::/10). Never
//    public, unspecified (0.0.0.0, ::), multicast, broadcast, reserved or documentation ranges, the
//    IPv6 forms that carry another address (v4-compatible, NAT64, Teredo), or a cloud metadata address;
//  - a name (a single-label Docker service name such as `laya`, or `rock5b.local`, `pi5.lan`,
//    `box.tailnet.ts.net`, any name) is accepted only if EVERY address it resolves to passes the rule
//    above. Anything that does not resolve, or resolves to one public answer among private ones, is refused.
//
// DNS rebinding: a name checked once and resolved again by the socket could answer "private" to the
// check and "public" to the connection. createServiceFetch closes that gap the way public-fetch.cjs
// does for the opposite rule: the socket's own `lookup` resolves the name and refuses the connection
// unless every answer passes, so the address connected to is the one just checked. Redirects are
// never followed (public-fetch.cjs sendWithLookup refuses a 3xx).
//
// The decision is positive and needs no other module: an address is accepted only if it is in one of
// the ranges above (and not on the deny list, which only gives a refusal its precise reason). So a
// caller that stubs the policy module (tools/decision-eval) or a missing module cannot widen it.

const dns = require('node:dns');
const net = require('node:net');

const LOOKUP_TIMEOUT_MS = 5000;
// Instance-metadata addresses, refused even where link-local / ULA is allowed.
// 100.100.100.200 is Alibaba Cloud's, inside the Tailscale range 100.64.0.0/10 (#1760).
const METADATA = new Set(['169.254.169.254', '100.100.100.200', 'fd00:ec2:0:0:0:0:0:254']);

// Only an extra check, when a caller passes one (embedding-address.cjs passes the Rust port's).
const defaultAddressesPublic = null;

/** Whether `ip` is in a range that is this network: loopback, RFC 1918, 100.64.0.0/10, ULA, link-local. */
function inLocalRange(ip) {
  let q;
  if (net.isIPv4(ip)) q = ip.split('.').map(Number);
  else {
    const h = hextets(ip);
    if (!h) return false;
    if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) q = [h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255];
    else return (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) || (h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80;
  }
  const [a, b] = q;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

function deniedV4([a, b, c, d], linkLocal) {
  if (a === 0) return 'the unspecified address';
  if (METADATA.has(`${a}.${b}.${c}.${d}`)) return 'a cloud metadata address';
  if (a === 169 && b === 254) return !linkLocal ? 'a link-local address' : (c === 169 && d === 254) ? 'a cloud metadata address' : null;
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

/** Why `ip` is not a host on this network although it is not public, or null.
 *  `linkLocal`: whether 169.254/16 and fe80::/10 count as this network (default: no; a caller that needs it says so, #1760). */
function deniedAddress(ip, { linkLocal = false } = {}) {
  if (net.isIPv4(ip)) return deniedV4(ip.split('.').map(Number), linkLocal);
  const h = hextets(ip);
  if (!h) return 'not an address';
  if (METADATA.has(h.map((x) => x.toString(16)).join(':'))) return 'a cloud metadata address';
  const mapped = h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff;
  if (mapped) return deniedV4([h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255], linkLocal);
  if (h.slice(0, 7).every((x) => x === 0)) return h[7] === 1 ? null : h[7] === 0 ? 'the unspecified address' : 'a reserved address'; // ::1 is loopback
  if (h.slice(0, 6).every((x) => x === 0)) return 'a reserved address'; // ::a.b.c.d, v4-compatible
  if ((h[0] & 0xffc0) === 0xfe80) return linkLocal ? null : 'a link-local address';
  if ((h[0] & 0xff00) === 0xff00) return 'a multicast address';
  if (h[0] === 0x64 && h[1] === 0xff9b) return 'a reserved address'; // NAT64
  if (h[0] === 0x2001 && (h[1] === 0 || h[1] === 0xdb8)) return 'a reserved address'; // Teredo, documentation
  if (h[0] === 0x100 && h.slice(1, 4).every((x) => x === 0)) return 'a reserved address'; // discard-only
  return null;
}

/** null when `ip` is a host on this network, else why not. A policy-module failure refuses. */
function whyNotLocal(ip, { addressesPublic = defaultAddressesPublic, linkLocal = false } = {}) {
  if (typeof ip !== 'string' || !net.isIP(ip)) return 'not an address';
  const denied = deniedAddress(ip, { linkLocal });
  if (denied) return denied;
  if (!inLocalRange(ip)) return 'a public address';
  if (addressesPublic) {
    let isPublic;
    try { isPublic = addressesPublic([ip]); } catch { return 'the address policy could not decide'; }
    if (isPublic) return 'a public address';
  }
  return null;
}

const hostOfUrl = (url) => url.hostname.replace(/^\[|\]$/g, '');

/**
 * The synchronous half: the URL's shape, and an IP literal's address. A name passes here and is
 * judged by what it resolves to (checkServiceEndpoint, and at connect time createServiceFetch).
 * @param {string} raw
 * @param {{ paths?: string[]|null, linkLocal?: boolean, addressesPublic?: Function }} [o]
 *   paths: the pathnames this caller accepts (null: any path).
 * @returns {{ url: URL, host: string, isName: boolean, baseUrl: string, reason: null } | { reason: string }}
 */
function parseServiceUrl(raw, { paths = ['/'], linkLocal = false, addressesPublic = defaultAddressesPublic } = {}) {
  let url;
  try { url = new URL(String(raw ?? '').trim()); } catch { return { reason: 'not a URL' }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { reason: 'not an http(s) URL' };
  if (url.username || url.password) return { reason: 'credentials in the URL' };
  if (url.search || url.hash || String(raw).includes('?') || String(raw).includes('#')) return { reason: 'a query string or fragment in the URL' };
  if (paths && !paths.includes(url.pathname)) return { reason: 'a path in the URL' };
  const host = hostOfUrl(url);
  if (!host) return { reason: 'no host' };
  if (net.isIP(host)) {
    const why = whyNotLocal(host, { addressesPublic, linkLocal });
    if (why) return { reason: `${host} is not on this network (${host} is ${why})` };
    return { url, host, isName: false, baseUrl: url.origin, reason: null };
  }
  // A name: no empty label in the middle (`a..b`); a trailing dot is a name like another.
  if (host.replace(/\.$/, '').split('.').some((l) => !l)) return { reason: 'not a valid host name' };
  return { url, host, isName: true, baseUrl: url.origin, reason: null };
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

/** Judges a list of resolved answers: null when every one is on this network, else why not. */
function whyAnswersNotLocal(host, addresses, opts) {
  if (!addresses.length) return 'the name does not resolve';
  if (addresses.some((a) => typeof a !== 'string' || !net.isIP(a))) return 'the name resolves to something that is not an address';
  for (const a of addresses) {
    const why = whyNotLocal(a, opts);
    if (why) return `${host} is not on this network (${a} is ${why})`;
  }
  return null;
}

/**
 * The whole rule, resolving a name now. Never throws.
 * @param {string} raw
 * @param {{ lookup?: (host:string, opts:object) => Promise<Array<{address:string}>>, paths?: string[]|null,
 *   linkLocal?: boolean, addressesPublic?: Function }} [o]
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, transient: boolean }>}
 *   transient: the name did not resolve (this time); everything else is a permanent refusal.
 */
async function checkServiceEndpoint(raw, { lookup = dns.promises.lookup, paths = ['/'], linkLocal = false, addressesPublic = defaultAddressesPublic } = {}) {
  const parsed = parseServiceUrl(raw, { paths, linkLocal, addressesPublic });
  if (parsed.reason) return { ok: false, reason: parsed.reason, transient: false };
  if (!parsed.isName) return { ok: true };
  let addresses;
  try { addresses = await resolveAll(parsed.host, lookup); } catch (err) {
    return { ok: false, reason: `the name does not resolve (${String(err?.code || err?.message || err).slice(0, 60)})`, transient: true };
  }
  if (!addresses.length) return { ok: false, reason: 'the name does not resolve', transient: true };
  const why = whyAnswersNotLocal(parsed.host, addresses, { addressesPublic, linkLocal });
  return why ? { ok: false, reason: why, transient: false } : { ok: true };
}

function refusal(message) { return Object.assign(new Error(message), { code: 'EPUBLICADDR' }); }

/**
 * A `lookup` for net/http/tls that resolves as usual and refuses the connection unless EVERY answer is
 * on this network. Accepts both shapes net uses (`all: true`, and the single-address form).
 */
function createServiceLookup({ resolve = dns.lookup, linkLocal = false, addressesPublic = defaultAddressesPublic } = {}) {
  return function serviceLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
    const done = (...args) => process.nextTick(callback, ...args);
    resolve(hostname, { ...opts, all: true }, (err, answers) => {
      if (err) return done(err);
      const list = (Array.isArray(answers) ? answers : []).map((a) => a?.address);
      // The addresses stay out of the message: it can reach logs and the admin UI.
      const why = whyAnswersNotLocal(hostname, list, { addressesPublic, linkLocal });
      if (why) return done(list.length ? refusal(`refused: ${hostname} does not resolve only to addresses on this network`) : Object.assign(new Error(`${hostname} did not resolve`), { code: 'ENOTFOUND' }));
      const out = list.map((address) => ({ address, family: net.isIP(address) }));
      if (opts.all) return done(null, out);
      return done(null, out[0].address, out[0].family);
    });
  };
}

/**
 * A fetch that can only reach hosts on this network, decided at connect time. Returns a WHATWG
 * Response; never follows a redirect. `resolve` is injected in tests to simulate DNS.
 */
function createServiceFetch({ resolve = dns.lookup, linkLocal = false, addressesPublic = defaultAddressesPublic } = {}) {
  const lookup = createServiceLookup({ resolve, linkLocal, addressesPublic });
  return async function serviceFetch(input, init = {}) {
    const url = new URL(String(input));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError(`refused: ${url.protocol} is not http(s)`);
    if (url.username || url.password) throw new TypeError('refused: credentials in the URL');
    const host = hostOfUrl(url);
    if (net.isIP(host)) {
      const why = whyNotLocal(host, { addressesPublic, linkLocal });
      if (why) throw refusal(`refused: ${host} is not on this network`);
    }
    return require('./public-fetch.cjs').sendWithLookup(url, init, lookup);
  };
}

let shared, sharedLinkLocal;
/** The process-wide service fetch (real DNS), link-local refused. */
function serviceFetch(input, init) { return (shared || (shared = createServiceFetch()))(input, init); }
/** The same, for the one caller that opts in to link-local: the decision service (Laya/Kev). */
function decisionServiceFetch(input, init) { return (sharedLinkLocal || (sharedLinkLocal = createServiceFetch({ linkLocal: true })))(input, init); }

module.exports = { parseServiceUrl, checkServiceEndpoint, createServiceLookup, createServiceFetch, serviceFetch, decisionServiceFetch, deniedAddress, whyNotLocal };
