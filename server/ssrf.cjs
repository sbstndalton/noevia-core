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

const dns = require('dns');
const net = require('net');

const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal']);

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // unparseable → treat as private
  const [a, b] = parts;
  return (
    a === 0 || // "this network"
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT (Tailscale et al.)
    (a === 169 && b === 254) || // link-local (AWS/ECS/GCP metadata is 169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 192 && b === 0) || // 192.0.0.0/24 + 192.0.2.0/24 (TEST-NET, on-prem stacks)
    (a === 198 && (b === 18 || b === 19)) || // benchmarking range used by container networks
    a >= 224 // multicast + reserved
  );
}

function isPrivateIPv6(ip) {
  const lower = String(ip).toLowerCase();
  if (lower === '::' || lower === '::1' || lower === '::ffff:0:0/96') return true;
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true; // link-local + ULA
  if (lower.startsWith('::ffff:')) return isPrivateIPv4(lower.slice(7)); // IPv4-mapped
  // IPv4-compatible (::a.b.c.d) — rare, but treat as its IPv4 self.
  if (/^::([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(lower)) return isPrivateIPv4(lower.slice(2));
  const first = parseInt(lower.split(':')[0] || '0', 16);
  if (!Number.isNaN(first) && (first & 0xe000) === 0x2000) return false; // global unicast 2000::/3
  return true; // everything else is reserved/special-purpose
}

function isPrivateIp(ip) {
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
async function isPublicUrl(rawUrl) {
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
  if (net.isIP(hostname)) return !isPrivateIp(hostname);
  const addresses = await resolveAll(hostname);
  if (!addresses.length) return false;
  return addresses.every((address) => !isPrivateIp(address));
}

module.exports = { isPublicUrl, isPrivateIp };
