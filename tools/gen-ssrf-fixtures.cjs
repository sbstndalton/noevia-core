#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for the outbound-URL guard (SSRF_IMPL, ssrf.cjs + public-fetch.cjs
// #795). The same file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/ssrf-policy/tests/fixtures/ssrf.v1.json); noevia-core CI compares them.
//   node tools/gen-ssrf-fixtures.cjs > tests/fixtures/ssrf.v1.json
//
// Every expectation is what the JS itself does (isPublicUrl, createPublicFetch, isPrivateIp), run
// here with the network replaced: dns.promises.lookup records the name it was asked for and
// answers nothing, and http/https.request record the host they were asked to connect to and
// throw. Nothing is resolved or connected. Hosts are synthetic or documentation addresses.
//
// Sections:
//   addresses: { address, private }                    isPrivateIp(address)
//   urls:      { url, loopback, check, fetch }          check: isPublicUrl up to its DNS step,
//              { ok:false } | { ok:true, kind:'ip'|'name', host }; fetch: createPublicFetch up to
//              the socket, { ok:false, reason } | { ok:true, kind, host }. `kind:'name'` means the
//              JS goes on to resolve `host`; 'ip' that it accepted the literal without DNS.
// Run with Node 22 (CI's version): `new URL` is ada, whose output is pinned by this file.

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');

// The JS reference, whatever this shell's SSRF_IMPL says.
delete process.env.SSRF_IMPL;
const server = path.join(__dirname, '..', 'server');
const { isPrivateIpJs: isPrivateIp, isPublicUrlJs: isPublicUrl } = require(path.join(server, 'ssrf.cjs'));
const { createPublicFetch } = require(path.join(server, 'public-fetch.cjs'));

// --- deterministic PRNG (mulberry32) ---------------------------------------------------------
let seed = 0x5357f1;
function rnd() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rnd() * a.length)];
const uniq = (a) => [...new Set(a)];

// --- addresses -------------------------------------------------------------------------------
const v4 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const v4n = (s) => s.split('.').reduce((acc, p) => acc * 256 + Number(p), 0);
const V4_RANGES = [
  ['0.0.0.0', '0.255.255.255'], ['10.0.0.0', '10.255.255.255'], ['100.64.0.0', '100.127.255.255'],
  ['127.0.0.0', '127.255.255.255'], ['169.254.0.0', '169.254.255.255'], ['172.16.0.0', '172.31.255.255'],
  ['192.0.0.0', '192.0.0.255'], ['192.0.2.0', '192.0.2.255'], ['192.88.99.0', '192.88.99.255'],
  ['192.168.0.0', '192.168.255.255'], ['198.18.0.0', '198.19.255.255'], ['198.51.100.0', '198.51.100.255'],
  ['203.0.113.0', '203.0.113.255'], ['224.0.0.0', '255.255.255.255'],
];
const v4Edges = uniq(V4_RANGES.flatMap(([lo, hi]) => {
  const a = v4n(lo), b = v4n(hi);
  return [a - 1, a, a + 1, b - 1, b, b + 1].filter((n) => n >= 0 && n <= 0xffffffff).map(v4);
}).concat(['8.8.8.8', '1.1.1.1', '192.0.78.9', '169.254.169.254', '93.184.215.14']));

const hex4 = (s) => { const [a, b, c, d] = s.split('.').map(Number); return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)]; };
const V6_SPECIAL = [
  '::', '::1', '::0', '0::0', '0:0:0:0:0:0:0:1', '::2', '::ffff', '::fffe:0:0', '::1:0:0',
  'fe80::1', 'fe80::1%eth0', 'fe80::1%25eth0', 'FE80::1', 'fe9f::1', 'febf:ffff::1', 'fec0::1', 'fbff::1',
  'fc00::1', 'fd12:3456:789a::1', 'fdff:ffff::1', 'ff02::1', 'ff00::', '1fff:ffff::1', '2000::', '2000::1',
  '3fff:ffff::1', '4000::1', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:1::1', '2001:db7::1',
  '2001:db8::1', '2001:DB8:ffff::1', '2001:db9::1', '2002::1', '2002:c0a8:101::1', '2002:808:808::1',
  '2003::1', '2606:4700::1111', '2606:4700:4700::1111', '2606:4700::1111%1', '64:ff9b::808:808',
  '64:ff9b::a00:1', '100::1', '2001:4860:4860::8888', '2001:4860:4860:0:0:0:0:8888',
  '2001:4860:4860:0000:0000:0000:0000:8888', '2001:4860:4860::8888:', ':2001:4860::1', '2001:::1',
  '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7::', '::1:2:3:4:5:6:7', '1::2::3', '12345::1',
  'g::1', '::ffff:1.2.3', '::ffff:1.2.3.4.5', '::ffff:01.2.3.4', '::ffff:256.1.1.1', '1:2:3:4:5:6::1.2.3.4',
  '1:2:3:4:5:6:1.2.3.4', '::01.2.3.4', '::1.2.3.4:1', '[::1]', ' ::1', '::1 ',
];
const V6_V4 = v4Edges.flatMap((a) => {
  const [h, l] = hex4(a);
  return [`::ffff:${a}`, `::FFFF:${a}`, `::ffff:${h}:${l}`, `0:0:0:0:0:ffff:${h}:${l}`, `::${a}`, `::${h}:${l}`,
    `64:ff9b::${h}:${l}`, `2002:${h}:${l}::1`, `::ffff:0:${a}`];
});
const ADDR_JUNK = ['', ' ', '8.8.8.8 ', ' 8.8.8.8', '08.8.8.8', '8.8.8.08', '8.8.8', '8.8.8.8.8', '256.1.1.1',
  '1.1.1.-1', '0x8.8.8.8', '2130706433', '0177.0.0.1', '127.1', '1e2.1.1.1', '+1.1.1.1', '1.1.1.1/32',
  'localhost', 'example.com', 'metadata.google.internal', '8.8.8.8\n', '\u0038.8.8.8', '８.８.８.８', 'null'];

const addresses = uniq([...v4Edges, ...V6_SPECIAL, ...V6_V4, ...ADDR_JUNK]);

// --- hosts in URL encodings ------------------------------------------------------------------
function v4Forms(a) {
  const n = v4n(a);
  const parts = a.split('.').map(Number);
  const out = [a, String(n), `0x${n.toString(16)}`, `0X${n.toString(16).toUpperCase()}`, `0${n.toString(8)}`,
    parts.map((p) => `0x${p.toString(16)}`).join('.'), parts.map((p) => `0${p.toString(8)}`).join('.'),
    `${parts[0]}.${(n & 0xffffff) >>> 0}`, `${parts[0]}.${parts[1]}.${n & 0xffff}`, `${a}.`,
    parts.map((p, i) => (i % 2 ? `0x${p.toString(16)}` : String(p))).join('.'),
    parts.map((p) => `%3${String(p).split('').join('%3')}`).join('.'),
    `${a}..`, `00${parts[0]}.${parts.slice(1).join('.')}`, `${a}.0`];
  return out;
}
const v4Hosts = uniq(v4Edges.flatMap(v4Forms));
const v6Hosts = uniq([...V6_SPECIAL, ...V6_V4.filter((_, i) => i % 3 === 0)].map((s) => `[${s}]`)
  .concat(['[::1', '::1]', '[::1]]', '[[::1]]', '[::1%25lo]', '[0:0::1]', '[0000:0000:0000:0000:0000:0000:0000:0001]']));
const NAME_HOSTS = ['example.com', 'EXAMPLE.com', 'a.example', 'sub.a.example', 'localhost', 'LOCALHOST.',
  'localhost.localdomain', 'metadata.google.internal', 'METADATA.GOOGLE.INTERNAL', 'metadata.google.internal.',
  'metadata.google.internal..', 'metadata.google.internal.example', 'xmetadata.google.internal', 'metadata',
  'example.com.', 'example.com..', 'a..example', '.example.com', 'xn--bcher-kva.example', 'XN--bcher-kva.example',
  'bücher.example', 'ex%61mple.com', 'ex%2ample.com', 'exa mple.com', 'exa_mple.com', 'a-b.example', '-a.example',
  'a.1', '1.a', 'a.0x1', '0x.example', 'example.0x', 'example.09', 'example.08', 'host.docker.internal',
  'nip.io', '10.0.0.1.nip.io', '127.0.0.1.example', 'a'.repeat(63) + '.example', 'a'.repeat(64) + '.example',
  'ＥＸＡＭＰＬＥ.com', 'example。com', '１２７.０.０.１', '８.８.８.８', 'example.com%00', 'exa\u00admple.com',
  'a@b', 'a:b', 'a#b', 'a?b', 'a/b', 'a\\b', 'a<b', 'a^b', 'a|b', 'a%b', '%', '%zz.example', '\u0000a', 'a\u0007b'];

const SCHEMES = ['http', 'https', 'HTTP', 'hTtPs', 'ftp', 'ws', 'wss', 'file', 'gopher', 'data', 'javascript', 'http+x', ''];
const SEPS = ['://', ':/', ':', ':\\\\', ':///', '://\\', ':/\\', ':\\/', ': //'];
const USERS = ['', 'u@', 'u:p@', ':p@', '@', ':@', '8.8.8.8@', '10.0.0.1@', 'a@b@', 'u%40x@', 'user:pa%3Ass@', 'u:@'];
const PORTS = ['', ':', ':80', ':443', ':0', ':65535', ':65536', ':08080', ':-1', ':a', ':80:80', ':1e3', ':\t80'];
const TAILS = ['', '/', '/x?y=1#f', '?q', '#f', '\\@10.0.0.1/', '?@10.0.0.1', '/@10.0.0.1', '#@10.0.0.1', '\\x', '/%2e%2e/'];

function fixedUrls() {
  const out = [];
  for (const h of [...v4Hosts, ...v6Hosts, ...NAME_HOSTS]) out.push(`http://${h}/`);
  for (const h of ['8.8.8.8', '10.0.0.1', '[2606:4700::1111]', '[::1]', 'example.com']) {
    for (const s of SCHEMES) out.push(`${s}://${h}/`);
    for (const s of SEPS) out.push(`http${s}${h}/`);
    for (const u of USERS) out.push(`http://${u}${h}/`);
    for (const p of PORTS) out.push(`https://${h}${p}/`);
    for (const t of TAILS) out.push(`http://${h}${t}`);
  }
  out.push('', ' ', 'http', 'http:', 'http://', 'http:///', 'http://[]/', 'http://@/', 'http://:80/', '//8.8.8.8/',
    '8.8.8.8', '/x', 'http://8.8.8.8\t/', ' http://8.8.8.8/ ', '\thttp://10.0.0.1/', 'ht\ttp://10.0.0.1/',
    'http://10.0\n.0.1/', 'http://1\r0.0.0.1/', '\u0000http://8.8.8.8/', 'http://8.8.8.8/\u0000',
    'http://8.8.8.8:80@10.0.0.1/', 'http://10.0.0.1#@8.8.8.8/', 'http://10.0.0.1?@8.8.8.8/',
    'http://8.8.8.8%2f@10.0.0.1/', 'http://8.8.8.8%40@10.0.0.1/', 'http://[::1]:80/', 'http://[::1]80/',
    'http://127.0.0.1/', 'http://127.0.0.1:9/', 'http://127.1/', 'http://0x7f000001/', 'http://[::ffff:127.0.0.1]/',
    'http://127.0.0.2/', 'http://u@127.0.0.1/', 'http://localhost/', 'https://127.0.0.1/', 'http://0/',
    'http://0.0.0.0/', 'http://4294967295/', 'http://4294967296/', 'http://99999999999999999999/',
    'http://0x/', 'http://0x.0x.0x.0x/', 'http://00/', 'http://08/', 'http://1.2.3.4.5/', 'http://1.2.3.256/',
    'http://1.2.65536/', 'http://1.16777216/', 'http://1.16777215/');
  return out;
}

function fuzzUrls(count) {
  const hosts = [...v4Hosts, ...v6Hosts, ...NAME_HOSTS];
  const out = [];
  for (let i = 0; i < count; i++) {
    let u = `${pick(SCHEMES)}${pick(SEPS)}${pick(USERS)}${pick(hosts)}${pick(PORTS)}${pick(TAILS)}`;
    if (rnd() < 0.05) u = ` ${u}`;
    if (rnd() < 0.05) u = `${u}\u0001`;
    if (rnd() < 0.05) { const k = Math.floor(rnd() * u.length); u = `${u.slice(0, k)}\t${u.slice(k)}`; }
    out.push(u);
  }
  return out;
}

// --- running the JS with the network replaced ------------------------------------------------
const stripBrackets = (h) => h.replace(/^\[|\]$/g, '');
let looked = null;
dns.promises.lookup = async (hostname) => { looked = hostname; return []; };
let connected = null;
const NOT_CONNECTING = Symbol('not connecting');
const fakeRequest = (opts) => { connected = opts.hostname; throw NOT_CONNECTING; };
http.request = fakeRequest;
https.request = fakeRequest;
const failResolve = (_h, _o, cb) => cb(Object.assign(new Error('no dns here'), { code: 'ENOTFOUND' }));
const fetchers = {
  false: createPublicFetch({ resolve: failResolve }),
  true: createPublicFetch({ resolve: failResolve, allowLoopbackLiteral: true }),
};

async function checkVerdict(url) {
  looked = null;
  const ok = await isPublicUrl(url);
  if (looked !== null) {
    if (ok) throw new Error(`isPublicUrl allowed ${JSON.stringify(url)} with no DNS answer`);
    return { ok: true, kind: 'name', host: looked };
  }
  if (!ok) return { ok: false };
  return { ok: true, kind: 'ip', host: stripBrackets(new URL(url).hostname) };
}

async function fetchVerdict(url, loopback) {
  connected = null;
  try {
    await fetchers[loopback](url);
  } catch (err) {
    if (err === NOT_CONNECTING) return { ok: true, kind: net.isIP(connected) ? 'ip' : 'name', host: connected };
    if (err && err.code === 'EPRIVATEADDR') return { ok: false, reason: 'private_address' };
    if (err && err.code === 'ERR_INVALID_URL') return { ok: false, reason: 'unparseable' };
    if (err instanceof TypeError && /is not http\(s\)$/.test(err.message)) return { ok: false, reason: 'scheme' };
    if (err instanceof TypeError && /credentials in the URL$/.test(err.message)) return { ok: false, reason: 'credentials' };
    throw err;
  }
  throw new Error(`publicFetch resolved for ${JSON.stringify(url)}`);
}

async function main() {
  const urls = uniq([...fixedUrls(), ...fuzzUrls(2500)]);
  const rows = [];
  for (const url of urls) {
    for (const loopback of [false, true]) {
      // The loopback exemption only changes publicFetch, and only for a few hosts: keep both rows
      // only where the QA switch is plausibly in play.
      if (loopback && !/127|0x7f|2130706433|0177|localhost|::1/i.test(url)) continue;
      rows.push({ url, loopback, check: await checkVerdict(url), fetch: await fetchVerdict(url, loopback) });
    }
  }
  const out = {
    version: 1,
    limits: { maxUrlBytes: 64 * 1024, maxAddresses: 512, maxInputBytes: 128 * 1024 },
    addresses: addresses.map((address) => ({ address, private: isPrivateIp(address) })),
    urls: rows,
  };
  process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
}

main().catch((err) => { process.stderr.write(`${err?.stack || err}\n`); process.exit(1); });
