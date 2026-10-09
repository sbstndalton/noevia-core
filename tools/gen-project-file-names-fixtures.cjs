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
// NFC-inert code units (the crate's table, mirrored below), where NFC is the identity on every ICU.
// The other rows are strict: the port refuses them (ambiguous) and no JS answer is recorded.
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

// project_file_names::NFC_INERT_RANGES
const INERT = [[0x0000, 0x02ff], [0x0400, 0x0482], [0x048a, 0x04ff], [0x3041, 0x3096], [0x30a1, 0x30fa], [0x4e00, 0x9fff], [0xac00, 0xd7a3]];
const inertUnit = (c) => INERT.some(([a, b]) => c >= a && c <= b);
const inert = (s) => { for (let i = 0; i < s.length; i++) if (!inertUnit(s.charCodeAt(i))) return false; return true; };

/** Whether the port refuses: mirrors resolve() (invalid names are answered first). */
function strict(names, raw) {
  if (typeof raw !== 'string' || invalidReason(raw)) return false;
  const wanted = raw.trim();
  if (!inert(wanted)) return true;
  for (const n of names) {
    if (!inert(n)) return true;
    if (n === wanted) return false;
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
    const candidates = names.flatMap((n, i) => (n.endsWith(`/${w}`) ? [i] : []));
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
  // strict: the port does not normalise
  'cafe\u0301.md', 'notes.md\u0301', '\u03b1.md', '\u05d0.md', '\ud800.md', 'n\u00e9e\u0300.md',
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
const SEG = ['a', 'b', 'notes', 'Text', 'Skills', 'noevia projects', 'P', '\u65e5\u672c', '\u0444\u0430\u0439\u043b', 'caf\u00e9', '\ud55c', 'x y', 'v1.2', '-', '_'];
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
