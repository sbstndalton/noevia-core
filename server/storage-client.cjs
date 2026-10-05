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
const { normalizeS3Region } = require('./s3-region.cjs');


// PROPFIND <href> text is XML-escaped (&amp; &lt; &gt; &quot; &apos; and numeric refs like &#38;);
// it has to be decoded back to the real path before parsing as a URL, or an escaped name (e.g.
// "a&b.md" sent as "a&amp;b.md") lists under the escaped spelling and 404s on every read.
function decodeXmlEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      // A hostile body can name a code point String.fromCodePoint refuses (out of range, or a
      // lone surrogate): leave the original text alone rather than throwing and losing the listing.
      const valid = Number.isFinite(code) && code > 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF);
      return valid ? String.fromCodePoint(code) : m;
    }
    switch (ent) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return m;
    }
  });
}

// ── PROPFIND parsing (#787) ───────────────────────────────────────────────────
// A multistatus body comes from a server the user (or an administrator) configured, so it is
// untrusted input up to LIST_BODY_CAP bytes. The old lazy `<response>([\s\S]*?)</response>`
// regex rescanned to the end of the body from every unclosed opening tag, which is quadratic
// on a hostile body and blocks the event loop for every tenant. These scans move forward only.

const isTagNameChar = (code) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/** At `i` (a '<'), the index just past `<[prefix:]name>` (or `</[prefix:]name>` when
 *  `closing`), else -1. The prefix is the same [A-Za-z0-9]+ the old patterns accepted. */
function tagEndAt(body, i, name, closing) {
  let j = i + 1;
  if (closing) { if (body.charCodeAt(j) !== 47 /* / */) return -1; j++; }
  let k = j;
  while (k < body.length && isTagNameChar(body.charCodeAt(k))) k++;
  if (k > j && body.charCodeAt(k) === 58 /* : */) j = k + 1;
  return body.startsWith(name, j) && body.charCodeAt(j + name.length) === 62 /* > */ ? j + name.length + 1 : -1;
}

/** The text inside each `<[p:]name>…</[p:]name>` in `body`, in order, at most `limit` of them.
 *  Same matches as the lazy regex (nearest closing tag wins, any prefix on either side), in
 *  time linear in the body: once no closing tag follows an opening one, none can follow a
 *  later opening one either, so the scan stops. */
function elementTexts(body, name, limit = Infinity) {
  const out = [];
  const text = String(body);
  let pos = 0;
  while (out.length < limit) {
    let start = -1;
    for (let i = text.indexOf('<', pos); i !== -1; i = text.indexOf('<', i + 1)) {
      const end = tagEndAt(text, i, name, false);
      if (end !== -1) { start = end; break; }
    }
    if (start === -1) break;
    let close = -1, after = -1;
    for (let i = text.indexOf('</', start); i !== -1; i = text.indexOf('</', i + 2)) {
      const end = tagEndAt(text, i, name, true);
      if (end !== -1) { close = i; after = end; break; }
    }
    if (close === -1) break;
    out.push(text.slice(start, close));
    pos = after;
  }
  return out;
}
const firstElementText = (body, name) => elementTexts(body, name, 1)[0];

const READ_CAP = 200_000; // matches the project-file upload cap
const TEXT_BODY_CAP = READ_CAP * 4; // bytes read for a text preview (UTF-8 is at most 4 bytes a char)
const LIST_BODY_CAP = 4 * 1024 * 1024; // a directory listing response

/** Reads at most `cap` bytes of a response body as UTF-8, then cancels the rest of the stream. */
async function readCappedText(response, cap) {
  if (!response.body) return { text: '', capped: false };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0, capped = false;
  try {
    while (size < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = cap - size;
      const piece = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(Buffer.from(piece));
      size += piece.byteLength;
    }
    if (size >= cap) {
      const next = await reader.read().catch(() => ({ done: true }));
      if (!next.done) { capped = true; await reader.cancel().catch(() => {}); }
    }
  } finally { reader.releaseLock(); }
  // A multi-byte character cut at the cap decodes to U+FFFD; drop it.
  let text = Buffer.concat(chunks, size).toString('utf8');
  if (capped) text = text.replace(/\uFFFD$/, '');
  return { text, capped };
}
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
// are real answers, not transport noise. `once` disables the retry for a request that is not
// safe to repeat (a conditional PUT: the first attempt may have landed with its response lost).
async function withRetry(fn, { once = false } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (!once && err instanceof TypeError && err.message === 'fetch failed') {
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
  const { text: body } = await readCappedText(response, LIST_BODY_CAP);
  const entries = [];
  const requestDir = decodeURIComponent(new URL(target).pathname).replace(/\/+$/, '');
  for (const block of elementTexts(body, 'response')) {
    const hrefText = firstElementText(block, 'href');
    if (hrefText === undefined) continue;
    let href;
    try { href = decodeURIComponent(new URL(decodeXmlEntities(hrefText).trim(), target).pathname).replace(/\/+$/, ''); } catch { continue; }
    if (href !== requestDir && !href.startsWith(`${requestDir}/`)) continue; // a foreign href: not under the browsed directory
    const relative = href.slice(requestDir.length + 1);
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
  return readCappedText(response, TEXT_BODY_CAP);
}

/** #770: one Depth-0 PROPFIND against the connection's root, used before a WebDAV/Nextcloud
 *  connection is saved. Never throws and never puts the secret in what it returns.
 *  - { ok: true }                      the server accepted the login
 *  - { ok: false, rejected: true }     401: the username or app password is wrong
 *  - { ok: false, unverified: reason } 403 (some layouts refuse an unreadable root to an
 *                                      authenticated user), network error, timeout or another
 *                                      status: save with a warning */
async function checkLogin(conn, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  let response;
  try {
    // The root itself: davUrl('') would end in '//'.
    response = await fetchImpl(`${String(conn.baseUrl || '').replace(/\/+$/, '')}/`, {
      method: 'PROPFIND',
      headers: davHeaders(conn, { Depth: '0', 'Content-Type': 'application/xml' }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (timeout) return { ok: false, unverified: 'timeout' };
    // #776: with redirect:'error' undici throws TypeError('fetch failed') whose cause is
    // 'unexpected redirect'. The server was reached; the URL is likely http vs https or a slash.
    const cause = err && err.cause;
    if (err && err.name === 'TypeError' && cause && /redirect/i.test(String(cause.message || ''))) return { ok: false, unverified: 'redirect' };
    return { ok: false, unverified: 'network' };
  }
  try { await response.body?.cancel?.(); } catch { /* body not needed */ }
  if (response.status === 401) return { ok: false, rejected: true, status: 401 };
  if (response.ok || response.status === 207) return { ok: true };
  return { ok: false, unverified: 'status', status: response.status };
}

/** #849: did the storage server refuse the saved login (401, or 403 as #770 words it)? True for
 *  an error this module threw about a WebDAV answer: the folder/write errors carry `upstream`, the
 *  list/read ones say "storage returned <status>". Nothing else counts, so a 404 or a network
 *  failure keeps its own message. */
const LOGIN_REJECTED_STATUSES = new Set([401, 403]);
function refusedLogin(err) {
  if (!err) return false;
  if (LOGIN_REJECTED_STATUSES.has(err.upstream)) return true;
  return /^storage returned (401|403)$/.test(String(err.message || ''));
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
    headers: signS3Request('GET', url, '', conn.username || '', conn.secret || '', { region: normalizeS3Region(conn.region) }),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  }));
  if (!response.ok) throw new Error(`storage returned ${response.status}`);
  const { text: body } = await readCappedText(response, LIST_BODY_CAP);
  const entries = [];
  // Forward-only scans (elementTexts, #787): a hostile endpoint's body of unclosed tags cannot make
  // the old lazy regexes rescan the rest of the body from every opening tag (#833).
  for (const block of elementTexts(body, 'CommonPrefixes')) {
    const prefix = firstElementText(block, 'Prefix');
    if (prefix === undefined) continue;
    const full = prefix.replace(/\/+$/, '');
    const rel = queryPrefix && full.startsWith(queryPrefix) ? full.slice(queryPrefix.length) : full;
    if (!rel) continue;
    entries.push({ name: rel, path: rel, isDir: true, size: null, ext: '' });
  }
  for (const block of elementTexts(body, 'Contents')) {
    const full = firstElementText(block, 'Key');
    if (full === undefined || full.endsWith('/')) continue;
    const rel = queryPrefix && full.startsWith(queryPrefix) ? full.slice(queryPrefix.length) : full;
    if (!rel || rel.includes('/')) continue; // direct children only
    const sizeText = firstElementText(block, 'Size');
    entries.push({ name: rel, path: rel, isDir: false, size: sizeText !== undefined && /^\d+$/.test(sizeText) ? Number(sizeText) : null, ext: extensionOf(rel) });
  }
  return entries;
}

async function s3Read(conn, connectionPath) {
  const url = s3Url(conn, joinRoot(conn.corpusRoot, connectionPath));
  const response = await withRetry(() => fetch(url, {
    headers: signS3Request('GET', url, '', conn.username || '', conn.secret || '', { region: normalizeS3Region(conn.region) }),
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  }));
  if (!response.ok) throw new Error(`storage returned ${response.status}`);
  return readCappedText(response, TEXT_BODY_CAP);
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
  const { text, capped } = connectionKind(conn) === 's3'
    ? await s3Read(conn, path)
    : await davRead(conn, scoped ? joinRoot(conn.corpusRoot, path) : path);
  return { name, content: text.slice(0, READ_CAP), truncated: capped || text.length > READ_CAP };
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
      { status: response.status === 409 ? 400 : 502, upstream: response.status },
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
  const s3 = connectionKind(conn) === 's3';
  const full = s3 || scoped ? joinRoot(conn.corpusRoot, path) : path;
  const url = s3 ? s3Url(conn, full) : davUrl(conn, full);
  const response = await withRetry(() => fetch(url, {
    method: 'GET',
    headers: s3 ? signS3Request('GET', url, '', conn.username || '', conn.secret || '', { region: normalizeS3Region(conn.region) }) : davHeaders(conn, {}),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  }));
  if (!response.ok) {
    throw Object.assign(new Error(`storage returned ${response.status}`), { status: response.status === 404 ? 404 : 502, upstream: response.status });
  }
  const tooLarge = () => Object.assign(new Error(`file exceeds the ${cap} byte limit`), { status: 413 });
  if (Number(response.headers.get('content-length')) > cap) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) { await reader.cancel(); throw tooLarge(); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

/** Write one file, creating or replacing it. Used for a project's own folder,
 *  where noevia owns the contents — not a general "write anywhere" primitive,
 *  though nothing here enforces that beyond the caller. */
//
// `ifMatch` (an ETag from fileVersion) makes the PUT conditional: if the file changed in storage
// since that ETag was read, the server answers 412 and nothing is written. The error then carries
// `code: 'changed'`. A conditional PUT is never retried (#655): if the first attempt landed and only
// its response was lost, the retry would meet a 412 against noevia's own write. A connection
// failure or timeout is therefore reported as `code: 'unknown'` (the write may or may not have landed).
//
// `ifNoneMatch: '*'` makes the PUT create-only (#687): if anything already exists at the path the
// server answers 412 and nothing is written, with the same `code: 'changed'` and the same no-retry
// and `code: 'unknown'` rules as If-Match.
async function writeFile(conn, rawPath, bytes, { ifMatch, ifNoneMatch } = {}) {
  const path = safeRelativePath(rawPath);
  if (!path) throw Object.assign(new Error('invalid path'), { status: 400 });
  if (connectionKind(conn) === 's3') {
    throw Object.assign(new Error('writing to S3 is not supported'), { status: 400 });
  }
  if (ifMatch !== undefined && (typeof ifMatch !== 'string' || !ifMatch || /[\r\n]/.test(ifMatch))) {
    throw Object.assign(new Error('invalid If-Match value'), { status: 400 });
  }
  if (ifNoneMatch !== undefined && ifNoneMatch !== '*') throw Object.assign(new Error('invalid If-None-Match value'), { status: 400 });
  if (ifMatch !== undefined && ifNoneMatch !== undefined) throw Object.assign(new Error('If-Match and If-None-Match cannot be combined'), { status: 400 });
  const conditional = !!ifMatch || ifNoneMatch === '*';
  let response;
  try {
    response = await withRetry(() => fetch(davUrl(conn, path), {
      method: 'PUT',
      headers: davHeaders(conn, { 'Content-Type': 'application/octet-stream', ...(ifMatch ? { 'If-Match': quoteEtag(ifMatch) } : {}), ...(ifNoneMatch === '*' ? { 'If-None-Match': '*' } : {}) }),
      body: bytes,
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    }), { once: conditional });
  } catch (err) {
    if (!conditional) throw err;
    throw Object.assign(new Error(`the connection to storage failed while writing "${path}"; it may or may not have been saved`), { status: 502, code: 'unknown' });
  }
  if (conditional && response.status === 412) {
    throw Object.assign(new Error(ifMatch ? `"${path}" changed in storage before it could be written (412)` : `"${path}" already exists in storage, so it was not overwritten (412)`), { status: 409, code: 'changed' });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`could not write "${path}" (${response.status})`), { status: response.status === 409 ? 400 : 502, upstream: response.status });
  }
  return { path };
}

/** Delete one file. Deliberately refuses a directory path: removing a file
 *  from a project must never be able to take a folder — and everything under
 *  it — with it. A WebDAV DELETE of a collection is recursive, and a path does not say
 *  whether it names one, so the target is asked first (PROPFIND Depth 0, via fileVersion):
 *  a collection is refused, a missing path is reported missing without a DELETE, and an
 *  answer that settles neither refuses rather than guessing (#784). S3 is refused outright
 *  (it has no collections and no delete support here). */
async function deleteFile(conn, rawPath) {
  const path = safeRelativePath(rawPath);
  if (!path) throw Object.assign(new Error('invalid path'), { status: 400 });
  if (connectionKind(conn) === 's3') {
    throw Object.assign(new Error('deleting from S3 is not supported'), { status: 400 });
  }
  let state;
  try { state = await fileVersion(conn, path); }
  catch (err) {
    if (err && err.code === 'folder') throw Object.assign(new Error(`refusing to delete "${path}": it is a folder`), { status: 400, code: 'folder' });
    throw err;
  }
  if (!state.exists) return { path, missing: true };
  // With the file's ETag, the DELETE is conditional on it, so a path that became something else
  // (a folder, or a changed file) between the check and the delete is refused (412), not removed.
  const response = await withRetry(() => fetch(davUrl(conn, path), {
    method: 'DELETE',
    headers: davHeaders(conn, state.etag ? { 'If-Match': quoteEtag(state.etag) } : {}),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  }));
  if (response.status === 412) {
    throw Object.assign(new Error(`"${path}" changed in storage before it could be deleted; refresh and try again`), { status: 409, code: 'changed' });
  }
  if (response.status === 404) return { path, missing: true };
  if (!response.ok) {
    throw Object.assign(new Error(`could not delete "${path}" (${response.status})`), { status: 502 });
  }
  return { path, missing: false };
}

/** Remove one WebDAV collection only if it is empty right now. PROPFIND Depth 1 must list no
 *  children; DELETE then carries If-Match with the collection's ETag, so a child added in
 *  between changes the ETag and the server refuses (412) instead of deleting it. A server that
 *  reports no ETag gets no DELETE: without the precondition the check would be a race. */
async function removeEmptyFolder(conn, rawPath) {
  const path = safeRelativePath(rawPath);
  if (!path) throw Object.assign(new Error('invalid folder path'), { status: 400 });
  if (!['webdav', 'nextcloud'].includes(connectionKind(conn))) return { removed: false, reason: 'unsupported' };
  const target = davUrl(conn, path, true);
  const response = await withRetry(() => fetch(target, {
    method: 'PROPFIND',
    headers: davHeaders(conn, { Depth: '1', 'Content-Type': 'application/xml' }),
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>',
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  }));
  if (response.status === 404) return { removed: false, reason: 'missing' };
  if (response.status !== 207) return { removed: false, reason: 'error' };
  const body = await response.text();
  const requestDir = decodeURIComponent(new URL(target).pathname).replace(/\/+$/, '');
  let etag = '', isCollection = false, children = 0;
  for (const block of elementTexts(body, 'response')) {
    const hrefText = firstElementText(block, 'href');
    if (hrefText === undefined) continue;
    let href;
    try { href = decodeURIComponent(new URL(decodeXmlEntities(hrefText).trim(), target).pathname).replace(/\/+$/, ''); } catch { children++; continue; }
    if (href === requestDir) {
      isCollection = /<(?:[a-zA-Z0-9]+:)?collection\s*\/?>/.test(block);
      etag = (firstElementText(block, 'getetag') || '').trim()
        .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    } else children++;
  }
  if (!isCollection) return { removed: false, reason: 'not-directory' };
  if (children) return { removed: false, reason: 'not-empty' };
  if (!etag || /[\r\n]/.test(etag)) return { removed: false, reason: 'no-etag' };
  const del = await fetch(target, {
    method: 'DELETE',
    headers: davHeaders(conn, { 'If-Match': quoteEtag(etag) }),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (del.status === 404) return { removed: false, reason: 'missing' };
  if (del.status === 412) return { removed: false, reason: 'changed' };
  if (!del.ok) return { removed: false, reason: 'error' };
  return { removed: true };
}

const quoteEtag = (etag) => (etag.startsWith('"') || etag.startsWith('W/') ? etag : `"${etag}"`);

/** The current state of one WebDAV file, for a write that must not overwrite a change made in
 *  storage (#648): `{ exists: false }` on 404, else `{ exists: true, etag }`, where etag is ''
 *  when the server reports none. A collection, an S3 connection or any other answer throws,
 *  so a caller that needs certainty refuses rather than guessing. */
async function fileVersion(conn, rawPath) {
  const path = safeRelativePath(rawPath);
  if (!path) throw Object.assign(new Error('invalid path'), { status: 400 });
  if (!['webdav', 'nextcloud'].includes(connectionKind(conn))) {
    throw Object.assign(new Error('this storage cannot report a file version'), { status: 400, code: 'unsupported' });
  }
  const target = davUrl(conn, path);
  const response = await withRetry(() => fetch(target, {
    method: 'PROPFIND',
    headers: davHeaders(conn, { Depth: '0', 'Content-Type': 'application/xml' }),
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>',
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  }));
  if (response.status === 404) return { exists: false };
  if (response.status !== 207) throw Object.assign(new Error(`storage returned ${response.status}`), { status: 502, upstream: response.status });
  const body = await response.text();
  const block = firstElementText(body, 'response');
  if (!block) throw Object.assign(new Error('storage returned no file state'), { status: 502 });
  // Attributes on the element (`<d:collection xmlns:d="DAV:"/>`) still mean a folder. Bounded,
  // so a hostile body of unterminated `<collection ` tags stays linear to scan.
  if (/<(?:[a-zA-Z0-9]+:)?collection(?:\s[^>]{0,64})?\/?>/.test(block)) throw Object.assign(new Error(`"${path}" is a folder in storage`), { status: 409, code: 'folder' });
  const etag = (firstElementText(block, 'getetag') || '').trim()
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return { exists: true, etag: /[\r\n]/.test(etag) ? '' : etag };
}

module.exports = { checkLogin, refusedLogin, removeEmptyFolder, listFiles, readTextFile, readBinaryFile, writeFile, fileVersion, deleteFile, createFolder, isBrowsable, safeRelativePath, elementTexts, TEXT_EXTENSIONS, READ_CAP };
