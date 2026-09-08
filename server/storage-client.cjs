'use strict';

// Browse/read access to a user's connected external storage, for pulling
// knowledge files into projects (and any future consumer of the same
// capability). Uses the connection shapes stored by authService.saveStorage:
//   { kind: 'webdav'|'nextcloud', baseUrl, username, secret, corpusRoot }
//   { kind: 's3', baseUrl (endpoint), bucket, username, secret, corpusRoot }
//   { kind: 'local' }  -> not browsable (it is this server's own disk; files
//                         are uploaded directly instead)
//
// Path contract: every path this module accepts or returns is
// connection-absolute — relative to the connection's corpusRoot ('' = the
// user's chosen root folder). The corpusRoot itself is joined in here and is
// never part of any path crossing this boundary.
//
// Reads are unrestricted within the connection; the only write is creating a
// directory. The diary sidecar still owns every corpus *content* write through
// its journaled backend — nothing here creates, edits or deletes a file.
//
// Browsing is rooted at the connection, not at corpusRoot. corpusRoot is a
// diary concept (where journal entries live) and scoping general file browsing
// to it meant a project could only ever attach sources from inside the diary
// folder. The diary reads its own tree through /api/diary/files, so it is
// unaffected by this.

const { signS3Request } = require('./s3-sign.cjs');

const READ_CAP = 200_000; // matches the project-file upload cap
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.yml', '.yaml',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.sh', '.html', '.css',
]);

function safeRelativePath(raw) {
  const value = String(raw || '').trim().replace(/\\/g, '/');
  if (!value || value.length > 500) return '';
  if (value.startsWith('/')) return '';
  const segments = value.split('/').filter(Boolean);
  if (!segments.length) return '';
  if (segments.some((s) => s === '.' || s === '..')) return '';
  return segments.join('/');
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function cleanRoot(corpusRoot) {
  return String(corpusRoot || '').replace(/^\/+|\/+$/g, '');
}

function joinRoot(corpusRoot, relative) {
  const root = cleanRoot(corpusRoot);
  return [root, relative].filter(Boolean).join('/');
}

// One bounded retry on network-level failures (connection reset, pooled dead
// socket after a server restart). HTTP error statuses are NOT retried — those
// are real answers, not transport noise.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TypeError && err.message === 'fetch failed') {
      await new Promise((r) => setTimeout(r, 250));
      return fn();
    }
    throw err;
  }
}

// ── WebDAV ───────────────────────────────────────────────────────────────────

function davUrl(conn, remotePath, trailingSlash) {
  const base = String(conn.baseUrl || '').replace(/\/+$/, '');
  const encoded = String(remotePath).split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `${base}/${encoded}${trailingSlash ? '/' : ''}`;
}

function davHeaders(conn, extra) {
  const headers = { ...extra };
  if (conn.username) {
    headers.Authorization = `Basic ${Buffer.from(`${conn.username}:${conn.secret || ''}`).toString('base64')}`;
  }
  return headers;
}

async function davList(conn, fullPath) {
  // fullPath is the complete DAV path (corpusRoot included) of the dir to list.
  const target = davUrl(conn, fullPath, true);
  // redirect:'error' everywhere in this module: a compromised or malicious
  // endpoint must not be able to bounce a request inward (to RFC1918 or the
  // cloud metadata address) and have us follow it. A server that redirects
  // should be configured by its final URL instead.
  const response = await withRetry(() => fetch(target, {
    method: 'PROPFIND',
    headers: davHeaders(conn, { Depth: '1', 'Content-Type': 'application/xml' }),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  }));
  if (response.status === 404) return [];
  if (!response.ok && response.status !== 207) throw new Error(`storage returned ${response.status}`);
  const body = await response.text();
  const entries = [];
  const requestDir = decodeURIComponent(new URL(target).pathname).replace(/\/+$/, '');
  for (const match of body.matchAll(/<(?:[a-zA-Z0-9]+:)?response>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?response>/g)) {
    const block = match[1];
    const hrefMatch = block.match(/<(?:[a-zA-Z0-9]+:)?href>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?href>/);
    if (!hrefMatch) continue;
    let href;
    try { href = decodeURIComponent(new URL(hrefMatch[1].trim(), target).pathname); } catch { continue; }
    const relative = href.replace(/\/+$/, '').slice(requestDir.length + 1);
    if (!relative || relative.includes('/')) continue; // direct children only
    const isDir = /<(?:[a-zA-Z0-9]+:)?collection\s*\/?>/.test(block);
    const sizeMatch = block.match(/<(?:[a-zA-Z0-9]+:)?getcontentlength>(\d+)</);
    entries.push({
      name: relative,
      path: relative, // caller joins the browsed dir back on
      isDir,
      size: sizeMatch ? Number(sizeMatch[1]) : null,
      ext: extensionOf(relative),
    });
  }
  return entries;
}

async function davRead(conn, fullPath) {
  const response = await withRetry(() => fetch(davUrl(conn, fullPath, false), {
    method: 'GET',
    headers: davHeaders(conn, {}),
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  }));
  if (!response.ok) throw new Error(`storage returned ${response.status}`);
  return response.text();
}

// ── S3-compatible ────────────────────────────────────────────────────────────

function s3Url(conn, key, query) {
  const endpoint = String(conn.baseUrl || '').replace(/\/+$/, '');
  const bucket = String(conn.bucket || '').replace(/\/+$/, '');
  const url = new URL(`${endpoint}/${[bucket, ...String(key).split('/').filter(Boolean)].map(encodeURIComponent).join('/')}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  return url;
}

async function s3List(conn, connectionPath) {
  const root = cleanRoot(conn.corpusRoot);
  // Bucket-key prefix of the requested directory ('' = whole bucket).
  const dirPrefix = joinRoot(root, connectionPath);
  const queryPrefix = dirPrefix ? `${dirPrefix}/` : '';
  const url = s3Url(conn, '', { 'list-type': '2', prefix: queryPrefix, delimiter: '/', 'max-keys': '1000' });
  const response = await withRetry(() => fetch(url, {
    headers: signS3Request('GET', url, '', conn.username || '', conn.secret || ''),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  }));
  if (!response.ok) throw new Error(`storage returned ${response.status}`);
  const body = await response.text();
  const entries = [];
  for (const match of body.matchAll(/<CommonPrefixes><Prefix>([\s\S]*?)<\/Prefix><\/CommonPrefixes>/g)) {
    const full = match[1].replace(/\/+$/, '');
    const rel = queryPrefix && full.startsWith(queryPrefix) ? full.slice(queryPrefix.length) : full;
    if (!rel) continue;
    entries.push({ name: rel, path: rel, isDir: true, size: null, ext: '' });
  }
  for (const match of body.matchAll(/<Contents><Key>([\s\S]*?)<\/Key>([\s\S]*?)<\/Contents>/g)) {
    const full = match[1];
    if (full.endsWith('/')) continue;
    const rel = queryPrefix && full.startsWith(queryPrefix) ? full.slice(queryPrefix.length) : full;
    if (!rel || rel.includes('/')) continue; // direct children only
    const sizeMatch = match[2].match(/<Size>(\d+)<\/Size>/);
    entries.push({ name: rel, path: rel, isDir: false, size: sizeMatch ? Number(sizeMatch[1]) : null, ext: extensionOf(rel) });
  }
  return entries;
}

async function s3Read(conn, connectionPath) {
  const url = s3Url(conn, joinRoot(conn.corpusRoot, connectionPath));
  const response = await withRetry(() => fetch(url, {
    headers: signS3Request('GET', url, '', conn.username || '', conn.secret || ''),
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  }));
  if (!response.ok) throw new Error(`storage returned ${response.status}`);
  return response.text();
}

// ── Public API ───────────────────────────────────────────────────────────────

function connectionKind(conn) {
  return conn && typeof conn.kind === 'string' ? conn.kind : 'local';
}

function isBrowsable(conn) {
  return ['webdav', 'nextcloud', 's3'].includes(connectionKind(conn));
}

/** List one directory level. `rawPath` is connection-absolute ('' = root). */
async function listFiles(conn, rawPath, opts) {
  const scoped = !!(opts && opts.scope === 'corpus');
  const path = safeRelativePath(rawPath);
  // Deterministic order regardless of what the server returns, and every
  // entry's `path` must be connection-absolute (browsed dir prefixed) so it
  // can be passed straight back to readTextFile.
  const sort = (entries) => entries.sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0)
    .map((e) => ({ ...e, path: path ? `${path}/${e.name}` : e.name }));
  if (connectionKind(conn) === 's3') return sort(await s3List(conn, path));
  const fullPath = scoped ? joinRoot(conn.corpusRoot, path) : path;
  // An unscoped browse of "" is the connection root, which is a real directory
  // — only a corpus-scoped browse needs a configured root to stand on.
  if (scoped && !fullPath) return [];
  return sort(await davList(conn, fullPath));
}

/** Read one text file. `rawPath` is connection-absolute. */
async function readTextFile(conn, rawPath, opts) {
  const scoped = !!(opts && opts.scope === 'corpus');
  const path = safeRelativePath(rawPath);
  if (!path) throw Object.assign(new Error('invalid path'), { status: 400 });
  const name = path.split('/').pop();
  if (!TEXT_EXTENSIONS.has(extensionOf(name))) {
    throw Object.assign(new Error(`"${name}" is not a supported text file`), { status: 400 });
  }
  const text = connectionKind(conn) === 's3'
    ? await s3Read(conn, path)
    : await davRead(conn, scoped ? joinRoot(conn.corpusRoot, path) : path);
  return { name, content: text.slice(0, READ_CAP), truncated: text.length > READ_CAP };
}

/** Create one directory. The only write this module performs: MKCOL creates a
 *  collection and nothing else — it cannot overwrite or delete, and 405 back
 *  from the server means the directory already exists, which is not a failure
 *  worth surfacing as one. S3 has no directories (a "folder" is just a key
 *  prefix), so there is nothing to create there and saying so is more honest
 *  than writing a zero-byte marker object. */
async function createFolder(conn, rawPath) {
  const path = safeRelativePath(rawPath);
  if (!path) throw Object.assign(new Error('invalid folder path'), { status: 400 });
  if (connectionKind(conn) === 's3') {
    throw Object.assign(
      new Error('S3 has no folders — a prefix appears once a file is stored under it'),
      { status: 400 },
    );
  }
  const response = await withRetry(() => fetch(davUrl(conn, path, true), {
    method: 'MKCOL',
    headers: davHeaders(conn, {}),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  }));
  if (response.status === 405) return { path, existed: true };
  if (!response.ok) {
    throw Object.assign(
      new Error(`could not create "${path}" (${response.status})`),
      { status: response.status === 409 ? 400 : 502 },
    );
  }
  return { path, existed: false };
}

/** Read one file as bytes, for a type that must be parsed rather than decoded
 *  (a PDF). No extension gate here: the caller decides what it can parse, and
 *  the cap is larger because a document compresses to text far smaller than
 *  its own size. */
async function readBinaryFile(conn, rawPath, opts) {
  const scoped = !!(opts && opts.scope === 'corpus');
  const cap = (opts && opts.cap) || 25 * 1024 * 1024;
  const path = safeRelativePath(rawPath);
  if (!path) throw Object.assign(new Error('invalid path'), { status: 400 });
  if (connectionKind(conn) === 's3') {
    const text = await s3Read(conn, path);
    return Buffer.from(text, 'binary');
  }
  const full = scoped ? joinRoot(conn.corpusRoot, path) : path;
  const response = await withRetry(() => fetch(davUrl(conn, full), {
    method: 'GET',
    headers: davHeaders(conn, {}),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  }));
  if (!response.ok) {
    throw Object.assign(new Error(`storage returned ${response.status}`), { status: response.status === 404 ? 404 : 502 });
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > cap) {
    throw Object.assign(new Error(`file is ${Math.round(buf.length / 1024 / 1024)} MB, over the ${Math.round(cap / 1024 / 1024)} MB limit`), { status: 413 });
  }
  return buf;
}

/** Write one file, creating or replacing it. Used for a project's own folder,
 *  where noevia owns the contents — not a general "write anywhere" primitive,
 *  though nothing here enforces that beyond the caller. */
async function writeFile(conn, rawPath, bytes) {
  const path = safeRelativePath(rawPath);
  if (!path) throw Object.assign(new Error('invalid path'), { status: 400 });
  if (connectionKind(conn) === 's3') {
    throw Object.assign(new Error('writing to S3 is not supported'), { status: 400 });
  }
  const response = await withRetry(() => fetch(davUrl(conn, path), {
    method: 'PUT',
    headers: davHeaders(conn, { 'Content-Type': 'application/octet-stream' }),
    body: bytes,
    signal: AbortSignal.timeout(60000),
    redirect: 'error',
  }));
  if (!response.ok) {
    throw Object.assign(new Error(`could not write "${path}" (${response.status})`), { status: response.status === 409 ? 400 : 502 });
  }
  return { path };
}

/** Delete one file. Deliberately refuses a directory path: removing a file
 *  from a project must never be able to take a folder — and everything under
 *  it — with it. */
async function deleteFile(conn, rawPath) {
  const path = safeRelativePath(rawPath);
  if (!path) throw Object.assign(new Error('invalid path'), { status: 400 });
  if (path.endsWith('/')) throw Object.assign(new Error('refusing to delete a directory'), { status: 400 });
  if (connectionKind(conn) === 's3') {
    throw Object.assign(new Error('deleting from S3 is not supported'), { status: 400 });
  }
  const response = await withRetry(() => fetch(davUrl(conn, path), {
    method: 'DELETE',
    headers: davHeaders(conn, {}),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  }));
  if (response.status === 404) return { path, missing: true };
  if (!response.ok) {
    throw Object.assign(new Error(`could not delete "${path}" (${response.status})`), { status: 502 });
  }
  return { path, missing: false };
}

module.exports = { listFiles, readTextFile, readBinaryFile, writeFile, deleteFile, createFolder, isBrowsable, safeRelativePath, TEXT_EXTENSIONS, READ_CAP };
