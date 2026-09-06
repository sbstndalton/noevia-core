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
// Deliberately read-only: the diary sidecar owns all corpus writes through its
// journaled backend; this module exists so the web server can *fetch* text for
// ingestion and nothing else.

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
  const response = await withRetry(() => fetch(target, {
    method: 'PROPFIND',
    headers: davHeaders(conn, { Depth: '1', 'Content-Type': 'application/xml' }),
    signal: AbortSignal.timeout(15000),
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
async function listFiles(conn, rawPath) {
  const path = safeRelativePath(rawPath);
  // Deterministic order regardless of what the server returns, and every
  // entry's `path` must be connection-absolute (browsed dir prefixed) so it
  // can be passed straight back to readTextFile.
  const sort = (entries) => entries.sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0)
    .map((e) => ({ ...e, path: path ? `${path}/${e.name}` : e.name }));
  if (connectionKind(conn) === 's3') return sort(await s3List(conn, path));
  const fullPath = joinRoot(conn.corpusRoot, path);
  if (!fullPath) return []; // a connection without a corpusRoot has no root dir to list
  return sort(await davList(conn, fullPath));
}

/** Read one text file. `rawPath` is connection-absolute. */
async function readTextFile(conn, rawPath) {
  const path = safeRelativePath(rawPath);
  if (!path) throw Object.assign(new Error('invalid path'), { status: 400 });
  const name = path.split('/').pop();
  if (!TEXT_EXTENSIONS.has(extensionOf(name))) {
    throw Object.assign(new Error(`"${name}" is not a supported text file`), { status: 400 });
  }
  const text = connectionKind(conn) === 's3'
    ? await s3Read(conn, path)
    : await davRead(conn, joinRoot(conn.corpusRoot, path));
  return { name, content: text.slice(0, READ_CAP), truncated: text.length > READ_CAP };
}

module.exports = { listFiles, readTextFile, isBrowsable, safeRelativePath, TEXT_EXTENSIONS, READ_CAP };
