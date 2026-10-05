'use strict';
// A fetch that can only reach public addresses, decided at CONNECT time (#795).
//
// isPublicUrl (ssrf.cjs) resolves a name and checks every answer, but the
// request that follows resolves the name AGAIN. A server whose DNS answers
// with a short TTL can pass the check with a public address and then hand the
// connection a private one — the home network, the Docker network, a cloud
// metadata endpoint — with noevia's credentials and position attached
// (DNS rebinding). code-egress.cjs closes the same gap for coding tasks by
// connecting to the address it checked; this does the same for plain HTTP
// requests, by giving the socket a `lookup` that refuses a private answer.
// The address the socket connects to is, by construction, one that was just
// checked, so there is no second resolution to win a race against.
//
// Built on node:http/https rather than an undici dispatcher: undici is not a
// dependency of this server, and Node does not export the copy inside its
// built-in fetch. It returns a WHATWG Response, so callers written against
// fetch (mcp.cjs, mcp-oauth.cjs) use it unchanged. Deliberate differences from
// fetch: redirects are never followed (all callers already pass
// redirect:'error'), and no compression is requested.
//
// Use it ONLY where a public address is already required — directory and
// custom MCP servers, and their OAuth endpoints. The operator's MCP_SERVERS
// (a LAN Nextcloud MCP server, noevia's own loopback server) are trusted
// configuration and keep the ordinary fetch.
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');
const { Readable, pipeline } = require('node:stream');
const { isPrivateIp } = require('./ssrf.cjs');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
// RFC 9110 reason-phrase: HTAB, SP, VCHAR, obs-text.
const REASON_PHRASE_RE = /^[\t\x20-\x7e\x80-\xff]*$/;

function refusal(message) {
  return Object.assign(new Error(message), { code: 'EPRIVATEADDR' });
}

/**
 * A `lookup` for net/http/tls that resolves as usual and then refuses the
 * connection if ANY answer is not public — the same every-answer rule as
 * isPublicUrl. Accepts both shapes net uses: `all: true` (happy eyeballs,
 * the default since Node 20) and the single-address form.
 * @param {{ resolve?: typeof dns.lookup, isPublicAddress?: (ip: string) => boolean }} [opts]
 */
function createPublicOnlyLookup({ resolve = dns.lookup, isPublicAddress = (ip) => !isPrivateIp(ip) } = {}) {
  return function publicOnlyLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
    const done = (...args) => process.nextTick(callback, ...args);
    resolve(hostname, { ...opts, all: true }, (err, answers) => {
      if (err) return done(err);
      const list = (Array.isArray(answers) ? answers : [])
        .filter((a) => a && typeof a.address === 'string' && net.isIP(a.address))
        .map((a) => ({ address: a.address, family: net.isIP(a.address) }));
      if (!list.length) return done(Object.assign(new Error(`${hostname} did not resolve`), { code: 'ENOTFOUND' }));
      // The address itself stays out of the message: it reaches the model and the admin UI.
      if (!list.every((a) => isPublicAddress(a.address))) return done(refusal(`refused: ${hostname} resolves to a private address`));
      if (opts.all) return done(null, list);
      return done(null, list[0].address, list[0].family);
    });
  };
}

function requestBody(body, headers) {
  if (body == null) return null;
  const setType = (t) => { if (!headers.has('content-type')) headers.set('content-type', t); };
  if (typeof body === 'string') { setType('text/plain;charset=UTF-8'); return Buffer.from(body); }
  if (body instanceof URLSearchParams) { setType('application/x-www-form-urlencoded;charset=UTF-8'); return Buffer.from(body.toString()); }
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new TypeError('publicFetch: unsupported body type');
}

function decoded(res) {
  const encoding = String(res.headers['content-encoding'] || '').trim().toLowerCase();
  const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? zlib.createGunzip()
    : encoding === 'deflate' ? zlib.createInflate()
      : encoding === 'br' ? zlib.createBrotliDecompress() : null;
  if (!decoder) return res;
  return pipeline(res, decoder, () => {});
}

/**
 * @param {object} [opts]
 * @param {(ip: string) => boolean} [opts.isPublicAddress]
 * @param {typeof dns.lookup} [opts.resolve]   injected in tests to simulate rebinding
 * @param {boolean} [opts.allowLoopbackLiteral]   QA only (NOEVIA_QA_ALLOW_LOOPBACK_MCP): http://127.0.0.1 as an IP literal
 * @returns {(input: string|URL, init?: object) => Promise<Response>}
 */
function createPublicFetch({ isPublicAddress = (ip) => !isPrivateIp(ip), resolve = dns.lookup, allowLoopbackLiteral = false } = {}) {
  const lookup = createPublicOnlyLookup({ resolve, isPublicAddress });
  return async function publicFetch(input, init = {}) {
    const url = new URL(String(input));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError(`refused: ${url.protocol} is not http(s)`);
    if (url.username || url.password) throw new TypeError('refused: credentials in the URL');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // An IP literal is never looked up, so it is judged here instead. It cannot rebind.
    if (net.isIP(host) && !isPublicAddress(host) && !(allowLoopbackLiteral && host === '127.0.0.1')) {
      throw refusal(`refused: ${host} is a private address`);
    }
    const method = String(init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    const body = requestBody(init.body, headers);
    if (body) headers.set('content-length', String(body.length));
    const outgoing = {};
    headers.forEach((v, k) => { outgoing[k] = v; });
    const signal = init.signal || undefined;
    if (signal && signal.aborted) throw signal.reason ?? new DOMException('This operation was aborted', 'AbortError');

    return new Promise((resolvePromise, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request({
        protocol: url.protocol, hostname: host, port: url.port || undefined,
        path: `${url.pathname}${url.search}`, method, headers: outgoing,
        lookup, agent: false, signal,
      }, (res) => {
        // Everything here runs in an http 'response' event: a throw would be an uncaught
        // exception that takes the whole web process down, and the server on the other end is
        // a stranger's. So any failure building the Response rejects this one request instead.
        try {
          const status = res.statusCode || 0;
          if (REDIRECT_STATUSES.has(status) && init.redirect !== 'manual') {
            throw new TypeError(`refused: redirect (${status}) from ${url.origin}`);
          }
          if (status < 200 || status > 599) throw new TypeError(`unexpected HTTP status ${status} from ${url.origin}`);
          const responseHeaders = new Headers();
          for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
            try { responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]); } catch { /* an invalid header is dropped, as fetch does */ }
          }
          const empty = NULL_BODY_STATUSES.has(status) || method === 'HEAD';
          // The reason phrase is kept only when Response would accept it: llhttp lets control
          // characters through (`200 O\x01K`), and Response throws on them. Nothing reads it.
          const reason = String(res.statusMessage || '');
          const statusText = REASON_PHRASE_RE.test(reason) ? reason : '';
          const response = new Response(empty ? null : Readable.toWeb(decoded(res)), { status, statusText, headers: responseHeaders });
          if (empty) res.resume();
          resolvePromise(response);
        } catch (err) {
          res.resume();
          req.destroy();
          reject(err);
        }
      });
      req.on('error', reject);
      if (body) req.end(body); else req.end();
    });
  };
}

module.exports = { createPublicFetch, createPublicOnlyLookup };
