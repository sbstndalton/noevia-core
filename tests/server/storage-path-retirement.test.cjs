'use strict';

// #1071 retirement gate for the storage path rules (#978). Production (server/storage-path.cjs) now
// decides with the Rust port in dav-parse.wasm alone; the JS rules the release before ran are the
// oracle (tests/server/oracle/storage-path.cjs, moved unchanged). Both are driven through the public
// functions, with production's JS-side coercions, over a generated hostile corpus: traversal in every
// spelling (encoded, double-encoded, overlong UTF-8 escapes, backslashes, look-alike dots and
// slashes), absolute and drive paths, NUL and controls, symlink-looking names, Unicode that NFC/NFKC
// would change, JS white space, lone surrogates, non-string values, and lengths around the 500-unit
// rule and the 64 KiB argument cap.
//
// Every answer must be the oracle's, except three documented refusals where production says 400
// rather than answer (never the other way round):
//   input:     an argument that is not well-formed UTF-16 (a lone surrogate cannot cross unchanged);
//   too_large: an argument over 64 KiB of UTF-8 (the JS answered '' or a very long string);
//   joinRoot:  a non-string, non-nullish relative part (the JS coerced 7 to '7' and dropped 0/false).
// The rules are lexical: storage is remote (WebDAV, S3), so a symlink is the server's business and
// a name that looks like one is just a name. The corpus holds no real path. Needs dav-parse.wasm.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const oracle = require('./oracle/storage-path.cjs');
const paths = require('../../server/storage-path.cjs');
const storageClient = require('../../server/storage-client.cjs');
const davParseWasm = require('../../server/dav-parse-wasm.cjs');

const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const CAP = 64 * 1024;

const TRAVERSAL = ['..', '../', '../x', 'a/..', 'a/../b', './a', 'a/./b', '.', './', '...', '....', '.../x', 'a/.../b', '..\\x', 'a\\..\\b', '\\..\\', '/..', '//..//',
  '.. ', ' ..', '..\t', '\t..', '\u00a0..\u00a0', '..\ufeff', '\ufeff..', '\u3000..\u3000', '%2e%2e', '%2e%2e/x', '%2e%2e%2fx', '..%2f', '..%5c', '%252e%252e%252f', '%c0%ae%c0%ae/',
  '.%2e/', '%2e./', '%2F', 'a%2f..%2fb', 'a/%2e%2e/b', '\uff0e\uff0e/x', '\u2024\u2024/x', '\u2025/x', 'a\u2215..\u2215b', 'a\u2044b', 'a\uff0fb', 'a\uff3cb', 'a\u29f5b', 'a\ufe68b', '\u202e..'];
const ABSOLUTE = ['/', '//', '/etc/passwd', '//server/share', '\\\\server\\share', '\\x', 'C:\\x', 'C:/x', 'c:', 'C:', 'file:///etc', 'http://h.invalid/x', '~/x', '~root/x', '\\\\?\\C:\\x', '\\\\.\\pipe\\x'];
const CONTROL = ['\0', 'a\0', 'a\0/../b', '\0/x', 'x/\0', 'a\u0001b', 'a\nb', 'a\rb', 'a\tb', '\x7f', 'a\u0085b', 'a\u2028b', 'a\u2029b', 'a\u200bb', 'a\u180eb', 'a\u2060b', '\u200b', '\u180e'];
const SYMLINKISH = ['link -> ../etc', 'a/link@', 'x/.git/../../y', '.git', '.ssh/id', 'a/.hidden', 'proc/self/root', 'a/b/c/../../../..'];
const UNICODE = ['e\u0301', '\u00e9', '\ufb01le', '\u212b', '\u00c5', 'A\u030a', '\u1e9e', '\u00df', '\u0130', '\uff41\uff0f\uff42', '\ud83d\ude00', 'caf\u00e9/na\u0131ve', '\u0410\u0430', '\u05d0/\u05d1'];
const SURROGATE = ['a\ud800', '\udc00', '\ud800\udc00', '\udc00\ud800', 'a/\ud800/b', '\ud83d'];
const WHITE = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const SEPARATORS = ['a//b', 'a///b', '/a', 'a/', 'a\\\\b', 'a\\/b', '\\', '/\\/', ' / ', 'a /b', 'a/ b', ' a ', `${WHITE}a${WHITE}`, `${WHITE}/a`, WHITE];
const LENGTHS = [
  'a'.repeat(500), 'a'.repeat(501), 'a/'.repeat(250), `${'a/'.repeat(250)}a`, '\ud83d\ude00'.repeat(250), '\ud83d\ude00'.repeat(251), '\u00e9'.repeat(500), '\u00e9'.repeat(501),
  `${' '.repeat(600)}a`, `${'a'.repeat(499)}\ud83d\ude00`, 'a'.repeat(CAP), 'a'.repeat(CAP + 1), '\u00e9'.repeat(CAP / 2), '\u00e9'.repeat(CAP / 2 + 1),
  '\u20ac'.repeat(21845), '\u20ac'.repeat(21846), `${'../'.repeat(30000)}x`];
const STRINGS = [...TRAVERSAL, ...ABSOLUTE, ...CONTROL, ...SYMLINKISH, ...UNICODE, ...SURROGATE, ...SEPARATORS, ...LENGTHS, '', ' ', 'docs', 'docs/a.md', 'Docs/R&D/a b.md', 'noevia projects/p1/Documents/x.pdf'];
const VALUES = [undefined, null, 0, -0, 1, 42, 1e21, NaN, false, true, [], ['a'], ['a', 'b'], ['..'], {}, { toString: () => '../x' }, { toString: () => 'ok/x' }];

/** What production must answer for `op`: the oracle's value, or the refusal it documents. */
function expected(op, a, b) {
  if (op === 'joinRoot' && b !== undefined && b !== null && typeof b !== 'string') return { error: 'input', class: 'joinRoot' };
  const ca = String(a || ''), cb = op === 'joinRoot' ? (b || '') : '';
  if (!ca.isWellFormed() || !cb.isWellFormed()) return { error: 'input', class: 'input' };
  if (Buffer.byteLength(ca) > CAP || Buffer.byteLength(cb) > CAP) return { error: 'too_large', class: 'too_large' };
  return { value: oracle[`${op}Js`](a, b) };
}

function actual(op, a, b) {
  try { return { value: paths[op](a, b) }; } catch (e) {
    assert.equal(e.message, paths.PUBLIC_FAILURE);
    assert.equal(e.code, 'storage_path_failed');
    assert.equal(e.status, 400, `a refusal is the caller's input (${e.reason})`);
    return { error: e.reason };
  }
}

/** What the output of safeRelativePath may never be, whatever the input. */
function assertSafe(out, why) {
  if (out === '') return;
  assert.ok(!out.startsWith('/') && !out.includes('\\') && !out.includes('\0'), why);
  assert.ok(out.length <= 500 && out.isWellFormed(), why);
  for (const s of out.split('/')) assert.ok(s !== '' && s !== '.' && s !== '..', why);
}

function corpus() {
  let seed = 0x1071978;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const pieces = [...TRAVERSAL, ...CONTROL, ...UNICODE, ...SURROGATE, '/', '//', '\\', 'a', 'b.md', ' ', '\u00a0', '\ufeff', '.', '%2e', '%2f', '%00', WHITE];
  const gen = () => { let s = ''; for (let i = Math.floor(rand() * 8); i > 0; i--) s += pick(pieces); return rand() < 0.02 ? s + 'x'.repeat(480 + Math.floor(rand() * 40)) : s; };
  const out = [];
  for (const a of [...STRINGS, ...VALUES]) {
    out.push(['safeRelativePath', a], ['cleanRoot', a]);
    for (const b of ['', 'x', '/x', '../x', undefined, null, 7, 0, false]) out.push(['joinRoot', a, b]);
  }
  for (const b of [...STRINGS, ...VALUES]) for (const a of ['', '/', 'root', '//root//', 'a/b', '..', '\ud800']) out.push(['joinRoot', a, b]);
  for (let n = 0; n < 8000; n++) {
    const op = pick(['safeRelativePath', 'safeRelativePath', 'cleanRoot', 'joinRoot']);
    out.push(op === 'joinRoot' ? [op, gen(), rand() < 0.1 ? pick(VALUES) : gen()] : [op, rand() < 0.05 ? pick(VALUES) : gen()]);
  }
  return out;
}

test('production (Rust) answers every hostile path exactly as the JS rules did, or refuses where documented', { skip: skipWasm }, (t) => {
  t.mock.method(console, 'warn', () => {});
  davParseWasm.reset();
  const cases = corpus();
  const counts = { same: 0, input: 0, too_large: 0, joinRoot: 0 };
  const jsAnsweredNonEmpty = { input: 0, too_large: 0, joinRoot: 0 };
  const bad = [];
  for (const [op, a, b] of cases) {
    const want = expected(op, a, b);
    const got = actual(op, a, b);
    if (want.class) {
      counts[want.class] += 1;
      if (oracle[`${op}Js`](a, b) !== '') jsAnsweredNonEmpty[want.class] += 1;
      if (got.error !== want.error) bad.push({ op, a: String(a).slice(0, 80), b: String(b).slice(0, 80), want, got });
    } else {
      counts.same += 1;
      if (got.error !== undefined || got.value !== want.value) bad.push({ op, a: String(a).slice(0, 80), b: String(b).slice(0, 80), want, got });
    }
    if (op === 'safeRelativePath' && got.value !== undefined) assertSafe(got.value, `${JSON.stringify(String(a).slice(0, 80))}`);
  }
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} of ${cases.length} cases diverge outside the documented refusals`);
  assert.ok(cases.length >= 10000, `${cases.length} cases`);
  for (const k of ['input', 'too_large', 'joinRoot']) assert.ok(counts[k] > 0, `the corpus reaches the ${k} refusal`);
  console.log(`# storage-path retirement: ${cases.length} hostile cases; ${counts.same} identical to the JS rules; refused instead of answered: ${counts.input} not well-formed (JS answered a non-empty path in ${jsAnsweredNonEmpty.input}), ${counts.too_large} over 64 KiB (${jsAnsweredNonEmpty.too_large}), ${counts.joinRoot} non-string joinRoot parts (${jsAnsweredNonEmpty.joinRoot}); 0 other divergences`);
});

test('a path the live system stored (any non-empty answer of the JS rules) reads back as it did under JS', { skip: skipWasm }, () => {
  // projects.cjs ownsFile requires safeRelativePath(target) === target and project source folders
  // were saved as the JS rule's answers: every such stored value must read back as the JS rule
  // read it. That is unchanged, including one quirk of the JS rule kept on purpose: white space is
  // trimmed from the whole value only, so 'a /' was stored as 'a ', which reads back as 'a'.
  let fixed = 0, quirk = 0;
  const cps = (s) => [...s.slice(0, 40)].map((ch) => ch.codePointAt(0).toString(16)).join(' ');
  for (const [op, a] of corpus()) {
    if (op !== 'safeRelativePath') continue;
    const stored = oracle.safeRelativePathJs(a);
    if (!stored || !stored.isWellFormed()) continue;
    const again = paths.safeRelativePath(stored);
    assert.equal(again, oracle.safeRelativePathJs(stored), `${JSON.stringify(String(a).slice(0, 80))} -> ${cps(stored)}`);
    if (again === stored) fixed += 1;
    else {
      assert.notEqual(stored.trim(), stored, `only a stored value that ends in white space reads back changed: ${cps(stored)}`);
      quirk += 1;
    }
    assert.equal(paths.joinRoot('root', stored), oracle.joinRootJs('root', stored));
  }
  assert.ok(fixed > 1000, `${fixed} stored paths`);
  console.log(`# storage-path retirement: ${fixed + quirk}/${fixed + quirk} stored paths read back as under JS (${fixed} unchanged, ${quirk} ending in white space trimmed, as before)`);
});

test('the storage client refuses every traversal, absolute or NUL path before a request leaves', { skip: skipWasm }, async (t) => {
  t.mock.method(console, 'warn', () => {});
  const real = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error('no request may leave'); };
  t.after(() => { globalThis.fetch = real; });
  const conn = { kind: 'webdav', baseUrl: 'https://storage.invalid/dav', corpusRoot: 'root' };
  const hostile = [...TRAVERSAL, ...ABSOLUTE, ...CONTROL, ...SURROGATE, 'a'.repeat(CAP + 1)].filter((p) => {
    const want = expected('safeRelativePath', p);
    return want.error || (want.value === '' && !['', '.'].includes(p.trim()));
  });
  assert.ok(hostile.length > 30, `${hostile.length} refused paths`);
  for (const p of hostile) {
    for (const call of [() => storageClient.listFiles(conn, p), () => storageClient.readTextFile(conn, p), () => storageClient.writeFile(conn, p, Buffer.from('x')), () => storageClient.readBinaryFile(conn, p)]) {
      await assert.rejects(call, (e) => e.status === 400, JSON.stringify(p.slice(0, 40)));
    }
  }
  assert.equal(requests, 0);
});
