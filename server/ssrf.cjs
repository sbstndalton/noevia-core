'use strict';

// Private-network denylist for user-supplied outbound URL targets.
//
// Authenticated members can register outbound targets: OpenAI-compatible
// providers (connection test + chat) and storage connections (test, browse,
// read, diary corpus sync). Without a guard, a member can point any of those
// at an internal/RFC1918 address or a cloud metadata endpoint and use the
// server's network position for SSRF. Administrators are exempt:
// loopback/host.docker.internal addresses, and only an admin can
// configure those.
//
// The Rust port (sbstndalton/noevia-rs crates/ssrf-policy, in the dav-parse.wasm module pinned by
// server/dav-parse.lock) decides, always (since #1071; it was SSRF_IMPL=wasm): "is this URL
// acceptable" and "is this resolved address public"; the DNS lookup and the socket stay here and in
// public-fetch.cjs. It covers isPrivateIp for every caller (public-fetch, code-egress,
// browser-policy, tool-gate), isPublicUrl, and publicFetch's URL check. It FAILS CLOSED: a missing
// or tampered module stops startup (dav-parse-wasm.cjs verifyAtStartup), and a trap, a refusal or a
// reply of the wrong shape makes the address private / the URL refused; nothing falls back to JS.
// The Rust host must equal `new URL(url).hostname`, or the URL is refused. Refusals (see the crate
// docs): names ending with a dot, internationalized (xn--) hosts, a URL over 64 KiB or holding a
// lone surrogate, more than 512 DNS answers, and metadata.google.internal by name in publicFetch.
// The JS reference is a test oracle only (tests/server/oracle/ssrf.cjs; tests/fixtures/ssrf.v1.json
// is its).

const dns = require('dns');

let davParseWasm = null;
/** The dav-parse.wasm loader, required on first use. */
function ssrfWasm() { return davParseWasm || (davParseWasm = require('./dav-parse-wasm.cjs')); }

/** Whether an address is private, by the Rust port. Any failure is "private". */
function isPrivateIp(ip) {
  if (typeof ip !== 'string') return true; // net.isIP of a non-string is 0: private
  try { return !ssrfWasm().ssrfAddressesPublic([ip]); } catch { return true; }
}

async function resolveAll(hostname) {
  const results = await Promise.allSettled([dns.promises.lookup(hostname, { all: true, verbatim: true })]);
  const settled = results[0];
  return settled.status === 'fulfilled' ? settled.value.map((r) => r.address) : [];
}

/** Returns true when the URL is safe to request, decided by the Rust port: it parses the URL and
 *  judges a literal; a name is resolved here and every answer judged there. Never throws; any
 *  failure (an unparseable URL, a name that does not resolve, a module error) is "not public". */
async function isPublicUrl(rawUrl) {
  let decision;
  try { decision = ssrfWasm().ssrfUrl(String(rawUrl), { mode: 'check' }); } catch { return false; }
  if (!decision.ok) return false;
  if (decision.kind === 'ip') return true;
  const addresses = await resolveAll(decision.host);
  if (!addresses.length) return false;
  try { return ssrfWasm().ssrfAddressesPublic(addresses); } catch { return false; }
}

// Origin policy for the endpoints a member may register: providers, storage
// connections, the Diary corpus sync. A member must not aim the server's
// outbound traffic — connection tests, file browsing, corpus sync — at
// internal addresses (RFC1918, link-local metadata, …). Admins are exempt: a
// self-hosted administrator legitimately connects LAN storage (a home NAS,
// an in-network Nextcloud) or local inference. MEMBER_OUTBOUND_ORIGINS is
// read at call time, so an operator's change (or a test's) takes effect
// without a restart.
function createEndpointApproved({ env = process.env } = {}) {
  return function endpointApproved(authn, rawUrl) {
    try {
      const u = new URL(rawUrl);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return false;
      return authn?.user.role === 'admin' || (env.MEMBER_OUTBOUND_ORIGINS || '').split(',').map(x => x.trim()).includes(u.origin);
    } catch { return false; }
  };
}

module.exports = { isPublicUrl, isPrivateIp, ssrfWasm, createEndpointApproved };
