#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for PROVIDER_EGRESS_IMPL: provider-egress.cjs's external-provider
// rules. The same file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/provider-egress/tests/fixtures/provider-egress.v1.json); noevia-core CI compares them.
//   node tools/gen-provider-egress-fixtures.cjs > tests/fixtures/provider-egress.v1.json
//
// Each row is { op, wire, want } or { op, wire, want, strict: true }: `wire` is the JSON the host
// sends after the op byte, `want` the exact reply text the port must give. Providers and storage
// connections are written as the host's projections ({kind, external, baseUrl, label} and {kind,
// corpusRoot, baseUrl}), which are valid rows for the JS too. All names and paths are synthetic;
// the random ones come from a seeded mulberry32.
//
// Nothing recorded depends on ICU (#1115). A row without `strict` is the JS's own answer and every
// string it canonicalizes is NFC-inert before and after percent-decoding (the crate's table,
// mirrored below), where NFC is the identity and toLowerCase context-free on every ICU. A `strict`
// row touches something the port does not know (a non-inert path or folder, a provider URL with
// non-ASCII text, '%' or 'xn--'): its `want` is the port's strict answer, computed here without
// ICU by the mirror below, and the generator checks that it never lets out more than the JS does.

const path = require('node:path');
const pe = require(path.join(__dirname, '..', 'server', 'provider-egress.cjs'));

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xe9e55);
const pick = (list) => list[Math.floor(rand() * list.length)];

// ── The port, mirrored without ICU ──────────────────────────────────────────
// project_file_names::NFC_INERT_RANGES (code points).
const INERT = [[0x0000, 0x02ff], [0x0400, 0x0482], [0x048a, 0x04ff], [0x2010, 0x2027], [0x2030, 0x205e], [0x3001, 0x3029],
  [0x3041, 0x3096], [0x30a1, 0x30fc], [0x4e00, 0x9fff], [0xac00, 0xd7a3], [0xff01, 0xff60], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff]];
const inertCp = (cp) => INERT.some(([a, b]) => cp >= a && cp <= b);
const inert = (s) => [...s].every((ch) => { const cp = ch.codePointAt(0); return !(cp >= 0xd800 && cp <= 0xdfff) && inertCp(cp); });

let touched = false; // the row reached something the port does not know
function decoded(s) {
  let text = s;
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(text); i++) { try { text = decodeURIComponent(text); } catch { break; } }
  return text;
}
function portCanonical(s) {
  if (inert(s) && inert(decoded(s))) return pe.canonicalPath(s);
  touched = true;
  return null;
}
function portTrial(p) {
  if (!p) return false;
  if (/[^\x00-\x7f%]/.test(p.baseUrl) || p.baseUrl.includes('%') || /xn--/i.test(p.baseUrl)) { touched = true; return null; }
  return pe.isTrialTermsHostJs(p);
}
function portExternal(p) {
  if (!p) return false;
  if (p.kind === 'chatgpt-oauth' || p.external === true) return true;
  return portTrial(p);
}
const strictExternal = (p) => portExternal(p) ?? true;
const DAV_ROOT = /\/remote\.php\/(?:dav\/files\/[^/]+|webdav)(\/.*)?$/i;
/** diary_folder: { folder, known }. */
function portFolder(s) {
  if (!s || !['nextcloud', 'webdav'].includes(s.kind)) return { folder: null, known: true };
  const root = s.corpusRoot.trim();
  if (!root) return { folder: null, known: true };
  if (/[^\x00-\x7f]/.test(s.baseUrl)) { touched = true; return { folder: null, known: false }; }
  let base;
  try { base = new URL(s.baseUrl).pathname; } catch { base = s.baseUrl; }
  const dav = DAV_ROOT.exec(base);
  const prefix = dav ? portCanonical(dav[1] || '') : '';
  if (prefix === null) return { folder: null, known: false };
  const r = portCanonical(root);
  if (r === null) return { folder: null, known: false };
  return { folder: [prefix, r].filter(Boolean).join('/') || null, known: true };
}
function portEgressRefusal(p, spaceId, projectId, diaryProjectId) {
  if (!strictExternal(p)) return null;
  if ((typeof spaceId === 'string' && spaceId.startsWith('diary')) || (diaryProjectId && projectId === diaryProjectId)) {
    return `Diary text is never sent to an external provider (${(p && p.label) || 'ChatGPT'}). Choose a local model for Diary attachments and tools.`;
  }
  return null;
}
const PATH_KEY = /path|dir|folder|file|scope|source|destination|target|href|url|location|from|to$/i;
const TREE_TOOL = /^nc_webdav_(?:search_files|find_by_name|find_by_type)$/;
const recursiveArgs = (args) => Object.entries(args || {}).some(([k, v]) => /recurs|depth|deep/i.test(k) && v !== false && v !== 0 && v !== '0' && v !== 1 && v !== '1' && v !== null);
function pathArguments(args, depth = 0, out = []) {
  if (depth > 3 || !args || typeof args !== 'object') return out;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && PATH_KEY.test(key)) out.push(value);
    else if (Array.isArray(value)) for (const v of value) { if (typeof v === 'string' && PATH_KEY.test(key)) out.push(v); else pathArguments(v, depth + 1, out); }
    else if (value && typeof value === 'object') pathArguments(value, depth + 1, out);
  }
  return out;
}
function portToolRefusal(p, name, rawArgs, s) {
  if (!strictExternal(p)) return null;
  const label = (p && p.label) || 'an external provider';
  if (/^diary_/.test(name)) return `ERROR: ${name} is not available with ${label}: Diary content is never sent to an external provider.`;
  if (!/^nc_webdav_/.test(name)) return null;
  const { folder } = portFolder(s);
  if (!folder) return `ERROR: ${name} is not available with ${label}: the Diary folder could not be identified, so storage is closed to external providers. Use a local model for file work.`;
  let args;
  try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {}; } catch { return `ERROR: ${name} arguments could not be read, so it was not run.`; }
  const paths = pathArguments(args);
  const tree = TREE_TOOL.test(name) || recursiveArgs(args);
  if (tree && !paths.length) return `ERROR: ${name} needs a folder to search in when used with ${label}, so it was not run. Search a specific folder outside the Diary.`;
  const inside = `ERROR: ${name} was not run: that path is in the Diary folder, and Diary content is never sent to ${label}. Do not retry; tell the user to use a local model for Diary files.`;
  for (const value of paths) {
    if (value.length > 4096) return inside;
    const target = portCanonical(value);
    if (target === null || target === folder || target.startsWith(`${folder}/`)) return inside;
    if (tree && (target === '' || folder.startsWith(`${target}/`))) {
      return `ERROR: ${name} was not run: that folder contains the Diary folder, and Diary content is never sent to ${label}. Search a folder that does not contain the Diary.`;
    }
  }
  return null;
}

// ── Rows ────────────────────────────────────────────────────────────────────
const rows = [];
/** One row: `port` is the mirrored port answer, `js` the JS's; equal unless the row is strict. */
function row(op, args, port, js, stricterOk) {
  const wire = JSON.stringify(args);
  const want = JSON.stringify(port);
  if (touched) {
    if (!stricterOk(port, js)) throw Error(`port lets out more than the JS: op ${op} ${wire}`);
    rows.push({ op, wire, want, strict: true });
  } else {
    if (want !== JSON.stringify(js)) throw Error(`mirror disagrees with the JS: op ${op} ${wire}\n${want}\n${JSON.stringify(js)}`);
    rows.push({ op, wire, want });
  }
  touched = false;
}
const refusalAtLeast = (port, js) => js.refusal === null || port.refusal !== null;

function externalRow(p) {
  touched = false;
  const port = { external: portExternal(p), trial: portTrial(p) };
  row(1, [p], port, { external: pe.isExternalProviderJs(p), trial: pe.isTrialTermsHostJs(p) },
    (a, b) => (a.external ?? true) >= b.external && (a.trial ?? true) >= b.trial);
}
function egressRow(p, spaceId, projectId, diaryProjectId) {
  touched = false;
  const port = { refusal: portEgressRefusal(p, spaceId, projectId, diaryProjectId) };
  row(2, [p, spaceId, projectId, diaryProjectId], port, { refusal: pe.egressRefusalJs({ provider: p, spaceId, projectId, diaryProjectId }) }, refusalAtLeast);
}
function stripRow(p, selected) {
  touched = false;
  const port = { removed: strictExternal(p) ? selected.flatMap((id, i) => (id === 'diary' ? [i] : [])) : [] };
  const copy = selected.slice();
  const removedIds = pe.stripPrivateToolboxesJs(copy, p);
  const js = { removed: removedIds.length ? selected.flatMap((id, i) => (id === 'diary' ? [i] : [])) : [] };
  row(3, [p, selected], port, js, (a, b) => b.removed.every((i) => a.removed.includes(i)));
}
function toolRow(p, name, rawArgs, s) {
  touched = false;
  const port = { refusal: portToolRefusal(p, name, rawArgs, s) };
  row(4, [p, name, rawArgs, s], port, { refusal: pe.toolRefusalJs({ provider: p, toolName: name, rawArgs, storage: s }) }, refusalAtLeast);
}
function canonicalRow(paths) {
  touched = false;
  const port = { canonical: paths.map(portCanonical) };
  const sawUnknown = touched;
  touched = false;
  const js = { canonical: paths.map((x) => (port.canonical.includes(null) ? null : pe.canonicalPath(x))) };
  touched = sawUnknown;
  if (!sawUnknown) js.canonical = paths.map((x) => pe.canonicalPath(x));
  row(5, [paths], port, js, () => true);
}
function folderRow(s) {
  touched = false;
  const port = portFolder(s);
  row(6, [s], port, { folder: pe.diaryFolderFor(s), known: true }, (a) => !a.known || a.folder !== null);
}

const prov = (kind, external, baseUrl, label) => ({ kind, external, baseUrl, label });
const LOCAL = prov(null, false, 'http://llama:8080/v1', 'Local');
const CHATGPT = prov('chatgpt-oauth', false, 'https://chatgpt.com/backend-api/codex', 'ChatGPT');
const FLAGGED = prov(null, true, 'https://router.example/v1', '');
const NIM = prov(null, false, 'https://integrate.api.nvidia.com/v1', 'NIM');
const UNKNOWN_HOST = prov(null, false, 'https://\uff4e\uff56\uff49\uff44\uff49\uff41.com/v1', 'Wide');
const PROVIDERS = [null, LOCAL, CHATGPT, FLAGGED, NIM, UNKNOWN_HOST,
  ...['https://NVIDIA.COM./v1', 'https://nvidia.com.evil.example/v1', 'https://evilnvidia.com/v1', 'http://localhost:8000/v1', 'not a url',
    'undefined', '', 'https://user:pw@api.nvidia.com:443/v1', 'http://[::1]:8000/v1', 'https://xn--nvidia-abc.com/', 'https://%6Evidia.com/',
    'HTTPS://API.NVIDIA.COM/V1', 'https://api.nvidia.com\\v1', 'ftp://nvidia.com/', 'https://nvidia.com:8443', 'https://nvidia.co/',
    'https://build.nvidia.com/x?y=%20', 'https://api.example/v1#nvidia.com', 'https://nvidia.com@api.example/', 'https://api.example/nvidia.com',
    'http://10.0.0.5:8000/v1', 'https://a.b.c.nvidia.com/'].map((u) => prov(null, false, u, '')),
  prov('chatgpt-oauth', false, 'https://\u00e9.example/', ''), prov('CHATGPT-OAUTH', false, 'http://x/', ''), prov('other', false, 'http://x/', 'Other')];
for (const p of PROVIDERS) externalRow(p);

for (const p of [null, LOCAL, CHATGPT, FLAGGED, NIM, UNKNOWN_HOST]) {
  for (const space of [null, 'diary', 'diary-extras', 'Diary', 'work', '', 'xdiary']) {
    for (const [a, b] of [[null, null], ['p1', 'p1'], ['p1', 'p2'], ['', ''], [1, 1], [true, true], [0, 0], [null, 'diary-project'], ['diary-project', 'diary-project']]) {
      egressRow(p, space, a, b);
    }
  }
}

for (const p of [null, LOCAL, CHATGPT, FLAGGED, NIM, UNKNOWN_HOST]) {
  for (const sel of [[], ['diary'], ['files', 'diary', 'web', 'diary'], ['Diary', 'diary ', null, 5], ['web', 'nextcloud']]) stripRow(p, sel);
}

const NC = (corpusRoot, baseUrl = 'https://nc.example/remote.php/dav/files/alice', kind = 'nextcloud') => ({ kind, corpusRoot, baseUrl });
const MAIN = NC('Diary');
const STORAGES = [null, MAIN, NC('Journal/2026', 'https://dav.example/remote.php/webdav/Shared', 'webdav'), NC('Diary', 'https://nc.example/', 's3'),
  NC(''), NC('   '), NC('/Diary/'), NC('Tageb\u00fccher'), NC('\u0414\u043d\u0435\u0432\u043d\u0438\u043a'), NC('\u65e5\u8a18'), NC('\u0397\u03bc\u03b5\u03c1\u03bf\u03bb\u03cc\u03b3\u03b9\u03bf'),
  NC('Caf\u00e9'), NC('Cafe\u0301'), NC('Diary', 'nc.example/remote.php/dav/files/alice/Notes'), NC('Diary', 'https://nc.example/'),
  NC('Diary', 'https://nc.example/REMOTE.PHP/dav/files/A%20B/Sub'), NC('Diary', 'https://nc.example/remote.php/dav/files/\u00fc/x'),
  NC('..'), NC('Diary', 'https://nc.example/remote.php/dav/files/alice/'), NC('%44iary'), NC('Diary', ''), NC('Diary', 'https://nc.example/a/remote.php/webdav'),
  { kind: null, corpusRoot: 'Diary', baseUrl: '' }];
for (const s of STORAGES) folderRow(s);

const TOOLS = ['nc_webdav_read_file', 'nc_webdav_list_directory', 'nc_webdav_search_files', 'nc_webdav_find_by_name', 'nc_webdav_find_by_type',
  'nc_webdav_move_resource', 'nc_webdav_list_favorites', 'diary_search', 'diary_', 'web_search', 'nc_webdav_search_files_x', '', 'Diary_search', 'nc_webdav_'];
const ARGS = ['{"path":"Diary/2026/a.md"}', '{"path":"/Diary"}', '{"path":"diary"}', '{"path":"Diary2/x"}', '{"path":"Work/a.md"}', '{"path":""}',
  '{"path":"/"}', '{"path":"%2FDiary%2Fa.md"}', '{"path":"%252FDiary"}', '{"path":"%25252544iary"}', '{"path":"Work/../Diary/a"}', '{"path":"Diary\\\\a"}',
  '{"path":"https://nc.example/remote.php/dav/files/alice/Diary/a"}', '{"path":"/remote.php/webdav/Diary"}', '{"source":"Work/a","destination":"Diary/a"}',
  '{"from":"Work","to":"Diary/x"}', '{"query":"Diary"}', '{"path":"Work","recursive":true}', '{"path":"Work","depth":"infinity"}', '{"path":"Work","depth":1}',
  '{"path":"","depth":0}', '{"paths":["Work/a","Diary/b"]}', '{"items":[{"path":"Diary/x"}]}', '{"a":{"b":{"c":{"path":"Diary"}}}}',
  '{"a":{"b":{"c":{"d":{"path":"Diary"}}}}}', '{"a":[[{"path":"Diary"}]]}', '{"a":[{"b":[{"path":"Diary"}]}]}', '{"path":"Tagebu%CC%88cher/a"}',
  '{"path":"\u0397\u03bc\u03b5\u03c1\u03bf\u03bb\u03cc\u03b3\u03b9\u03bf/a"}', '{"path":"Caf\u00e9/x"}', '{"path":"Tageb\u00fccher/a"}', '{"path":"TAGEB\u00dcCHER"}',
  '{"path":"\u0414\u041d\u0415\u0412\u041d\u0418\u041a/x"}', '{', '', 'null', '5', '"Diary"', '[{"path":"Diary"}]', '{"PATH":"Diary"}', '{"Recursive":true,"path":"Work"}',
  '{"deep":"0","path":"/"}', '{"deep":"1"}', '{"deep":-0,"q":1}', '{"deep":1.0,"path":""}', '{"deepest":null,"path":""}', '{"path":"Diary","path":"Work"}',
  '{"path":"Work","path":"Diary"}', '{"1":"Diary","path":"Work"}', '{"2":{"path":"Diary"}}', '{"toto":"Diary"}', '{"tox":"Diary"}', '{"path":"Work/a\\nb"}',
  '{"url":"https://other.example/remote.php/dav/files/bob/Diary/x\\n"}', '{"path":"%E0%A4%A"}', '{"path":"%25%32%46Diary"}', '{"href":"/remote.php/dav/files/alice"}',
  '{"path":"Shared"}', '{"path":"Shared/Journal"}', '{"path":"Shared/Journal/2026/x"}', '{"path":"Journal/2026"}', '{"path":"x\ud800"}', '{"path":"\\ud800"}',
  '{"target":["Diary"]}', '{"location":{"path":"Diary"}}', '{"path":5,"file":"Diary"}', '{"__proto__":{"path":"Diary"}}', ' {"path":"Diary"} ', '{"path":"Diary"}x'];
for (const name of TOOLS) for (const a of ARGS) toolRow(CHATGPT, name, a, MAIN);
for (const s of STORAGES) for (const a of ARGS.slice(0, 34)) toolRow(CHATGPT, 'nc_webdav_search_files', a, s);
for (const s of STORAGES) for (const a of ARGS.slice(0, 34)) toolRow(NIM, 'nc_webdav_read_file', a, s);
for (const p of PROVIDERS) for (const a of ['{"path":"Diary/x"}', '{"path":"Work/x"}', '{"q":"x"}']) for (const name of ['nc_webdav_read_file', 'nc_webdav_search_files', 'diary_read']) toolRow(p, name, a, MAIN);
// #1209: path arguments over 4096 code units are refused before any regex.
for (const n of [4096, 4097]) for (const p of [CHATGPT, LOCAL]) toolRow(p, 'nc_webdav_read_file', JSON.stringify({ path: 'W'.repeat(n) }), MAIN);
toolRow(CHATGPT, 'nc_webdav_read_file', JSON.stringify({ path: 'Work', to: `${'/remote.php/webdav/x'.repeat(250)}\n` }), MAIN);
// Non-string arguments (already parsed): falsy values are {}.
for (const raw of [{ path: 'Diary/x' }, { path: 'Work' }, null, 0, false, [], [{ path: 'Diary' }], { recursive: true }, 7, true])
  for (const name of ['nc_webdav_read_file', 'nc_webdav_search_files']) toolRow(CHATGPT, name, raw, MAIN);

const PATHS = ['https://h/remote.php/dav/files/u', 'https://h/remote.php/dav/files/u/', 'https://hremote.php/webdav/x', 'HTTPS://H/REMOTE.PHP/WEBDAV/X',
  'a/remote.php/webdav/x', 'remote.php/webdav', 'xremote.php/webdav/y', '/remote.php/dav/files//x', '/remote.php/dav/files/u\n/x', 'https://h/remote.php/webdav\n',
  'https://h/x/remote.php/webdav/remote.php/webdav/y', 'https://h/remote.php/webdav/a\u2028b', 'https://remote.php/webdav/x', 'http://h:8080/a', 'c:/x', 'c://x/y',
  '1http://x/y', 'ht~tp://x/y', 'https:///x', 'https://h', 'https://h/', 'a+b.c-d://h/x', 'https://h/remote.php/dav/files/u/remote.php/webdav/z',
  'https://remote.php/remote.php/webdav/q', 'https://remote.php/webdav/x\n/remote.php/webdav/y', '/remote.php/webdavx', '/remote.php/webdav/', '/remote.php/dav/files/',
  '/remote.php/dav/files/u', '\\remote.php\\webdav\\a', '%2Fremote.php%2Fwebdav%2FDiary', 'a\rb/remote.php/webdav/c', 'x/remote.php/dav/files/a\u2029/y',
  '', '.', '..', '../..', 'a/../../b', '//a//b//', './a/./b/.', 'A/B', '%41%42', '%2541', '%252541', '%25252541', '%', '%4', '%zz', '%C3%A9', '%C3', '%ED%A0%80',
  'Tageb\u00fccher', 'TAGEB\u00dcCHER', '\u0130stanbul', '\u0178', '\u01c5', '\u0414\u041d\u0415\u0412', '\uff21\uff22', '\u65e5\u8a18', '\ud83d\ude00/x', '\u2014-\u201c',
  'e\u0301', '\u03a3', 'x\ud800y', '\u212b', 'a\u0300', '%CC%81', 'caf%C3%A9', 'cafe%CC%81', '\u0410\u0306'];
for (const p of PATHS) canonicalRow([p]);
canonicalRow(PATHS.slice(0, 30));
canonicalRow([]);

// Seeded tool calls.
const SEG = ['Diary', 'diary', 'DIARY', 'Work', '..', '.', '', '%2F', '%2e%2e', '%2544', 'Tageb\u00fccher', '\u0397\u03bc', 'Cafe\u0301', 'remote.php', 'dav', 'files',
  'webdav', 'alice', 'https:', 'x y', '\u65e5\u8a18', 'Journal', '2026', 'Shared'];
const KEYS = ['path', 'dir', 'q', 'source', 'to', 'file_id', 'depth', 'recursive', 'items', 'name'];
const segPath = () => Array.from({ length: Math.floor(rand() * 5) }, () => pick(SEG)).join(pick(['/', '/', '\\', '//']));
function value(d) {
  const r = rand();
  if (d < 3 && r < 0.15) return Object.fromEntries(Array.from({ length: 1 + Math.floor(rand() * 2) }, () => [pick(KEYS), value(d + 1)]));
  if (d < 3 && r < 0.25) return Array.from({ length: Math.floor(rand() * 3) }, () => value(d + 1));
  if (r < 0.3) return pick([true, false, 0, 1, '0', '1', 2, null]);
  return (rand() < 0.1 ? 'https://nc.example/remote.php/dav/files/alice/' : rand() < 0.1 ? '/' : '') + segPath();
}
for (let i = 0; i < 600; i++) {
  const args = Object.fromEntries(Array.from({ length: Math.floor(rand() * 4) }, () => [pick(KEYS), value(0)]));
  toolRow(pick([CHATGPT, CHATGPT, CHATGPT, NIM, UNKNOWN_HOST, LOCAL]), pick(TOOLS.slice(0, 8)), JSON.stringify(args), pick(STORAGES.slice(1, 17)));
}
for (let i = 0; i < 200; i++) canonicalRow(Array.from({ length: 1 + Math.floor(rand() * 3) }, () => value(3)).filter((v) => typeof v === 'string'));

const counts = rows.reduce((m, r) => { const k = `${r.op}${r.strict ? 's' : ''}`; m[k] = (m[k] || 0) + 1; return m; }, {});
for (const k of ['1', '1s', '2', '2s', '3', '3s', '4', '4s', '5', '5s', '6', '6s']) if (!counts[k]) throw Error(`no ${k} rows`);
const refusing = rows.filter((r) => r.op === 4 && JSON.parse(r.want).refusal !== null && !r.strict).length;
if (refusing < 300) throw Error(`only ${refusing} JS refusals`);

process.stdout.write(`${JSON.stringify({ version: 1, rows })}\n`);
