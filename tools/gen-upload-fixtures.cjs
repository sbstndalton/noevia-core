#!/usr/bin/env node
'use strict';
// Regenerates the shared differential fixtures for the upload checks (#977). Expectations come from
// the JS references (tests/server/oracle/upload-sniff.cjs validateJs, classifyJs, decodeTextJs). The same file is
// committed byte-for-byte in sbstndalton/noevia-rs (crates/upload-sniff/tests/fixtures/
// upload-sniff.v1.json); noevia-core CI compares them.
//   node tools/gen-upload-fixtures.cjs > tests/fixtures/upload-sniff.v1.json
// Every name and byte below is synthetic. No real upload content.
//
// Shapes: validate cases carry the upload length and its leading bytes as hex (`head`); the rest of
// the upload is zero bytes. A refusal is { refusal, status }, acceptance null. decode cases carry
// all bytes as hex; the expectation is null (not text) or { encoding, text }.

const { CAP, validateJs, classifyJs, decodeTextJs } = require('../tests/server/oracle/upload-sniff.cjs');

let seed = 0x977;
const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const int = (n) => Math.floor(rand() * n);
const pick = (a) => a[int(a.length)];
const hex = (b) => Buffer.from(b).toString('hex');

const REFUSALS = new Map([
  ['Use a plain filename of at most 200 characters.', 'filename'],
  ['Files must be non-empty and no larger than 25 MB.', null],
  ['Archive bundles are not supported. Upload their individual files instead.', 'archive'],
]);
function validateExpect(name, len, head) {
  const bytes = Buffer.alloc(len);
  Buffer.from(head).copy(bytes, 0, 0, Math.min(head.length, len));
  try { validateJs(name, bytes); return null; } catch (err) {
    if (!REFUSALS.has(err.message)) throw err;
    const refusal = REFUSALS.get(err.message) || (err.status === 413 ? 'too_big' : 'empty');
    return { refusal, status: err.status };
  }
}

const validate = [], classify = [], decode = [];
const addV = (name, len, head = []) => {
  const h = Array.from(head).slice(0, Math.min(len, 300));
  validate.push({ name, len, head: hex(h), expect: validateExpect(name, len, h) });
};
const addC = (name) => classify.push({ name, expect: classifyJs(name) });
const addD = (label, bytes) => {
  const r = decodeTextJs(Buffer.from(bytes));
  decode.push({ name: label, bytes: hex(bytes), expect: r && { encoding: r.encoding, text: r.text } });
};

// ── validate: magic numbers at exact offsets ──
const at = (off, sig, len = 600) => { const b = Buffer.alloc(len, 0x41); Buffer.from(sig).copy(b, off); return b; };
const sigs = {
  zip: [0x50, 0x4b, 3, 4], gzip: [0x1f, 0x8b], rar: [...Buffer.from('Rar!'), 0x1a, 7], sevenz: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  bzip: [...Buffer.from('BZh9')], pdf: [...Buffer.from('%PDF-1.7')], png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], jpeg: [0xff, 0xd8, 0xff, 0xe0],
  zipEmpty: [0x50, 0x4b, 5, 6], zipSpanned: [0x50, 0x4b, 7, 8], gzipHalf: [0x1f], rarLower: [...Buffer.from('rar!')], bzLower: [...Buffer.from('bzh')],
};
const names = ['upload.txt', 'upload.bin', 'upload.docx', 'upload.DOCX', 'upload.xlsx', 'upload.pptx', 'upload.odt', 'upload.ods', 'upload.odp', 'upload.epub', 'upload.doc', 'upload.pdf', 'upload.png', 'upload.jpg', 'upload', '.docx', 'upload.docx.txt', 'upload.txt.docx'];
for (const [k, sig] of Object.entries(sigs)) for (const n of names) addV(n, 600, at(0, sig));
for (const off of [256, 257, 258]) for (const n of ['upload.txt', 'upload.docx', 'upload.bin']) addV(n, 600, at(off, Buffer.from('ustar')));
addV('upload.txt', 262, at(257, Buffer.from('ustar'), 262));
addV('upload.txt', 261, at(257, Buffer.from('ustar'), 261));
addV('upload.txt', 600, at(257, Buffer.from('ustaR')));
addV('upload.txt', 600, at(257, Buffer.from('ustar\0')));
for (const n of ['upload.txt', 'upload.docx']) for (const len of [1, 2, 3, 4, 5]) addV(n, len, sigs.zip);
for (const n of ['upload.txt', 'upload.docx']) addV(n, 1, sigs.gzip);
// ── validate: archive names ──
for (const ext of ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'cab', 'iso', 'ZIP', 'Tar', 'GZ', 'zipx', 'tar.gz', 'docx.zip', 'zip.txt', 'z', 'gzz', 'iso ']) addV(`bundle.${ext}`, 10, Buffer.from('plain text'));
addV('zip', 10, Buffer.from('plain text'));
addV('.zip', 10, Buffer.from('plain text'));
addV('a.İso', 10, Buffer.from('plain text'));
addV('a.Kip', 10, Buffer.from('plain text'));
// ── validate: filename rule (reused from storage-path) ──
for (const n of ['', '.', '..', '...', 'a/b.txt', 'a\\b.txt', 'tab\there.txt', 'nul\0.txt', 'esc\u001b.txt', 'del\u007f.txt', 'x'.repeat(200), 'x'.repeat(201), '\u{1F600}'.repeat(100), '\u{1F600}'.repeat(101), 'café.txt', ' spaced .txt', '‮gnp.txt', 'a\u0085b.txt']) addV(n, 4, Buffer.from('text'));
// ── validate: sizes ──
for (const len of [0, 1, CAP - 1, CAP, CAP + 1]) for (const n of ['upload.txt', 'bad/name', 'bundle.zip']) addV(n, len, len ? Buffer.from('text') : []);
addV('upload.txt', CAP + 1, sigs.zip);
addV('upload.docx', CAP, sigs.zip);
// ── validate: seeded random ──
const namePieces = ['a', 'B', '.', '..', '.docx', '.zip', '.ZIP', '.txt', '.tar', '.gz', '.epub', '/', '\\', ' ', '\t', 'é', '\u{1F600}', 'K', 'İ', 'docx', 'zip', 'x'.repeat(60)];
const headPieces = [sigs.zip, sigs.gzip, sigs.rar, sigs.sevenz, sigs.bzip, sigs.pdf, sigs.png, [0], [0x50], [0x4b], [3, 4], [0x1f], [0x8b], [...Buffer.from('ustar')], [0x41, 0x42], [0xff]];
for (let i = 0; i < 1500; i++) {
  const name = Array.from({ length: 1 + int(5) }, () => pick(namePieces)).join('');
  const head = [];
  while (head.length < 300 && rand() < 0.97) head.push(...(rand() < 0.3 ? pick(headPieces) : [int(256)]));
  if (rand() < 0.3) { const u = Buffer.from('ustar'); for (let j = 0; j < 5; j++) head[257 + j] = u[j]; for (let j = 0; j < 257; j++) head[j] ??= 0x20; }
  const len = rand() < 0.05 ? pick([0, CAP, CAP + 1]) : Math.max(head.length, int(400));
  addV(name, len, head);
}

// ── classify ──
const exts = ['pdf', 'doc', 'docx', 'odt', 'rtf', 'ppt', 'pptx', 'xls', 'xlsx', 'ods', 'odp', 'epub', 'png', 'jpg', 'jpeg', 'jpe', 'webp', 'gif', 'heic', 'heif', 'tif', 'tiff', 'tiff2', 'bmp', 'svg', 'avif', 'txt', 'md', 'markdown', 'json', 'csv', 'yml', 'yaml', 'ts', 'tsx', 'js', 'jsx', 'py', 'sh', 'html', 'css', 'htm', 'bin', 'zip', ''];
for (const e of exts) { addC(`file.${e}`); addC(`file.${e.toUpperCase()}`); }
for (const n of ['', '.', '..', '...', '.md', '..md', '.a.md', 'md', 'a.', 'a..', 'a.md.', 'dir.md/file', 'dir/file.md', 'dir/file.md/', 'dir/file.md//', '/', '//a.md', 'a.MARKDOWN', 'a.marKdown', 'a.İ', 'a.docx ', 'a. docx', 'a.doсx', 'a.ｍd', 'a\\b.md', 'a.md\0', 'é.md', 'a.ΣΣ', 'a.ſh']) addC(n);
const cPieces = ['a', '.', '/', '..', 'md', 'MD', 'docx', 'png', 'Txt', 'K', 'é', ' ', 'jpeg', 'jpg', '\u{1F600}', 'markdown', 'tiff', 'x'];
for (let i = 0; i < 1500; i++) addC(Array.from({ length: 1 + int(6) }, () => pick(cPieces)).join(''));

// ── decode ──
addD('empty', []);
addD('ascii', Buffer.from('plain synthetic text\n'));
addD('utf-8', Buffer.from('café — \u{1F600} ࠀ'));
addD('utf-8 bom', [0xef, 0xbb, 0xbf, ...Buffer.from('bom text')]);
addD('utf-8 bom only', [0xef, 0xbb, 0xbf]);
addD('utf-8 double bom', [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61]);
addD('utf-8 triple bom', [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]);
addD('utf-8 bom then invalid', [0xef, 0xbb, 0xbf, 0x61, 0xff]);
addD('utf-8 bom then nul', [0xef, 0xbb, 0xbf, 0x61, 0x00]);
addD('partial utf-8 bom', [0xef, 0xbb, 0x61]);
addD('bom in the middle', [0x61, 0xef, 0xbb, 0xbf, 0x62]);
addD('utf-16le bom', [0xff, 0xfe, ...Buffer.from('hé€\u{1F600}', 'utf16le')]);
addD('utf-16le bom only', [0xff, 0xfe]);
addD('utf-16le double bom', [0xff, 0xfe, 0xff, 0xfe, 0x61, 0]);
addD('utf-16le nul inside', [0xff, 0xfe, 0, 0, 0x61, 0]);
addD('utf-16le odd length', [0xff, 0xfe, 0x61, 0, 0x62]);
addD('utf-16le odd length with nul', [0xff, 0xfe, 0x61]);
addD('utf-16le lone high surrogate', [0xff, 0xfe, 0x3d, 0xd8, 0x61, 0]);
addD('utf-16le lone high at end', [0xff, 0xfe, 0x61, 0, 0x3d, 0xd8]);
addD('utf-16le lone low surrogate', [0xff, 0xfe, 0x00, 0xdc]);
addD('utf-16le reversed pair', [0xff, 0xfe, 0x00, 0xde, 0x3d, 0xd8]);
addD('utf-16be bom', [0xfe, 0xff, ...Buffer.from('hé€\u{1F600}', 'utf16le').swap16()]);
addD('utf-16be bom only', [0xfe, 0xff]);
addD('utf-16be double bom', [0xfe, 0xff, 0xfe, 0xff, 0, 0x61]);
addD('utf-16be odd length', [0xfe, 0xff, 0, 0x61, 0]);
addD('utf-16be lone surrogate', [0xfe, 0xff, 0xd8, 0x3d]);
addD('utf-16be lone surrogate, no nul', [0xfe, 0xff, 0xd8, 0x3d, 0x41, 0x41]);
addD('utf-16le bom with le-bom-looking be text', [0xff, 0xfe, 0xfe, 0xff]);
addD('utf-32le bom', [0xff, 0xfe, 0, 0, 0x61, 0, 0, 0]);
addD('nul only', [0]);
addD('nul in ascii', Buffer.from('a\0b'));
addD('nul at end', Buffer.from('abc\0'));
addD('jpeg', [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
addD('png', sigs.png);
for (let b = 0x80; b <= 0xff; b++) addD(`windows-1252 0x${b.toString(16)}`, [0x61, b, 0x62]);
addD('windows-1252 0x80-0x9f', Array.from({ length: 32 }, (_, i) => 0x80 + i));
addD('windows-1252 all non-nul bytes', Array.from({ length: 255 }, (_, i) => i + 1));
addD('latin-1 text', Buffer.from('café naïve à la crème', 'latin1'));
addD('windows-1252 quotes', [0x93, 0x71, 0x94, 0x20, 0x96, 0x20, 0x85]);
const invalid = {
  'overlong slash': [0xc0, 0xaf], 'overlong nul': [0xc0, 0x80], 'overlong 3-byte': [0xe0, 0x80, 0xaf], 'overlong 4-byte': [0xf0, 0x80, 0x80, 0xaf],
  'surrogate d800': [0xed, 0xa0, 0x80], 'surrogate dfff': [0xed, 0xbf, 0xbf], 'surrogate pair as utf-8': [0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80],
  'above 10ffff': [0xf4, 0x90, 0x80, 0x80], 'f5 lead': [0xf5, 0x80, 0x80, 0x80], 'fe': [0xfe], 'ff': [0xff],
  'truncated 2-byte': [0xc3], 'truncated 3-byte': [0xe2, 0x82], 'truncated 4-byte': [0xf0, 0x9f, 0x98], 'lone continuation': [0x80], 'continuation run': [0x80, 0x80, 0x80],
  'bad continuation': [0xc3, 0x41], 'max code point': [0xf4, 0x8f, 0xbf, 0xbf], 'ufffe': [0xef, 0xbf, 0xbe], 'last 3-byte before surrogates': [0xed, 0x9f, 0xbf], 'first after surrogates': [0xee, 0x80, 0x80],
};
for (const [k, v] of Object.entries(invalid)) { addD(`utf-8 ${k}`, v); addD(`utf-8 ${k} in text`, [0x61, ...v, 0x62]); }
// ── decode: seeded random ──
const dPieces = [[0xef, 0xbb, 0xbf], [0xff, 0xfe], [0xfe, 0xff], [0], [0xc3, 0xa9], [0xe2, 0x82, 0xac], [0xf0, 0x9f, 0x98, 0x80], [0xed, 0xa0, 0x80], [0xc0, 0x80], [0x80], [0x9d], [0x81], [0xd8, 0x3d], [0x3d, 0xd8], [0xdc, 0x00], [0x00, 0xdc], [0x0d, 0x0a], [0x20]];
for (let i = 0; i < 3000; i++) {
  const mode = i % 6, out = [];
  if (mode === 5) {
    // Well-formed UTF-8 (1-4 byte sequences, a stray U+FEFF), sometimes behind a BOM, sometimes damaged.
    const cps = Array.from({ length: int(24) }, () => pick([0x20 + int(0x5f), 0xe9, 0x20ac, 0xfeff, 0x10000 + int(0xfffff), 0x80 + int(0x780), 0xe000 + int(0x1000), 0x85]));
    const body = [...Buffer.from(String.fromCodePoint(...cps))];
    if (rand() < 0.2) body.splice(int(body.length + 1), 0, 0x80 + int(0x80));
    addD(`random ${i}`, [...(rand() < 0.3 ? [0xef, 0xbb, 0xbf] : []), ...body]);
    continue;
  }
  if (mode === 4) {
    // Well-formed UTF-16 (BMP, astral, a stray U+FEFF) behind its BOM, sometimes damaged by one byte.
    const cps = Array.from({ length: int(24) }, () => pick([0x61 + int(26), 0xe9, 0x20ac, 0xfeff, 0x10000 + int(0xfffff), 0x80 + int(0x780), 0xe000 + int(0x1000)]));
    const le = Buffer.from(String.fromCodePoint(...cps), 'utf16le'), big = rand() < 0.5;
    const body = [...(big ? Buffer.from(le).swap16() : le)];
    if (rand() < 0.2) body.splice(int(body.length + 1), 0, int(256));
    addD(`random ${i}`, [...(big ? [0xfe, 0xff] : [0xff, 0xfe]), ...body]);
    continue;
  }
  const n = int(48);
  for (let j = 0; j < n; j++) {
    if (mode === 0) out.push(int(256));
    else if (mode === 1) out.push(rand() < 0.85 ? 0x20 + int(0x5f) : 0x80 + int(0x80));
    else if (mode === 2) out.push(...(rand() < 0.5 ? pick(dPieces) : [0x61 + int(26)]));
    else out.push(...(j === 0 ? pick([[0xff, 0xfe], [0xfe, 0xff], [0xef, 0xbb, 0xbf]]) : rand() < 0.3 ? pick(dPieces) : [int(256), int(256)]));
  }
  addD(`random ${i}`, out);
}

const out = { version: 1, generator: 'tools/gen-upload-fixtures.cjs', cap: CAP, validate, classify, decode };
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
