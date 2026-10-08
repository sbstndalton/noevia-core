#!/usr/bin/env node
'use strict';
// Regenerates the shared differential fixtures for the SigV4 signer and the region rule.
// Expectations come from the JS references (server/s3-sign.cjs signS3Parts, server/s3-region.cjs
// normalizeS3Region). The same file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/s3-sign/tests/fixtures/s3-sign.v1.json); noevia-core CI compares them.
//   node tools/gen-s3-sign-fixtures.cjs > tests/fixtures/s3-sign.v1.json
// Every key, token, host and path below is made up (the AKIA…/wJalr… pair is AWS's published
// documentation example). No real credential or storage content.
//
// Each case lists the inputs exactly as server/dav-parse-wasm.cjs s3Sign hands them to the module:
// url.host, url.pathname, url.searchParams pairs, the payload and secret as bytes (Buffer.from of
// the JS value), the method as UTF-8. A case whose JS output holds a lone surrogate (an amzDate cut
// inside a surrogate pair) cannot be carried as UTF-8; the port refuses it ("refused": "input").
// canonicalRequest/stringToSign are recorded as the text that is hashed (UTF-8, lone surrogates
// as U+FFFD, which is what Buffer.from and TextEncoder both produce). `headers` is the returned
// object's entries, in order.

const { signS3Parts } = require('../server/s3-sign.cjs');
const { normalizeS3RegionJs: normalizeS3Region } = require('../server/s3-region.cjs');

let seed = 0x5195;
const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const int = (n) => Math.floor(rand() * n);

const AK = 'AKIAIOSFODNN7EXAMPLE';
const SK = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const DATE = '20130524T000000Z';
const wellFormed = (s) => typeof s !== 'string' || s.isWellFormed();

const cases = [];
/** `target` is a URL string or a URL-like { host, pathname, search } for pathnames no URL yields. */
function add(name, { method = 'GET', target, payload = '', accessKey = AK, secretKey = SK, region = '', sessionToken = '', amzDate = DATE }) {
  const url = typeof target === 'string' ? new URL(target) : { host: target.host, pathname: target.pathname, searchParams: new URLSearchParams(target.search || '') };
  const query = [...url.searchParams.entries()];
  const payloadBytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const c = {
    name,
    method: Buffer.from(method).toString('utf8'),
    host: url.host,
    pathname: url.pathname,
    query,
    payloadHex: payloadBytes.toString('hex'),
    accessKey,
    secretHex: Buffer.from(`${secretKey}`).toString('hex'),
    region,
    sessionToken,
    amzDate,
  };
  const parts = signS3Parts(method, url, payload, accessKey, secretKey, { region, sessionToken, amzDate });
  const out = Object.values(parts.headers);
  // The canonical request and string to sign are hashed as UTF-8 (a lone surrogate as U+FFFD).
  if (!out.every(wellFormed)) c.refused = 'input';
  else c.expect = { canonicalRequest: parts.canonicalRequest.toWellFormed(), stringToSign: parts.stringToSign.toWellFormed(), signature: parts.signature, headers: Object.entries(parts.headers) };
  cases.push(c);
}

// ── the requests core sends ──
add('probe listing (matches the Python signer)', { target: 'https://s3.example.com/diary-bucket?list-type=2&max-keys=1' });
add('listing page', { target: 'https://s3.example.com/diary-bucket?list-type=2&prefix=Cowork%2Fnotes%2F&delimiter=%2F&max-keys=1000' });
add('continuation token', { target: 'https://s3.example.com/diary-bucket?list-type=2&prefix=a&continuation-token=1%2FAbc%2BDef%3D%3D' });
add('object read', { target: `https://s3.example.com/diary-bucket/Cowork/${encodeURIComponent('notes (1).md')}`, region: 'eu-central-1' });
add('backup PUT', { method: 'PUT', target: 'https://backup.example.net:9000/b/noevia-backup/chunks/ab12', payload: Buffer.from('month contents'), region: 'auto' });
add('backup DELETE', { method: 'DELETE', target: 'http://127.0.0.1:9000/b/noevia-backup/manifest.json' });
add('binary payload', { method: 'PUT', target: 'https://s3.example.com/b/k', payload: Buffer.from(Array.from({ length: 256 }, (_, i) => i)) });
add('string payload, non-ASCII', { method: 'PUT', target: 'https://s3.example.com/b/k', payload: 'Grüße 👋' });
add('string payload, lone surrogate', { method: 'PUT', target: 'https://s3.example.com/b/k', payload: 'a\ud800b' });
add('session token', { target: 'https://s3.example.com/b', sessionToken: 'FQoGZXIvYXdzEXAMPLE//token+=' });
add('session token, padded', { target: 'https://s3.example.com/b', sessionToken: ' \t tok \n' });
add('session token, JS-only whitespace', { target: 'https://s3.example.com/b', sessionToken: '﻿tok　' });
add('session token, not JS whitespace', { target: 'https://s3.example.com/b', sessionToken: '\u0085tok​' });
add('session token, only whitespace', { target: 'https://s3.example.com/b', sessionToken: '  ' });
add('access key that needs JSON escaping', { target: 'https://s3.example.com/b', accessKey: 'a"b\\c\u0001 d' });
add('empty access key and secret', { target: 'https://s3.example.com/b', accessKey: '', secretKey: '' });
add('non-ASCII secret', { target: 'https://s3.example.com/b', secretKey: 'sécrêt-🔑' });
add('lone surrogate secret', { target: 'https://s3.example.com/b', secretKey: 'x\udc00y' });
add('lowercase method', { method: 'get', target: 'https://s3.example.com/b' });
add('odd method', { method: 'Mé\ud800', target: 'https://s3.example.com/b' });
add('host with port and IDN', { target: 'https://BÜCHER.example:8443/b' });
add('IPv6 host', { target: 'http://[::1]:9000/b' });
add('default port dropped', { target: 'https://s3.example.com:443/b' });

// ── canonical URI ──
for (const [n, p] of [
  ['reserved characters', "/b/it's*!.md"], ['encoded slash', '/b/a%2Fb.md'], ['stray percent', '/b/100%.md'],
  ['bad escape', '/b/%zz/%4'], ['invalid UTF-8 escape', '/b/%FF%C3/%C3%28'], ['encoded surrogate', '/b/%ED%A0%80'],
  ['overlong escape', '/b/%C0%AF'], ['lower-case escape', '/b/%c3%a9'], ['raw unicode', '/b/é/😀'],
  ['empty pathname', ''], ['root', '/'], ['double slashes', '//b//k/'], ['tilde and unreserved', '/b/-_.~AZaz09'],
  ['every ASCII', `/${Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('').replace(/\//g, '')}`],
  ['plus and space', '/b/a+b c'], ['percent-encoded unreserved', '/b/%41%7E%2D'],
]) add(`path: ${n}`, { target: { host: 's3.example.com', pathname: p } });

// ── canonical query ──
for (const [n, q] of [
  ['duplicate keys sort by value', '?a=2&a=1&a=10'], ['empty values and keys', '?=x&a=&b'], ['encoded keys', '?a%20b=1&%C3%BC=2&*=3&~=4'],
  ['plus is space', '?q=a+b'], ['equals in value', '?k=a%3Db'], ['UTF-16 order (astral before U+FFFD)', '?%EF%BF%BD=1&%F0%9F%98%80=2&%EE%80%80=3'],
  ['upper before lower', '?b=1&B=2&a=3'], ['reserved in value', "?v=!'()*"], ['bad escape stays literal', '?v=%zz&w=%E2%82'],
]) add(`query: ${n}`, { target: { host: 's3.example.com', pathname: '/b', search: q } });

// ── region and date ──
add('region empty means us-east-1', { target: 'https://s3.example.com/b', region: '' });
add('region verbatim (not normalised here)', { target: 'https://s3.example.com/b', region: 'EU West 1' });
add('date short', { target: 'https://s3.example.com/b', amzDate: '2013' });
add('date non-ASCII', { target: 'https://s3.example.com/b', amzDate: '2013052€T000000Z' });
add('date astral after the stamp', { target: 'https://s3.example.com/b', amzDate: '20130524😀' });
add('date astral cut by the stamp', { target: 'https://s3.example.com/b', amzDate: '2013052😀T000000Z' });
add('date padded', { target: 'https://s3.example.com/b', amzDate: ' 20130524T000000Z ' });

// ── seeded random requests ──
const segs = ['a', 'Cowork', 'notes (1).md', "it's", 'ü', '😀', '100%', 'a b', '%41', '~x', '', 'a+b', '*', 'é.txt'];
const keys = ['list-type', 'prefix', 'max-keys', 'continuation-token', 'delimiter', 'a', 'A', 'ü', '😀', '', 'x y'];
const vals = ['2', '', 'Cowork/', '/', 'a+b=c', '😀', 'ü', '1000', "!'()*", '%'];
for (let i = 0; i < 120; i++) {
  const path = `/${Array.from({ length: 1 + int(4) }, () => encodeURIComponent(pick(segs))).join('/')}`;
  const search = new URLSearchParams();
  for (let j = int(5); j > 0; j--) search.append(pick(keys), pick(vals));
  add(`random ${i}`, {
    method: pick(['GET', 'PUT', 'DELETE', 'HEAD']),
    target: `${pick(['https://s3.example.com', 'http://127.0.0.1:9000', 'https://minio.example.org:8443'])}${path}?${search}`,
    payload: Buffer.from(Array.from({ length: int(40) }, () => int(256))),
    accessKey: pick([AK, 'AK', 'garage-key-id']),
    secretKey: pick([SK, 'SK', 'synthetic-secret-0123456789']),
    region: pick(['', 'us-east-1', 'eu-west-2', 'garage']),
    sessionToken: pick(['', '', 'tok', ' tok ']),
    amzDate: `2026${String(1 + int(12)).padStart(2, '0')}${String(1 + int(28)).padStart(2, '0')}T${String(int(24)).padStart(2, '0')}0000Z`,
  });
}

const regions = ['', 'us-east-1', ' EU-West-1 ', 'us_east_1', 'a'.repeat(32), 'a'.repeat(33), 'Ka', 'İ', '﻿eu-west-1　',
  '\u0085eu-west-1', 'eu-west-1​', 'ΣΑ', 'garage', '-', '0', 'a b', 'ＥＵ', 'auto', ' auto ', 'ſ3'].map((input) => ({ input, expect: normalizeS3Region(input) }));

const out = {
  version: 1,
  generator: 'noevia-core tools/gen-s3-sign-fixtures.cjs (expectations from server/s3-sign.cjs signS3Parts and server/s3-region.cjs normalizeS3Region)',
  cases,
  regions,
};
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
