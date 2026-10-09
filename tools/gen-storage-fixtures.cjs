#!/usr/bin/env node
'use strict';
// Regenerates the shared differential fixtures for the S3 listing scan (#976) and the storage path
// rules (#978). Expectations come from the JS references (tests/server/oracle/s3-listing.cjs s3PageRecordsJs,
// server/storage-path.cjs *Js). The same files are committed byte-for-byte in sbstndalton/noevia-rs
// (crates/s3-list-parse/tests/fixtures/s3-list.v1.json, crates/storage-path/tests/fixtures/
// storage-path.v1.json); noevia-core CI compares them.
//   node tools/gen-storage-fixtures.cjs s3 > tests/fixtures/s3-list.v1.json
//   node tools/gen-storage-fixtures.cjs path > tests/fixtures/storage-path.v1.json
// Every bucket, key, host and path below is made up. No real storage content.

const { s3PageRecordsJs } = require('../tests/server/oracle/s3-listing.cjs');
const { safeRelativePathJs, cleanRootJs, joinRootJs, isPlainFilenameJs } = require('../server/storage-path.cjs');

const which = process.argv[2];
let seed = which === 's3' ? 0x976 : 0x978;
const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const pick = (a) => a[Math.floor(rand() * a.length)];

function s3Cases() {
  const cases = [];
  const add = (name, body, prefix = 'docs/') => cases.push({ name, prefix, body });
  const lb = (...parts) => `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>example-bucket</Name>${parts.join('')}</ListBucketResult>`;
  const obj = (key, size = '12') => `<Contents><Key>${key}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>${size}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
  const pre = (p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`;
  const page = (truncated, token) => `<IsTruncated>${truncated}</IsTruncated>${token === undefined ? '' : `<NextContinuationToken>${token}</NextContinuationToken>`}`;

  // ── ordinary pages ──
  add('ordinary page', lb(`<Prefix>docs/</Prefix>`, page('false'), obj('docs/a.md', '120'), obj('docs/b.txt', '0'), pre('docs/Sub/'), pre('docs/Other/')));
  add('whole bucket', lb(page('false'), obj('a.md'), obj('dir/b.md'), pre('dir/')), '');
  add('empty page', lb(page('false')));
  add('empty body', '');
  add('not xml', '{"Contents":[]}');
  add('truncated with token', lb(page('true', 'tok-1'), obj('docs/a.md')));
  add('truncated, upper case', lb(page(' TRUE\n', 'tok-2'), obj('docs/a.md')));
  add('truncated without token', lb(page('true'), obj('docs/a.md')));
  add('not truncated but token', lb(page('false', 'tok-3'), obj('docs/a.md')));
  add('truncated, odd values', lb(page('yes', 't'), page('true', 'second')));
  add('empty token', lb(page('true', '')));
  add('token with entities', lb(page('true', '1/a+b&amp;c&#61;&#x3D;&lt;'), obj('docs/a.md')));
  add('non-advancing token (same as the request)', lb(page('true', 'tok-1'), obj('docs/a.md')));
  add('token of whitespace', lb(page('true', '  ')));
  add('istruncated inside a key', lb(obj('docs/<IsTruncated>true</IsTruncated>'), page('false')));
  add('two istruncated, first wins', lb(page('false', 'a'), page('true', 'b')));
  // ── keys and prefixes ──
  add('entities in keys', lb(obj('docs/a&amp;b.md'), obj('docs/&lt;x&gt;.md'), obj('docs/&quot;q&apos;.md'), obj('docs/&#233;t&#xE9;.md'), obj('docs/&unknown;.md'), obj('docs/&#0;.md'), obj('docs/&#xD800;.md'), obj('docs/&#x110000;.md'), obj('docs/&amp;amp;.md')));
  add('entities in prefixes', lb(pre('docs/a&amp;b/'), pre('docs/&#47;slash/'), pre('docs/x&#x2F;y/')));
  add('encoded slash entity adds a level', lb(obj('docs/a&#47;b.md'), obj('docs/a&#x2f;b.md')));
  add('nested keys under the prefix', lb(obj('docs/sub/deep.md'), obj('docs/sub/deeper/x.md'), obj('docs/top.md'), pre('docs/sub/'), pre('docs/sub/deeper/')));
  add('keys outside the prefix', lb(obj('other/a.md'), obj('plain.md'), obj('docsX/a.md'), pre('other/'), pre('docsX/')));
  add('prefix equal to the query prefix', lb(pre('docs/'), pre('docs//'), obj('docs/')));
  add('key equal to the prefix minus slash', lb(obj('docs'), pre('docs')));
  add('folder markers skipped', lb(obj('docs/folder/'), obj('docs/folder//'), obj('docs/a.md')));
  add('dot segments and traversal keys', lb(obj('docs/..'), obj('docs/.'), obj('docs/../etc/passwd'), obj('docs/%2e%2e'), pre('docs/../'), pre('docs/./')));
  add('backslashes and controls', lb(obj('docs/a\\b.md'), obj('docs/\u0001ctl'), obj('docs/tab\there'), obj('docs/nul&#1;'), pre('docs/\u001b[31m/')));
  add('bidi and unicode', lb(obj('docs/\u202egnp.exe'), obj('docs/caf\u00e9.md'), obj('docs/\ud83d\ude00.md'), obj('docs/ﬀ.md'), obj('docs/İ.md')));
  add('whitespace around keys kept', lb(obj(' docs/a.md'), obj('docs/ b.md '), obj('docs/\n')));
  add('prefix with unicode', lb(obj('été/a.md'), pre('été/sub/')), 'été/');
  add('prefix with entity-looking text', lb(obj('a&amp;b/x.md'), obj('a&b/y.md')), 'a&b/');
  add('deep query prefix', lb(obj('r/o/o/t/a.md'), pre('r/o/o/t/s/')), 'r/o/o/t/');
  // ── sizes ──
  add('huge and odd sizes', lb(obj('docs/a', '99999999999999999999999'), obj('docs/b', '007'), obj('docs/c', ''), obj('docs/d', '-1'), obj('docs/e', '1e3'), obj('docs/f', ' 5'), obj('docs/g', '5\n'), obj('docs/h', '١٢'), obj('docs/i', '0x10'), obj('docs/j', '9007199254740993')));
  add('size missing', lb('<Contents><Key>docs/nosize</Key></Contents>'));
  add('two sizes, first wins', lb('<Contents><Key>docs/two</Key><Size>x</Size><Size>3</Size></Contents>'));
  // ── malformed markup ──
  add('unclosed contents', lb(obj('docs/a.md'), '<Contents><Key>docs/b.md</Key><Size>1</Size>'));
  add('unclosed key', lb('<Contents><Key>docs/a.md</Contents>', obj('docs/b.md')));
  add('unclosed everything', '<ListBucketResult><Contents><Key>docs/a<CommonPrefixes><Prefix>docs/p/');
  add('nested contents', lb('<Contents><Contents><Key>docs/in.md</Key></Contents></Contents>'));
  add('namespace prefixes', '<s3:ListBucketResult><s3:Contents><s3:Key>docs/ns.md</s3:Key><s3:Size>4</s3:Size></s3:Contents><x:CommonPrefixes><y:Prefix>docs/nsdir/</z:Prefix></x:CommonPrefixes><s3:IsTruncated>true</s3:IsTruncated><s3:NextContinuationToken>ns</s3:NextContinuationToken></s3:ListBucketResult>');
  add('lower-case tags do not match', lb('<contents><key>docs/lc.md</key></contents>'));
  add('attributes do not match', lb('<Contents id="1"><Key>docs/attr.md</Key></Contents>', '<Contents><Key x="y">docs/attr2.md</Key></Contents>'));
  add('cdata is not decoded', lb(obj('docs/<![CDATA[x]]>')));
  add('doctype and entity declarations are inert', `<!DOCTYPE x [<!ENTITY e "docs/evil.md"><!ENTITY big SYSTEM "file:///etc/passwd">]><ListBucketResult>${obj('&e;')}${obj('docs/&big;')}</ListBucketResult>`);
  add('many unclosed opening tags', '<Contents>'.repeat(2000) + '<Key>docs/x</Key>');
  add('many keys', lb(...Array.from({ length: 300 }, (_, i) => obj(`docs/k${i}.md`, String(i)))));
  add('comment hides nothing', lb('<!-- <Contents><Key>docs/c.md</Key></Contents> -->'));

  // ── seeded random pages ──
  const pieces = ['a', 'b', '.', '..', '/', '//', '\\', '%2e', '%2F', '&amp;', '&lt;', '&#47;', '&#x2F;', '&#0;', '&#xD800;', '&x;', '&', ';', '#', ' ', '\t', '\n', 'é', '😀', '\ud800', '‮', 'İ', 'ﬀ', 'docs', 'docs/', 'Sub/', '<', '>', '</Key>', '<Key>', '\u0000', '\u0085', '\u00a0', '﻿'];
  const prefixes = ['docs/', 'docs/', '', 'été/', 'a&b/', 'docs/sub/', '/', 'x'];
  const tp = ['', '', '', 's3:', 'x-y:', 'S:'];
  for (let n = 0; n < 500; n++) {
    const prefix = pick(prefixes);
    const parts = [];
    for (let b = Math.floor(rand() * 7); b > 0; b--) {
      let name = rand() < 0.6 ? prefix : '';
      for (let i = 1 + Math.floor(rand() * 5); i > 0; i--) name += pick(pieces);
      const p = pick(tp);
      const close = rand() < 0.95;
      if (rand() < 0.35) parts.push(`<${p}CommonPrefixes><${pick(tp)}Prefix>${name}</${pick(tp)}Prefix>${close ? `</${p}CommonPrefixes>` : ''}`);
      else parts.push(`<${p}Contents><${p}Key>${name}${rand() < 0.95 ? `</${pick(tp)}Key>` : ''}${rand() < 0.7 ? `<Size>${pick(['1', '42', '007', '', 'x', '-1', '99999999999999999999', ' 3'])}</Size>` : ''}${close ? `</${p}Contents>` : ''}`);
    }
    if (rand() < 0.5) parts.splice(Math.floor(rand() * (parts.length + 1)), 0, page(pick(['true', 'false', 'TRUE', ' true ', '', 'True\n']), rand() < 0.7 ? pick(['t1', '', 'a&amp;b', '&#x2F;', ' ', 'tok-1', '\ud800']) : undefined));
    add(`random ${n}`, lb(...parts), prefix);
  }
  return cases.map(({ name, prefix: rawPrefix, body: rawBody }) => {
    const body = rawBody.toWellFormed(), prefix = rawPrefix.toWellFormed();
    return { name, prefix, body, expect: s3PageRecordsJs(body, prefix) };
  });
}

function pathCases() {
  const cases = [];
  const add = (name, op, a, b) => cases.push(b === undefined ? { name, op, a } : { name, op, a, b });
  const rel = (name, a) => add(name, 'safeRelativePath', a);
  // ── safeRelativePath ──
  rel('plain', 'a/b.md');
  rel('empty', '');
  rel('whitespace only', ' \t\n ');
  rel('trimmed', '  a/b.md \n');
  rel('js whitespace trimmed', '\u00a0\u2028a\ufeff\u3000');
  rel('leading slash', '/abs.md');
  rel('leading slash after trim', '  /abs.md');
  rel('leading backslash', '\\abs.md');
  rel('backslashes become slashes', 'a\\b\\c.md');
  rel('mixed separators', 'a\\/b//\\c');
  rel('dot dot', '..');
  rel('dot dot escape', '../escape.md');
  rel('dot dot inside', 'a/../../escape.md');
  rel('dot dot backslash', 'a\\..\\..\\x');
  rel('dot', './ok.md');
  rel('trailing dot dot', 'a/b/..');
  rel('triple dot is a name', 'a/.../b');
  rel('dotted names', '.hidden/..x/x..');
  rel('percent dot dot stays literal', '%2e%2e/x');
  rel('upper percent dot dot', '%2E%2E/%2e/x');
  rel('percent slash stays literal', 'a%2Fb/%5C');
  rel('double percent', '%252e%252e');
  rel('NUL', 'a\u0000b');
  rel('NUL alone', '\u0000');
  rel('NUL segment', 'a/\u0000/b');
  rel('controls', 'a\u0001b/\u001f/\u007f/\u0085');
  rel('tab inside', 'a\tb');
  rel('newline inside', 'a\nb/c');
  rel('empty segments', 'a//b///c/');
  rel('only slashes', '///');
  rel('trailing slash', 'a/b/');
  rel('windows drive', 'C:\\Users\\x\\a.md');
  rel('windows drive forward', 'c:/x');
  rel('UNC', '\\\\server\\share\\x');
  rel('device path', '\\\\?\\C:\\x');
  rel('unicode look-alike dots', '\u2024\u2024/x');
  rel('fullwidth dots and solidus', '\uff0e\uff0e\uff0fx');
  rel('fraction slash and division slash', 'a\u2044b\u2215c');
  rel('one dot leader', '\u2024/x');
  rel('combining dot', '.\u0307./x');
  rel('bidi', 'a\u202eb/\u2066c');
  rel('emoji', '😀/😀.md');
  rel('lone surrogate', 'a\ud800b');
  rel('500 chars', 'a'.repeat(500));
  rel('501 chars', 'a'.repeat(501));
  rel('500 after trim', ` ${'a'.repeat(500)} `);
  rel('250 emoji is 500 units', '😀'.repeat(250));
  rel('251 emoji', '😀'.repeat(251));
  rel('500 chars with dot dot', `${'a'.repeat(497)}/..`);
  rel('long segment list', Array.from({ length: 200 }, () => 'a').join('/'));
  rel('query-like', 'a?b=c#d');
  rel('url', 'https://example.test/x');
  rel('tilde', '~/x');
  // ── cleanRoot ──
  for (const r of ['', '/', '//', 'root', '/root/', '//root//', 'a/b/c', '/a//b/', ' /a/ ', '\\a\\', '..', '/../', 'a/../b', '\u0000/a', '/é/', 'C:\\x', '/'.repeat(100), 'x'.repeat(600)]) add(`cleanRoot ${r.length > 40 ? `of ${r.length} units` : JSON.stringify(r)}`, 'cleanRoot', r);
  // ── joinRoot ──
  for (const [r, x] of [['', ''], ['', 'a'], ['root', ''], ['root', 'a/b'], ['/root/', 'a'], ['//', 'a'], ['root', '/a'], ['root/', '/a'], ['a/../b', '../c'], ['root', '\u0000'], ['é', 'ü'], [' r ', ' x '], ['\\r\\', 'x']]) add(`joinRoot ${JSON.stringify([r, x])}`, 'joinRoot', r, x);
  // ── upload filename ──
  for (const f of ['a.md', 'report.final.pdf', '.hidden', '..x', 'x..', '...', '.', '..', '', ' ', 'a/b', 'a\\b', '\u0000', 'a\u0001', 'a\u001f', 'a\u007f', 'a\u0085', 'tab\there', 'new\nline', 'é.md', '😀.png', '\u202egnp.exe', 'CON', 'C:x', 'a:b',
    'a'.repeat(200), 'a'.repeat(201), '😀'.repeat(100), '😀'.repeat(101), `${'a'.repeat(199)}😀`, '\uff0e\uff0e', '\u2024\u2024', '%2e%2e', 'a\ud800']) add(`filename ${f.length > 40 ? `of ${f.length} units` : JSON.stringify(f)}`, 'isPlainFilename', f);

  // ── seeded random ──
  const pieces = ['a', 'b', 'é', '😀', '.', '..', '/', '//', '\\', '%2e', '%2F', '%00', '\u0000', '\u0001', '\u001f', '\u007f', ' ', '\t', '\n', '\u00a0', '\u2028', '\ufeff', ':', 'C:', '~', '\u2024', '\uff0e', '\u202e', '\ud800', '?', '#', '*'];
  const ops = ['safeRelativePath', 'safeRelativePath', 'cleanRoot', 'joinRoot', 'isPlainFilename'];
  for (let n = 0; n < 600; n++) {
    const gen = () => { let s = ''; for (let i = Math.floor(rand() * 12); i > 0; i--) s += pick(pieces); return rand() < 0.03 ? s + 'x'.repeat(480 + Math.floor(rand() * 40)) : s; };
    const op = pick(ops);
    add(`random ${n}`, op, gen(), op === 'joinRoot' ? gen() : undefined);
  }
  const fns = { safeRelativePath: safeRelativePathJs, cleanRoot: cleanRootJs, joinRoot: joinRootJs, isPlainFilename: isPlainFilenameJs };
  return cases.map((c) => {
    const out = { ...c, name: c.name.toWellFormed(), a: c.a.toWellFormed() };
    if (c.b !== undefined) out.b = c.b.toWellFormed();
    out.expect = { value: fns[c.op](out.a, out.b) };
    return out;
  });
}

const out = which === 's3'
  ? { version: 1, generator: 'noevia-core tools/gen-storage-fixtures.cjs s3 (expectations from server/s3-listing.cjs s3PageRecordsJs)', cases: s3Cases() }
  : which === 'path'
    ? { version: 1, generator: 'noevia-core tools/gen-storage-fixtures.cjs path (expectations from server/storage-path.cjs)', cases: pathCases() }
    : null;
if (!out) { console.error('usage: gen-storage-fixtures.cjs s3|path'); process.exit(2); }
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
