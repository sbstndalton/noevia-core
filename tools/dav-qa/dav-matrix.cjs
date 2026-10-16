#!/usr/bin/env node
'use strict';

// DAV interoperability matrix against a throwaway QA account (sbstndalton/noevia#263).
//
// Reads the account from the environment only (never hardcoded, never printed):
//   NOEVIA_QA_DAV_URL           collection root, e.g. https://cloud.example/remote.php/dav/files/noevia-qa/
//   NOEVIA_QA_DAV_USER          the QA user (must contain "qa"; refuses an admin-looking account)
//   NOEVIA_QA_DAV_APP_PASSWORD  an app password for that user
// Optional: NOEVIA_QA_DAV_LARGE_MB (default 8), NOEVIA_QA_ALLOW_ANY_USER=1 to skip the "qa" name guard.
//
// Everything happens inside one dedicated folder "noevia-qa-matrix-<utc>-<rand>" created under the
// URL root and deleted afterwards (also on failure). Nothing outside that folder is written or
// deleted. Exactly one request is sent with a wrong password (servers throttle repeated failures).
//
//   node tools/dav-qa/dav-matrix.cjs --dry-run            show the plan and env status, no requests
//   node tools/dav-qa/dav-matrix.cjs --env-file ~/.config/noevia-qa/dav.env
//   node tools/dav-qa/dav-matrix.cjs [--json]
//
// Exit codes: 0 all rows PASS (SKIP/INFO allowed), 1 at least one FAIL, 2 bad configuration.

const crypto = require('node:crypto');
const fs = require('node:fs');

const ENV_KEYS = ['NOEVIA_QA_DAV_URL', 'NOEVIA_QA_DAV_USER', 'NOEVIA_QA_DAV_APP_PASSWORD'];
const FOLDER_PREFIX = 'noevia-qa-matrix-';
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop>'
  + '<d:resourcetype/><d:getetag/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';

const ROWS = [
  ['list-depth0', 'PROPFIND Depth 0 on the root and the QA folder'],
  ['list-depth1', 'PROPFIND Depth 1 lists the QA folder children'],
  ['read-text', 'PUT then GET a UTF-8 text file, bytes identical'],
  ['read-binary', 'PUT then GET all 256 byte values plus random bytes, sha256 identical'],
  ['large-file', 'PUT then GET a large file, sha256 identical, HEAD length matches (Range reported)'],
  ['names-unicode-space', 'Names with spaces, unicode, & and # round-trip and list decoded'],
  ['nested-folders', 'MKCOL three levels, write at depth, list each level'],
  ['etag-change', 'ETag changes on rewrite; stale If-Match 412; If-None-Match * on existing 412'],
  ['auth-401', 'Wrong password gets 401 (with WWW-Authenticate); right password still works'],
  ['cleanup', 'DELETE the QA folder; it is gone afterwards'],
];

// ── configuration ─────────────────────────────────────────────────────────────

function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Validates the environment. Returns { ok, problems, config } and never includes the password in problems. */
function readConfig(env) {
  const problems = [];
  for (const k of ENV_KEYS) if (!env[k]) problems.push(`${k} is not set`);
  let url = null;
  if (env.NOEVIA_QA_DAV_URL) {
    try {
      url = new URL(env.NOEVIA_QA_DAV_URL);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') problems.push('NOEVIA_QA_DAV_URL must be http or https');
      if (url.username || url.password) problems.push('NOEVIA_QA_DAV_URL must not contain credentials');
      if (url.search || url.hash) problems.push('NOEVIA_QA_DAV_URL must not have a query or fragment');
    } catch { problems.push('NOEVIA_QA_DAV_URL is not a valid URL'); }
  }
  const user = env.NOEVIA_QA_DAV_USER || '';
  if (user && !/qa/i.test(user) && env.NOEVIA_QA_ALLOW_ANY_USER !== '1') {
    problems.push('NOEVIA_QA_DAV_USER does not look like a QA account (needs "qa" in the name); use the throwaway noevia-qa user, never an admin');
  }
  if (/^(admin|root|administrator)$/i.test(user)) problems.push('NOEVIA_QA_DAV_USER must not be an admin account');
  const mb = env.NOEVIA_QA_DAV_LARGE_MB === undefined ? 8 : Number(env.NOEVIA_QA_DAV_LARGE_MB);
  if (!Number.isFinite(mb) || mb < 1 || mb > 256) problems.push('NOEVIA_QA_DAV_LARGE_MB must be 1..256');
  if (problems.length) return { ok: false, problems, config: null };
  let base = url.href;
  if (!base.endsWith('/')) base += '/';
  return { ok: true, problems: [], config: { baseUrl: base, user, password: env.NOEVIA_QA_DAV_APP_PASSWORD, largeMb: mb } };
}

function redact(text, config) {
  let s = String(text);
  if (config?.password) s = s.split(config.password).join('***');
  if (config?.password) s = s.split(Buffer.from(`${config.user}:${config.password}`).toString('base64')).join('***');
  return s;
}

// ── PROPFIND parsing ──────────────────────────────────────────────────────────

function decodeXml(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF) ? String.fromCodePoint(code) : m;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
  });
}

function tagText(block, name) {
  const m = new RegExp(`<(?:[A-Za-z0-9]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${name}>`).exec(block);
  return m ? decodeXml(m[1].trim()) : null;
}

/** Parses a 207 multistatus body into [{ href, path, name, isCollection, etag, length, modified, status }]. */
function parseMultistatus(xml) {
  const out = [];
  const re = /<(?:[A-Za-z0-9]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?response>/g;
  let m;
  while ((m = re.exec(String(xml)))) {
    const block = m[1];
    const href = tagText(block, 'href');
    if (href === null) continue;
    let path = href;
    try { path = decodeURIComponent(new URL(href, 'http://x').pathname); } catch { /* keep raw */ }
    const trimmed = path.replace(/\/+$/, '');
    const len = tagText(block, 'getcontentlength');
    const status = /HTTP\/1\.\d\s+(\d{3})/.exec(block);
    out.push({
      href,
      path,
      name: trimmed.slice(trimmed.lastIndexOf('/') + 1),
      isCollection: /<(?:[A-Za-z0-9]+:)?resourcetype(?:\s[^>]*)?>[\s\S]*?<(?:[A-Za-z0-9]+:)?collection\s*\/?>/.test(block),
      etag: tagText(block, 'getetag'),
      length: len === null || len === '' ? null : Number(len),
      modified: tagText(block, 'getlastmodified'),
      status: status ? Number(status[1]) : 200,
    });
  }
  return out;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function basicAuth(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

function encodePath(rel) {
  return rel.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

function makeClient(config, fetchImpl = fetch, timeoutMs = 60000) {
  async function request(method, rel, { headers = {}, body, password = config.password } = {}) {
    const url = config.baseUrl + encodePath(rel).replace(/^\/+/, '');
    const res = await fetchImpl(url, {
      method,
      redirect: 'manual',
      headers: { Authorization: basicAuth(config.user, password), ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const buf = method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, body: buf, text: () => buf.toString('utf8') };
  }
  return {
    request,
    propfind: async (rel, depth) => {
      const r = await request('PROPFIND', rel, { headers: { Depth: String(depth), 'Content-Type': 'application/xml' }, body: PROPFIND_BODY });
      return { ...r, entries: r.status === 207 ? parseMultistatus(r.text()) : [] };
    },
    mkcol: (rel) => request('MKCOL', rel.replace(/\/?$/, '/')),
    put: (rel, data, headers) => request('PUT', rel, { body: data, headers: { 'Content-Type': 'application/octet-stream', ...headers } }),
    get: (rel, headers) => request('GET', rel, { headers }),
    head: (rel) => request('HEAD', rel),
    del: (rel) => request('DELETE', rel.replace(/\/?$/, '/')),
  };
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ok2xx = (s) => s >= 200 && s < 300;

class Check extends Error {}
function expect(cond, message) { if (!cond) throw new Check(message); }

// ── rows ──────────────────────────────────────────────────────────────────────

function buildRows(client, config, folder, state) {
  const f = (rel) => `${folder}/${rel}`;
  const rows = {};

  rows['list-depth0'] = async () => {
    const root = await client.propfind('', 0);
    expect(root.status === 207, `root PROPFIND Depth 0 gave ${root.status}, expected 207`);
    expect(root.entries.length === 1 && root.entries[0].isCollection, 'root Depth 0 must return exactly one collection');
    const mk = await client.mkcol(folder);
    if (ok2xx(mk.status)) state.created = true;
    expect(mk.status === 201, `MKCOL of the QA folder gave ${mk.status}, expected 201`);
    const own = await client.propfind(folder, 0);
    expect(own.status === 207 && own.entries.length === 1 && own.entries[0].isCollection, `QA folder Depth 0 gave ${own.status} / ${own.entries.length} entries`);
    return `root and ${folder} are collections (207)`;
  };

  rows['list-depth1'] = async () => {
    const text = Buffer.from('depth1 listing\n');
    expect(ok2xx((await client.put(f('listed.txt'), text)).status), 'PUT listed.txt failed');
    expect(ok2xx((await client.mkcol(f('subdir'))).status), 'MKCOL subdir failed');
    const r = await client.propfind(folder, 1);
    expect(r.status === 207, `Depth 1 gave ${r.status}`);
    const names = r.entries.map((e) => e.name);
    expect(names.includes('listed.txt') && names.includes('subdir'), `Depth 1 children were ${JSON.stringify(names)}`);
    const file = r.entries.find((e) => e.name === 'listed.txt');
    expect(file.length === text.length, `listed.txt length ${file.length}, expected ${text.length}`);
    expect(file.etag, 'listed.txt has no getetag');
    expect(r.entries.find((e) => e.name === 'subdir').isCollection, 'subdir is not a collection');
    return `${r.entries.length} entries (self + ${r.entries.length - 1} children), length and etag present`;
  };

  rows['read-text'] = async () => {
    const text = 'Line one\nZeile zwei: äöü ß\nTrailing newline\n';
    expect(ok2xx((await client.put(f('read.md'), Buffer.from(text, 'utf8'), { 'Content-Type': 'text/markdown' })).status), 'PUT read.md failed');
    const g = await client.get(f('read.md'));
    expect(g.status === 200, `GET gave ${g.status}`);
    expect(g.text() === text, 'text body differs from what was written');
    return `${Buffer.byteLength(text)} bytes identical`;
  };

  rows['read-binary'] = async () => {
    const all = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const data = Buffer.concat([all, crypto.randomBytes(4096), all]);
    expect(ok2xx((await client.put(f('blob.bin'), data)).status), 'PUT blob.bin failed');
    const g = await client.get(f('blob.bin'));
    expect(g.status === 200, `GET gave ${g.status}`);
    expect(g.body.length === data.length, `length ${g.body.length}, expected ${data.length}`);
    expect(sha(g.body) === sha(data), 'sha256 differs');
    return `${data.length} bytes, sha256 identical`;
  };

  rows['large-file'] = async () => {
    const size = config.largeMb * 1024 * 1024;
    const data = crypto.randomBytes(size);
    const p = await client.put(f('large.bin'), data);
    expect(ok2xx(p.status), `PUT large file gave ${p.status}`);
    const h = await client.head(f('large.bin'));
    expect(h.status === 200 && Number(h.headers.get('content-length')) === size, `HEAD ${h.status} content-length ${h.headers.get('content-length')}, expected ${size}`);
    const g = await client.get(f('large.bin'));
    expect(g.status === 200 && g.body.length === size, `GET ${g.status}, ${g.body.length} bytes`);
    expect(sha(g.body) === sha(data), 'sha256 differs');
    const rg = await client.get(f('large.bin'), { Range: 'bytes=0-99' });
    const range = rg.status === 206 ? `Range 206 (${rg.body.length} bytes)` : `Range ignored (${rg.status}, clients fall back to a full download)`;
    expect(rg.status === 206 ? sha(rg.body) === sha(data.subarray(0, 100)) : rg.status === 200, `Range request gave ${rg.status}`);
    return `${config.largeMb} MiB sha256 identical; ${range}`;
  };

  rows['names-unicode-space'] = async () => {
    const names = ['with space.md', 'Ünïcödé ✓ 日本語.md', 'a&b #1 %20.md', 'emoji 🙂.txt'];
    for (const n of names) {
      const body = Buffer.from(`content of ${n}\n`);
      expect(ok2xx((await client.put(f(n), body)).status), `PUT ${JSON.stringify(n)} failed`);
      const g = await client.get(f(n));
      expect(g.status === 200 && g.body.equals(body), `GET ${JSON.stringify(n)} gave ${g.status} / wrong bytes`);
    }
    const dir = 'Ordner mit Leerzeichen & Ü';
    expect(ok2xx((await client.mkcol(f(dir))).status), 'MKCOL of a folder with space and unicode failed');
    const r = await client.propfind(folder, 1);
    const listed = new Set(r.entries.map((e) => e.name.normalize('NFC')));
    for (const n of [...names, dir]) expect(listed.has(n.normalize('NFC')), `listing lacks ${JSON.stringify(n)} (saw ${JSON.stringify([...listed])})`);
    return `${names.length} files + 1 folder round-trip and list decoded`;
  };

  rows['nested-folders'] = async () => {
    const chain = ['lvl1', 'lvl1/lvl 2', 'lvl1/lvl 2/lvl3 ü'];
    for (const c of chain) expect(ok2xx((await client.mkcol(f(c))).status), `MKCOL ${c} failed`);
    const deep = Buffer.from('deep\n');
    expect(ok2xx((await client.put(f(`${chain[2]}/deep.md`), deep)).status), 'PUT at depth 3 failed');
    const g = await client.get(f(`${chain[2]}/deep.md`));
    expect(g.status === 200 && g.body.equals(deep), 'deep file did not read back');
    const missing = await client.mkcol(f('nope/child'));
    expect(missing.status === 409, `MKCOL with a missing parent gave ${missing.status}, expected 409`);
    const again = await client.mkcol(f(chain[0]));
    expect(again.status === 405, `MKCOL on an existing folder gave ${again.status}, expected 405`);
    for (let i = 0; i < chain.length; i++) {
      const r = await client.propfind(f(chain[i]), 1);
      expect(r.status === 207, `listing ${chain[i]} gave ${r.status}`);
      const want = i + 1 < chain.length ? chain[i + 1].split('/').pop() : 'deep.md';
      expect(r.entries.some((e) => e.name === want), `${chain[i]} does not list ${want}`);
    }
    return 'three levels created, deep write/read, 409 missing parent, 405 existing';
  };

  rows['etag-change'] = async () => {
    const p1 = await client.put(f('etag.md'), Buffer.from('version one\n'));
    expect(ok2xx(p1.status), `first PUT gave ${p1.status}`);
    const e1 = (await client.head(f('etag.md'))).headers.get('etag');
    expect(e1, 'no ETag header after the first write');
    const same = (await client.head(f('etag.md'))).headers.get('etag');
    expect(same === e1, 'ETag is not stable across two reads of unchanged content');
    const ps = await client.propfind(f('etag.md'), 0);
    expect(ps.entries[0]?.etag && ps.entries[0].etag.replace(/^W\//, '') === e1.replace(/^W\//, ''), `PROPFIND getetag ${ps.entries[0]?.etag} differs from the ETag header ${e1}`);
    const p2 = await client.put(f('etag.md'), Buffer.from('version two, longer\n'), { 'If-Match': e1 });
    expect(ok2xx(p2.status), `PUT with the current If-Match gave ${p2.status}`);
    const e2 = (await client.head(f('etag.md'))).headers.get('etag');
    expect(e2 && e2 !== e1, `ETag did not change after a rewrite (${e1} -> ${e2})`);
    const stale = await client.put(f('etag.md'), Buffer.from('lost update\n'), { 'If-Match': e1 });
    expect(stale.status === 412, `stale If-Match gave ${stale.status}, expected 412`);
    const create = await client.put(f('etag.md'), Buffer.from('should not overwrite\n'), { 'If-None-Match': '*' });
    expect(create.status === 412, `If-None-Match * on an existing file gave ${create.status}, expected 412`);
    const g = await client.get(f('etag.md'));
    expect(g.text() === 'version two, longer\n', 'a refused write changed the file');
    const fresh = await client.put(f('etag-new.md'), Buffer.from('new\n'), { 'If-None-Match': '*' });
    expect(ok2xx(fresh.status), `If-None-Match * create gave ${fresh.status}`);
    return `${e1} -> ${e2}; stale If-Match 412; create-only 412; refused writes left the file intact`;
  };

  rows['auth-401'] = async () => {
    const bad = await client.request('PROPFIND', '', { headers: { Depth: '0' }, body: PROPFIND_BODY, password: `${config.password}-wrong` });
    expect(bad.status === 401, `wrong password gave ${bad.status}, expected 401`);
    const challenge = bad.headers.get('www-authenticate') || '';
    expect(/basic/i.test(challenge), `401 lacks a Basic WWW-Authenticate challenge (got ${JSON.stringify(challenge)})`);
    const good = await client.propfind('', 0);
    expect(good.status === 207, `right password after a 401 gave ${good.status}`);
    return `401 with ${challenge}; right password still 207 (one wrong attempt sent)`;
  };

  rows.cleanup = async () => {
    const d = await client.del(folder);
    expect(ok2xx(d.status), `DELETE of the QA folder gave ${d.status}`);
    const gone = await client.propfind(folder, 0);
    expect(gone.status === 404, `QA folder still answers ${gone.status} after DELETE`);
    return 'QA folder deleted, PROPFIND 404';
  };

  return rows;
}

// ── runner and report ─────────────────────────────────────────────────────────

function newFolderName(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z');
  return `${FOLDER_PREFIX}${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

async function runMatrix(config, { fetchImpl = fetch, folder = newFolderName(), onRow } = {}) {
  const client = makeClient(config, fetchImpl);
  const state = { created: false };
  const impl = buildRows(client, config, folder, state);
  const results = [];
  for (const [id, title] of ROWS) {
    const started = Date.now();
    let result;
    if (id !== 'list-depth0' && !state.created) {
      result = { id, title, status: 'SKIP', detail: id === 'cleanup' ? 'nothing was created, nothing to delete' : 'skipped: the QA folder was not created' };
    } else {
      try {
        result = { id, title, status: 'PASS', detail: await impl[id]() };
      } catch (err) {
        const detail = err instanceof Check ? err.message : `${err?.name || 'Error'}: ${err?.message || err}`;
        result = { id, title, status: 'FAIL', detail: redact(detail, config) };
      }
    }
    result.ms = Date.now() - started;
    results.push(result);
    if (onRow) onRow(result);
  }
  // Cleanup is the last row and runs whenever the folder was created, even after earlier failures.
  const cleanup = results.find((r) => r.id === 'cleanup');
  const leftover = state.created && cleanup.status !== 'PASS' ? folder : null;
  return { folder, results, leftover };
}

function renderTable(results) {
  const rows = results.map((r) => [r.status, r.id, `${r.ms} ms`, r.detail]);
  const head = ['RESULT', 'CHECK', 'TIME', 'DETAIL'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const cap = (s, w, last) => (last ? String(s) : String(s).padEnd(w));
  const line = (cells) => cells.map((c, i) => cap(c, widths[i], i === cells.length - 1)).join('  ');
  const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return [
    line(head),
    line(widths.map((w) => '-'.repeat(Math.min(w, 24)))),
    ...rows.map(line),
    '',
    `${counts.PASS} pass, ${counts.FAIL} fail, ${counts.SKIP} skipped of ${results.length}`,
  ].join('\n');
}

function renderDryRun(env, parsed) {
  const lines = ['DRY RUN: no request will be sent.', ''];
  for (const k of ENV_KEYS) lines.push(`  ${k}: ${env[k] ? (k.endsWith('PASSWORD') ? 'set (hidden)' : env[k]) : 'MISSING'}`);
  lines.push(`  NOEVIA_QA_DAV_LARGE_MB: ${env.NOEVIA_QA_DAV_LARGE_MB || '8 (default)'}`);
  lines.push('');
  if (!parsed.ok) { lines.push('Configuration problems:'); for (const p of parsed.problems) lines.push(`  - ${p}`); lines.push(''); }
  lines.push(`Would create folder "${FOLDER_PREFIX}<utc>-<rand>" under the URL root, run these rows, and delete the folder:`);
  for (const [id, title] of ROWS) lines.push(`  ${id.padEnd(20)} ${title}`);
  return lines.join('\n');
}

async function main(argv, env, io = { out: (s) => console.log(s), err: (s) => console.error(s) }, fetchImpl = fetch) {
  const args = new Set(argv.filter((a) => a.startsWith('--') && a !== '--env-file'));
  const fi = argv.indexOf('--env-file');
  let merged = { ...env };
  if (fi >= 0) {
    const file = argv[fi + 1];
    if (!file) { io.err('--env-file needs a path'); return 2; }
    try { merged = { ...parseEnvFile(fs.readFileSync(file, 'utf8')), ...env }; } catch (e) { io.err(`cannot read ${file}: ${e.message}`); return 2; }
  }
  const parsed = readConfig(merged);
  if (args.has('--dry-run')) { io.out(renderDryRun(merged, parsed)); return parsed.ok ? 0 : 2; }
  if (!parsed.ok) { for (const p of parsed.problems) io.err(`error: ${p}`); io.err('Run with --dry-run to see what is expected.'); return 2; }
  const json = args.has('--json');
  if (!json) io.out(`Running ${ROWS.length} rows as ${parsed.config.user} against ${parsed.config.baseUrl}\n`);
  const run = await runMatrix(parsed.config, { fetchImpl });
  if (json) io.out(JSON.stringify({ folder: run.folder, leftover: run.leftover, results: run.results }, null, 2));
  else {
    io.out(renderTable(run.results));
    if (run.leftover) io.out(`\nWARNING: cleanup failed. Delete the folder "${run.leftover}" by hand in the QA account.`);
  }
  return run.results.some((r) => r.status === 'FAIL') ? 1 : 0;
}

module.exports = { ENV_KEYS, ROWS, parseEnvFile, readConfig, parseMultistatus, runMatrix, renderTable, renderDryRun, redact, main };

if (require.main === module) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (e) => { console.error(`fatal: ${e?.message || e}`); process.exitCode = 1; });
}
