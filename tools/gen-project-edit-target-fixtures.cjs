#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for PROJECT_EDIT_TARGET_IMPL: project-edit-target.cjs planEdit
// (which stored file a project edit tool may change, the plain name the write path gets, and the
// stored path it writes). The same file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/project-edit-target/tests/fixtures/project-edit-target.v1.json); noevia-core CI compares
// them.
//   node tools/gen-project-edit-target-fixtures.cjs > tests/fixtures/project-edit-target.v1.json
//
// Each row is { wire, want }: `wire` is the JSON the host sends after the op byte (editTargetInput()
// of the file the JS resolved), `want` the exact reply text the port must give: the JS's own plan,
// or the code of the first rule the JS refused it with. The port is never stricter than the JS on
// these (no `strict` rows). Only names the JS resolved to one file are asked (the port is given the
// file), and only projects editTargetInput() can project.
//
// classify() is the upload-sniff test oracle (tests/server/oracle/upload-sniff.cjs, ASCII
// extension patterns and storage-client's TEXT_EXTENSIONS), so no WebAssembly module is needed;
// production runs the same rules in Rust. Nothing here depends on ICU: every extension is ASCII,
// and project-file-names' NFC only sees names that are already NFC. The file is printed ASCII-only
// (every other code unit as \uXXXX). All projects and names are synthetic; random combinations use
// a seeded mulberry32.

const path = require('node:path');
const root = path.join(__dirname, '..');
// Before uploads.cjs reads it: classify from the oracle, not the module.
require(path.join(root, 'server', 'upload-sniff.cjs')).classify = require(path.join(root, 'tests', 'server', 'oracle', 'upload-sniff.cjs')).classifyJs;
const et = require(path.join(root, 'server', 'project-edit-target.cjs'));

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x0ed17a26);
const pick = (a) => a[Math.floor(rand() * a.length)];

const CODES = [
  ['is not stored where this project', 'upload_path'],
  ['comes from the attached folder', 'synced'],
  ['is stored under a folder path', 'path'],
  ['has no storage folder yet', 'no_folder'],
  ['is not a text file type', 'not_text'],
  ['is already a separate file', 'taken'],
  ['stored in its original format', 'original'],
  ['could not be read when it was added', 'document'],
  ['is an extracted document', 'document'],
  ['was only read in part', 'partial'],
];

const rows = [];
const seen = new Set();
/** One row for `project` and the name `raw`, if the JS resolves it and the project projects. */
function ask(project, raw, account) {
  let want;
  let plan;
  try {
    plan = et.planEditJs(project, raw, { storageAccount: account });
    want = { plan: { write: plan.writeName, target: plan.target, adopt: plan.adopt } };
  } catch (err) {
    if (!(err instanceof Error) || err instanceof TypeError) return false;
    const hit = CODES.find(([needle]) => err.message.includes(needle));
    if (!hit) return false; // not resolved: the port is never asked
    want = { refused: hit[1] };
  }
  const { resolveProjectFileJs } = require(path.join(root, 'server', 'project-file-names.cjs'));
  const file = plan ? plan.file : resolveProjectFileJs(project, raw).file;
  const input = file && et.editTargetInput(project, file, account);
  if (!input) return false;
  const wire = JSON.stringify(input);
  if (seen.has(wire)) return true;
  seen.add(wire);
  rows.push({ wire, want: JSON.stringify(want) });
  return true;
}

const F = 'noevia projects/Alpha', R = 'noevia projects/Reserved';
const ACCOUNTS = [null, 'acct-1', '', 7];
const upload = (folder, name, group = 'Text', state = 'ready', extra = {}) => ({ name: `${folder}/${group}/${name}`, source: folder, attachment: { id: 'a1', state, group }, ...extra });

// ── hand-written cases: every rule, both sides ──
const cases = [];
for (const name of ['notes.md', 'data.json', 'Notes.MD', 'a.txt', 'x.pdf', 'pic.png', 'noext', '.md', 'a.b.md', 'café.md', '日本.md', 'x\ud800.md']) {
  for (const group of ['Text', 'Documents', 'Images', 'Other']) {
    for (const state of ['ready', 'stored', 'partial', undefined, 5]) cases.push({ projectFolder: F, files: [upload(F, name, group, state)] });
  }
  cases.push({ projectFolder: F, files: [{ name: `${F}/Text/sub/${name}`, source: F, attachment: { state: 'ready', group: 'Text' } }] });
  cases.push({ projectFolder: F, files: [{ name: `${F}/${name}`, source: F, attachment: { state: 'ready', group: 'Text' } }] });
  cases.push({ projectFolder: F, files: [{ name: `${F}/Text/${name}`, source: F, attachment: true }] });
  cases.push({ projectFolder: F, files: [{ name: `${F}/Text/${name}`, source: F }] });
  cases.push({ projectFolder: F, files: [{ name: `${F}/Text/${name}`, source: 'Other folder', attachment: { state: 'ready', group: 'Text' } }] });
  for (const pf of [F, null, '']) {
    for (const rf of [R, null, '', undefined]) {
      cases.push({ projectFolder: pf, reservedFolder: rf, files: [{ name }] });
      cases.push({ projectFolder: pf, reservedFolder: rf, files: [{ name, attachment: { state: 'ready', group: 'Text' } }] });
      cases.push({ projectFolder: pf, reservedFolder: rf, files: [{ name, document: { state: 'ready' }, content: 'x' }] });
      cases.push({ projectFolder: pf, reservedFolder: rf, files: [{ name, document: { state: 'failed' }, content: ' ' }] });
      cases.push({ projectFolder: pf, reservedFolder: rf, files: [{ name, attachment: { state: 'stored', group: 'Documents' } }] });
      cases.push({ projectFolder: pf, reservedFolder: rf, files: [{ name }, { name: `${pf || rf}/Text/${name}` }] });
      cases.push({ projectFolder: pf, reservedFolder: rf, files: [{ name: `${pf || rf}/Text/${name}` }, { name }, { name: 5 }, null] });
      cases.push({ projectFolder: pf, reservedFolder: rf, files: [{ name, source: '' }, { name: `${pf || rf}/Text/${name}x` }] });
    }
  }
  cases.push({ files: [{ name: `dir/${name}` }] });
  cases.push({ files: [{ name, source: 'Attached' }] });
  cases.push({ files: [{ name, source: 0 }] });
}
for (const project of cases) {
  for (const account of ACCOUNTS) {
    for (const f of project.files) if (f && typeof f.name === 'string') ask(project, f.name, account);
  }
}

// ── seeded random projects ──
const NAMES = ['notes.md', 'a.txt', 'b.json', 'c.csv', 'r.pdf', 'p.png', 'n', 'x.MD', 'y.yaml', 'z.ts', 'q.markdown', 'été.md', 'k\udc00.txt', 'long'.repeat(40) + '.md'];
const FOLDERS = [F, R, 'P', 'noevia projects/É', null, ''];
function randomFile(pf, rf) {
  const name = pick(NAMES), r = rand();
  const folder = pf || pick(FOLDERS) || 'P';
  if (r < 0.3) return upload(folder, name, pick(['Text', 'Text', 'Documents', 'Images', 'Other']), pick(['ready', 'ready', 'stored', 'partial']));
  if (r < 0.4) return { name: `${pick(FOLDERS) || 'F'}/${pick(['Text', 'Other', 'Text/sub'])}/${name}`, source: rand() < 0.5 ? pf : null, attachment: rand() < 0.7 ? { state: 'ready', group: 'Text' } : null };
  if (r < 0.5) return { name, source: 'Attached folder' };
  if (r < 0.6) return { name: `${rf || pf || 'P'}/Text/${name}` };
  if (r < 0.7) return { name, attachment: { state: pick(['ready', 'stored', 'partial']), group: pick(['Text', 'Documents', 'Other']) } };
  if (r < 0.75) return { name, document: { state: pick(['ready', 'failed']) }, content: pick(['', ' ', 'text']) };
  return { name };
}
for (let i = 0; i < 6000; i++) {
  const pf = pick(FOLDERS), rf = pick(FOLDERS);
  const n = 1 + Math.floor(rand() * 5);
  const files = Array.from({ length: n }, () => randomFile(pf, rf));
  const project = { projectFolder: pf, reservedFolder: rf, files };
  const f = pick(files);
  const raw = rand() < 0.7 ? f.name : f.name.slice(f.name.lastIndexOf('/') + 1);
  ask(project, raw, pick(ACCOUNTS));
}

// A large project: the duplicate-target check over many names.
{
  const files = Array.from({ length: 3000 }, (_, i) => ({ name: `${F}/Text/f${i}.md` }));
  files.push({ name: 'target.md' });
  ask({ projectFolder: F, files }, 'target.md', 'acct-1');
  files.push({ name: `${F}/Text/target.md` });
  ask({ projectFolder: F, files }, 'target.md', 'acct-1');
}

const ascii = (s) => s.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
process.stdout.write(ascii(JSON.stringify({
  note: 'Generated by noevia-core tools/gen-project-edit-target-fixtures.cjs from project-edit-target.cjs itself; byte-identical in noevia-rs.',
  rows,
})) + '\n');
