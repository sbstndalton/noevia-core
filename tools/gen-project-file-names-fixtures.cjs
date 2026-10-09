#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for PROJECT_FILE_NAMES_IMPL: project-file-names.cjs's
// resolveProjectFile over a project's file names. The same file is committed byte-for-byte in
// sbstndalton/noevia-rs (crates/project-file-names/tests/fixtures/project-file-names.v1.json);
// noevia-core CI compares them.
//   node tools/gen-project-file-names-fixtures.cjs > tests/fixtures/project-file-names.v1.json
//
// Every expectation is what the JS itself returns (PROJECT_FILE_NAMES_IMPL=js), written as the reply
// text the port must give: {"file":i} (i indexes the names sent), {"code":"invalid","reason":\u2026},
// {"code":"missing"} or {"code":"ambiguous","candidates":[i,\u2026]}. Names are synthetic and the random
// ones come from a seeded mulberry32. Nothing recorded depends on ICU (#1115): the JS compares NFC
// forms, so a row is recorded with its answer only when every string the port compares is made of
// NFC-inert code units (the crate's table, mirrored below), where NFC is the identity on every ICU,
// after the port's one composition step (noevia#1211, project_file_names::compose_pairs): an inert
// base U+0000-U+02FF, one mark U+0300-U+036F and then an inert code point or the end, composed when
// NFC makes one code point below U+0300 of the pair (canonical compositions, fixed by Unicode's
// stability policy). The other rows are strict: the port refuses them (ambiguous) and no JS answer
// is recorded.
//
// Each row is { wire, want } or { wire, refused }: `wire` is JSON [names, raw] (op 1).

const path = require('node:path');
const { resolveProjectFileJs, invalidReason } = require(path.join(__dirname, '..', 'server', 'project-file-names.cjs'));

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xf11e);
const pick = (list) => list[Math.floor(rand() * list.length)];

// project_file_names::NFC_INERT_RANGES (code points) and inert_tail_len.
const INERT = [[0x0000, 0x02ff], [0x0400, 0x0482], [0x048a, 0x04ff], [0x2010, 0x2027], [0x2030, 0x205e], [0x3001, 0x3029],
  [0x3041, 0x3096], [0x30a1, 0x30fc], [0x4e00, 0x9fff], [0xac00, 0xd7a3], [0xff01, 0xff60], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff]];
const inertCp = (cp) => INERT.some(([a, b]) => cp >= a && cp <= b);
function tailLen(s) {
  let i = s.length;
  while (i > 0) {
    const lo = s.charCodeAt(i - 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) {
      const hi = i >= 2 ? s.charCodeAt(i - 2) : 0;
      if (!(hi >= 0xd800 && hi <= 0xdbff) || !inertCp(0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00))) break;
      i -= 2;
    } else if ((lo >= 0xd800 && lo <= 0xdbff) || !inertCp(lo)) break;
    else i--;
  }
  return s.length - i;
}

// project_file_names::compose_pairs (its NFC_PAIRS table is these pairs, generated from normalize()).
const pairOf = (base, mark) => {
  const nfc = [...String.fromCharCode(base, mark).normalize('NFC')];
  return nfc.length === 1 && nfc[0].codePointAt(0) < 0x300 ? nfc[0] : null;
};
/** project_file_names::inert_head: `s` starts with a whole NFC-inert code point. */
function inertHead(s) {
  const cp = s.codePointAt(0);
  if (cp === undefined || (cp >= 0xd800 && cp <= 0xdfff)) return false;
  return inertCp(cp);
}
function composePairs(s) {
  let out = '';
  for (let i = 0; i < s.length;) {
    const c = s.charCodeAt(i), m = s.charCodeAt(i + 1);
    if (c < 0x300 && m >= 0x300 && m < 0x370 && (i + 2 === s.length || inertHead(s.slice(i + 2)))) {
      const p = pairOf(c, m);
      if (p) { out += p; i += 2; continue; }
    }
    out += s[i]; i++;
  }
  return out;
}

/** Whether the port refuses: mirrors resolve() (invalid names are answered first; a stored name is
 *  decided by its inert tail when that is enough, see the crate docs). */
function strict(names, raw) {
  if (typeof raw !== 'string' || invalidReason(raw)) return false;
  const wanted = composePairs(raw.trim());
  if (tailLen(wanted) !== wanted.length) return true;
  names = names.map(composePairs);
  for (const n of names) {
    const at = n.length - tailLen(n);
    if (at === 0) { if (n === wanted) return false; } else if (wanted.endsWith(n.slice(at))) return true;
  }
  const suffix = `/${wanted}`;
  for (const n of names) {
    const t = tailLen(n);
    if (t === n.length || t >= suffix.length) continue;
    if (suffix.endsWith(n.slice(n.length - t))) return true;
  }
  return false;
}

function row(names, raw) {
  const wire = JSON.stringify([names, raw === undefined ? null : raw]);
  if (strict(names, raw)) return { wire, refused: 'ambiguous' };
  const files = names.map((name) => ({ name }));
  const r = resolveProjectFileJs({ files }, raw);
  let want;
  if (r.file) want = { file: files.indexOf(r.file) };
  else if (r.code === 'invalid') want = { code: 'invalid', reason: invalidReason(raw) };
  else if (r.code === 'missing') want = { code: 'missing' };
  else if (r.code === 'ambiguous') {
    const w = raw.trim();
    const candidates = names.flatMap((n, i) => (n.normalize('NFC').endsWith(`/${w.normalize('NFC')}`) ? [i] : []));
    if (candidates.length !== r.candidates.length || candidates.some((i, k) => names[i] !== r.candidates[k])) throw Error('candidate indices');
    want = { code: 'ambiguous', candidates };
  } else throw Error(`unexpected answer ${r.code}`);
  return { wire, want: JSON.stringify(want) };
}

const PROJECT = ['noevia projects/Alpha/Text/notes.md', 'noevia projects/Alpha/Text/plan.md', 'notes.md', 'Docs/notes.md',
  'Skills/writing/SKILL.md', 'Skills/review/SKILL.md', 'a.txt', 'x/a.txt.bak', 'deep/er/still/file.md', '\u65e5\u672c\u8a9e.md',
  '\u0420\u0443\u0441\u0441\u043a\u0438\u0439/\u0444\u0430\u0439\u043b.txt', 'caf\u00e9.md', '\ud55c\uad6d\uc5b4.txt', '\u30ab\u30bf\u30ab\u30ca.md', 'dup.md', 'dup.md'];
const RAW = [
  'notes.md', 'plan.md', 'Text/notes.md', 'Alpha/Text/notes.md', 'noevia projects/Alpha/Text/notes.md', 'SKILL.md', 'writing/SKILL.md',
  'a.txt', 'txt', 'file.md', 'still/file.md', 'er/still/file.md', '\u65e5\u672c\u8a9e.md', '\u0444\u0430\u0439\u043b.txt', 'caf\u00e9.md',
  '\ud55c\uad6d\uc5b4.txt', '\u30ab\u30bf\u30ab\u30ca.md', 'dup.md', 'missing.md', 'NOTES.MD', ' notes.md ', '\tnotes.md\n', '\u00a0notes.md\u3000',
  // invalid
  '', '   ', '../notes.md', './notes.md', 'Text/../notes.md', 'Text//notes.md', 'notes.md/', '/notes.md', 'C:/notes.md', 'c:/x', 'C:notes.md',
  'Text\\notes.md', 'notes\u0000.md', 'notes\u001f.md', 'notes\u007f.md', '%2e%2e/notes.md', '%2Fetc', '%5c', '%00', '%2', '%41notes.md',
  '..', '.', 'a/./b', 'x'.repeat(1024), 'x'.repeat(1025), ` ${'y'.repeat(1024)} `, 5, null, undefined, true, ['notes.md'], { name: 'notes.md' },
  // one table mark after an inert base composes (noevia#1211)
  'cafe\u0301.md', 'Cafe\u0301.md', 'n\u00e9e\u0300.md', 'Text/cafe\u0301.md', 'cafe\u0340.md',
  // strict: the port does not normalise anything else
  'notes.md\u0301', '\u03b1.md', '\u05d0.md', '\ud800.md', 'cafu\u0308\u0301.md', 'cafe\u0301\u0301.md', 'cafe\u0301\u03b1.md',
  'caq\u0301.md', '\u0301notes.md', 'cafe\u0323\u0301.md',
];
const rows = [];
for (const raw of RAW) rows.push(row(PROJECT, raw));
for (const raw of RAW.slice(0, 25)) rows.push(row([], raw));
// Order and duplicates: exact before suffix, first exact wins, duplicate suffixes are ambiguous.
rows.push(row(['x/a.md', 'a.md'], 'a.md'), row(['a.md', 'a.md'], 'a.md'), row(['x/a.md', 'x/a.md'], 'a.md'), row(['x/a.md', 'y/a.md', 'a.md'], 'a.md'),
  row(['xa.md', 'x/a.md'], 'a.md'), row(['a.md/', 'b/a.md'], 'a.md'), row(['/a.md'], 'a.md'), row(['a.md'], 'A.md'));
// Strict file names: compared before an exact match, or with no exact match at all.
rows.push(row(['cafe\u0301.md', 'caf\u00e9.md'], 'caf\u00e9.md'), row(['caf\u00e9.md', 'cafe\u0301.md'], 'caf\u00e9.md'),
  row(['x/\u03b1.md', 'y/b.md'], 'b.md'), row(['b.md', 'x/\u03b1.md'], 'b.md'), row(['\ud800', 'z.md'], 'z.md'));

// Seeded projects and names.
const SEG = ['a', 'b', 'notes', 'Text', 'Skills', 'noevia projects', 'P', '\u65e5\u672c', '\u0444\u0430\u0439\u043b', 'caf\u00e9', '\ud55c', 'x y', 'v1.2', '-', '_',
  '\u03b1\u03b2', 'e\u0301', '\u2014', '\uff21', '\ud83d\ude00'];
const EXT = ['.md', '.txt', '', '.pdf', '.MD'];
const seg = () => pick(SEG);
const name = () => Array.from({ length: 1 + Math.floor(rand() * 3) }, seg).join('/') + pick(EXT);
for (let i = 0; i < 400; i++) {
  const names = Array.from({ length: Math.floor(rand() * 8) }, name);
  if (rand() < 0.15) names.push(`e\u0301/${name()}`);
  let raw;
  const r = rand();
  if (r < 0.4 && names.length) raw = pick(names);
  else if (r < 0.7 && names.length) { const parts = pick(names).split('/'); raw = parts.slice(Math.floor(rand() * parts.length)).join('/'); }
  else if (r < 0.8) raw = `${pick(['..', '.', '', '/x', 'C:', '%2e'])}/${name()}`;
  else raw = name();
  if (rand() < 0.1) raw = ` ${raw}\t`;
  rows.push(row(names, raw));
}

// Wider safe table and names that are unsafe only at their head (decided by the tail).
rows.push(row(['αβ/notes.md', 'x/notes.md'], 'x/notes.md'), row(['αβ/notes.md', 'b.md'], 'b.md'),
  row(['αβ/notes.md'], 'notes.md'), row(['α/x/notes.md', 'y/notes.md'], 'notes.md'), row(['אב/plan.md'], 'plan.md'),
  row(['α.md', 'x/b.md'], 'b.md'), row(['café́', 'z.md'], 'z.md'), row(['é/notes.md'], 'notes.md'),
  row(['— draft —.md', '【memo】.md', 'ＡＢ.md', '😀.md', '🤖/ノート・1.md'], '😀.md'),
  row(['ＡＢ.md', 'a/【memo】.md'], '【memo】.md'), row(['x/🤖.md', 'y/🤖.md'], '🤖.md'),
  row(['☃.md'], '☃.md'), row(['a‍.md'], 'a‍.md'));

// noevia#1211: NFD names (one table mark) on either side, in an exact or a suffix match.
rows.push(row(['Caf\u00e9.md'], 'Cafe\u0301.md'), row(['Cafe\u0301.md'], 'Caf\u00e9.md'), row(['x/Cafe\u0301.md', 'y/Caf\u00e9.md'], 'Caf\u00e9.md'),
  row(['Text/Cafe\u0301.md', 'b.md'], 'b.md'), row(['Caf\u00e9/x.md'], 'Cafe\u0301/x.md'), row(['u\u0308\u0301.md'], '\u01d8.md'),
  row(['\u00fc\u0301.md'], '\u01d8.md'), row(['\u01d8.md'], 'u\u0308\u0301.md'), row(['A\u030a.md'], '\u00c5.md'), row(['A\u030a.md'], '\u212b.md'));

// Seeded shared tails: two or more folders holding the same trailing name.
for (let i = 0; i < 40; i++) {
  const tail = name();
  const names = Array.from({ length: 2 + Math.floor(rand() * 3) }, () => `${seg()}/${tail}`);
  if (rand() < 0.3) names.push(name());
  rows.push(row(names, tail));
}

const counts = rows.reduce((m, r) => { const k = r.refused ? 'strict' : JSON.parse(r.want).code || 'file'; m[k] = (m[k] || 0) + 1; return m; }, {});
for (const k of ['file', 'invalid', 'missing', 'ambiguous', 'strict']) if (!counts[k]) throw Error(`no ${k} rows`);

process.stdout.write(`${JSON.stringify({ version: 1, rows })}\n`);
