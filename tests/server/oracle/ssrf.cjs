'use strict';

// TEST ORACLE (#1071): never required by production code (server/oracle-isolation.test.cjs
// enforces that). The JS reference of the private-network denylist, kept only so
// tools/gen-ssrf-fixtures.cjs can regenerate tests/fixtures/ssrf.v1.json and the differential tests
// can compare it with dav-parse.wasm (sbstndalton/noevia-rs crates/ssrf-policy). Production decides
// with the Rust module alone (server/ssrf.cjs, server/public-fetch.cjs).
// Moved here unchanged from server/ssrf.cjs (isPrivateIpJs, isPublicUrlJs and their helpers).

const dns = require('dns');
const net = require('net');

const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal']);

function isPrivateIPv4(ip) {
  const parts = Array.isArray(ip) ? ip : String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // unparseable → treat as private
  const [a, b, c] = parts;
  return (
    a === 0 || // "this network"
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT (Tailscale et al.)
    (a === 169 && b === 254) || // link-local (AWS/ECS/GCP metadata is 169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0.0/24 IETF assignments + 192.0.2.0/24 TEST-NET-1 (the rest of 192.0/16 is public, e.g. 192.0.78.x)
    (a === 192 && b === 88 && c === 99) || // 192.88.99.0/24 6to4 relay anycast (deprecated, RFC 7526)
    (a === 198 && (b === 18 || b === 19)) || // benchmarking range used by container networks
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 TEST-NET-3
    a >= 224 // multicast + reserved
  );
}

// An IPv6 literal as 16 bytes, or null when it is not one plain address. A zone
// (`fe80::1%eth0`) is null too: a scoped address names an interface on this host,
// which is never a public destination (#930).
function parseIPv6(ip) {
  let text = String(ip);
  if (text.includes('%') || net.isIP(text) !== 6) return null;
  const tail = [];
  const lastColon = text.lastIndexOf(':');
  if (text.slice(lastColon + 1).includes('.')) { // trailing dotted IPv4 (::ffff:1.2.3.4)
    const v4 = text.slice(lastColon + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    tail.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
    text = text.slice(0, lastColon + 1); // "::ffff:" → "::ffff", "::" stays "::"
    if (!text.endsWith('::')) text = text.slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s) => (s === '' ? [] : s.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const fixed = head.length + rest.length + tail.length;
  if ([...head, ...rest].some(Number.isNaN)) return null;
  let groups;
  if (halves.length === 2) {
    if (fixed > 7) return null;
    groups = [...head, ...new Array(8 - fixed).fill(0), ...rest, ...tail];
  } else {
    groups = [...head, ...tail];
  }
  if (groups.length !== 8) return null;
  const bytes = new Array(16);
  groups.forEach((g, i) => { bytes[2 * i] = g >> 8; bytes[2 * i + 1] = g & 0xff; });
  return bytes;
}

// True when the first `bits` bits of `bytes` equal those of `prefix` (byte array).
function inPrefix(bytes, prefix, bits) {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3, mask = 0x80 >> (i & 7);
    if ((bytes[byte] & mask) !== ((prefix[byte] || 0) & mask)) return false;
  }
  return true;
}

function isPrivateIPv6(ip) {
  const b = parseIPv6(ip);
  if (!b) return true; // zone-scoped or unparseable → private
  // ::/96 — unspecified, loopback and the deprecated IPv4-compatible ::a.b.c.d (RFC 4291
  // §2.5.5.1). None is a public destination, whatever IPv4 it appears to carry (#930).
  if (inPrefix(b, [], 96)) return true;
  // ::ffff:0:0/96 IPv4-mapped: the connection goes to the embedded IPv4, so judge that.
  if (inPrefix(b, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) return isPrivateIPv4(b.slice(12));
  if (inPrefix(b, [0xfe, 0x80], 10)) return true; // link-local fe80::/10 (fe80–febf)
  if (inPrefix(b, [0xfc], 7)) return true; // ULA fc00::/7
  if (!inPrefix(b, [0x20], 3)) return true; // outside global unicast 2000::/3: reserved/special-purpose/multicast
  // Special-purpose blocks inside 2000::/3 that must not count as public (#930):
  if (inPrefix(b, [0x20, 0x01, 0x00, 0x00], 32)) return true; // Teredo 2001::/32 (tunnels to an embedded IPv4)
  if (inPrefix(b, [0x20, 0x01, 0x0d, 0xb8], 32)) return true; // documentation 2001:db8::/32
  // 6to4 2002::/16 carries an IPv4 in bits 16–47 (2002:c0a8:0101::/48 ↔ 192.168.1.1) and is
  // relayed to it. Refused outright, not only when that IPv4 is private: 6to4 is deprecated
  // (RFC 7526), no service a member legitimately registers is reached only by a 6to4 address,
  // and the relay path ends at whatever IPv4 the attacker picked — public or not.
  if (inPrefix(b, [0x20, 0x02], 16)) return true;
  return false;
}

function isPrivateIpJs(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // not an IP literal → treat as private
}

async function resolveAll(hostname) {
  const results = await Promise.allSettled([dns.promises.lookup(hostname, { all: true, verbatim: true })]);
  const settled = results[0];
  return settled.status === 'fulfilled' ? settled.value.map((r) => r.address) : [];
}

// Returns true when the URL is safe to request. Never throws: an
// unparseable URL is treated as unsafe. DNS lookups are best-effort —
// a hostname that fails to resolve is rejected as a precaution.
async function isPublicUrlJs(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) return false;
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) return false;
  if (net.isIP(hostname)) return !isPrivateIpJs(hostname);
  const addresses = await resolveAll(hostname);
  if (!addresses.length) return false;
  return addresses.every((address) => !isPrivateIpJs(address));
}

module.exports = { isPrivateIpJs, isPublicUrlJs };
