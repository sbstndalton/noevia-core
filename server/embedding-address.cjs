'use strict';
// #1636 / #1645: where an embeddings server may be. A re-index sends every account's project text
// (and the Diary its entries) to that address, so it must be on this network: loopback, a private
// range, or a compose service name that resolves to one.
//
// The decision is positive. The URL must parse, the host must resolve (a literal is its own answer)
// and EVERY answer must be private (ssrf.cjs isPrivateIp, the Rust port: any address it does not
// know to be public is private, any failure is private). Anything unparseable, unresolvable or
// mixed private/public is refused. The earlier check asked "is it public" (ssrf.cjs isPublicUrl),
// which answers false on every failure, so a trailing-dot host, a name that did not resolve or a
// name with one public answer slipped through. A name is looked up here, once, when the address is
// set; the socket resolves it again later, which is why the fetches in rag.cjs also refuse redirects.

const dns = require('node:dns');
const net = require('node:net');
const { isPrivateIp } = require('./ssrf.cjs');

const LOOKUP_TIMEOUT_MS = 5000;

function refuse(reason) { return { ok: false, reason }; }

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
 * @param {{ lookup?: (host:string, opts:object) => Promise<Array<{address:string}>> }} [o]
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}  never throws
 */
async function checkEmbeddingAddress(rawUrl, { lookup = dns.promises.lookup } = {}) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { return refuse('not a URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) return refuse('not an http(s) URL');
  if (url.username || url.password) return refuse('credentials in the URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return refuse('no host');
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else {
    try { addresses = await resolveAll(host, lookup); } catch (err) { return refuse(`the name does not resolve (${String(err?.code || err?.message || err).slice(0, 60)})`); }
  }
  if (!addresses.length || addresses.some((a) => typeof a !== 'string' || !net.isIP(a))) return refuse('the name does not resolve');
  const outside = addresses.find((a) => !isPrivateIp(a));
  if (outside) return refuse(`${host} is not on this network (${outside})`);
  return { ok: true };
}

/**
 * Startup guard for the values the environment seeded (EMBEDDING_BASE_URL, EMBEDDING_NEXT_BASE_URL).
 * A saved configuration was checked when it was set. A refused value is logged and not used, in
 * memory only (embedding-config.cjs refuseSeeded); it never stops web from starting.
 */
async function guardSeededAddresses(config, { check = checkEmbeddingAddress, log = (line) => console.error(line) } = {}) {
  try {
    const c = config.get();
    if (c.source !== 'environment' || c.version !== 0 || typeof config.refuseSeeded !== 'function') return;
    const verdict = {};
    for (const which of ['active', 'next']) {
      const url = c[which]?.baseUrl;
      if (!url) continue;
      const r = await check(url);
      if (!r.ok) { verdict[which] = `${which === 'active' ? 'EMBEDDING_BASE_URL' : 'EMBEDDING_NEXT_BASE_URL'} ${url} refused: ${r.reason}`; log(`[embedding] ${verdict[which]}. The embeddings server must be on this network.`); }
    }
    if (verdict.active || verdict.next) config.refuseSeeded(verdict);
  } catch (err) { log(`[embedding] could not check the seeded embeddings address (${String(err?.message || err).slice(0, 120)})`); }
}

module.exports = { checkEmbeddingAddress, guardSeededAddresses };
