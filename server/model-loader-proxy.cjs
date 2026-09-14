'use strict';
// Serves Model Loader (a separate service with no login of its own) at /model-loader
// for noevia administrators. The service has root-relative URLs, so URL-bearing HTML
// attributes, its fetch() calls, its palette JSON and redirect headers are prefixed.
// Only those contexts are rewritten: model paths such as "/models/x.gguf" also appear in
// form values and must reach models.ini unchanged.
//
// noevia's own session cookie and authorization never reach the upstream service.
const PREFIX = '/model-loader';
const FORWARD_REQUEST = ['accept', 'accept-language', 'content-type', 'hx-request', 'hx-target', 'hx-trigger', 'hx-trigger-name', 'hx-boosted', 'hx-prompt', 'hx-history-restore-request'];
const FORWARD_RESPONSE = ['content-type', 'cache-control', 'content-disposition', 'last-modified', 'etag', 'hx-trigger', 'hx-trigger-after-swap', 'hx-trigger-after-settle', 'hx-refresh', 'hx-reswap', 'hx-retarget', 'hx-reselect'];
const URL_HEADERS = ['location', 'hx-redirect', 'hx-location', 'hx-push-url', 'hx-replace-url'];
const MAX_REWRITE_BYTES = 16 * 1024 * 1024;
// Bundled scripts only; Alpine needs eval and Tailwind's runtime injects styles.
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const prefixUrl = value => (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith(PREFIX + '/') ? PREFIX + value : value);

function rewriteHtml(text) {
  return text
    .replace(/(\s(?:href|src|action|hx-get|hx-post|hx-put|hx-patch|hx-delete|hx-push-url|hx-replace-url|formaction)\s*=\s*)(["'])\/(?!\/|model-loader\/)/gi, (m, attr, quote) => `${attr}${quote}${PREFIX}/`)
    .replace(/\bfetch\((["'`])\/(?!\/|model-loader\/)/g, (m, quote) => `fetch(${quote}${PREFIX}/`);
}
function rewriteJson(text) {
  return text.replace(/("(?:url|href)"\s*:\s*")\/(?!\/|model-loader\/)/g, (m, key) => `${key}${PREFIX}/`);
}
function rewriteJs(text) {
  return text.replace(/\bfetch\((["'`])\/(?!\/|model-loader\/)/g, (m, quote) => `fetch(${quote}${PREFIX}/`);
}

function createModelLoaderProxy({ target, fetchImpl = fetch }) {
  const base = String(target || '').replace(/\/+$/, '');
  return async function proxy(req, res, url) {
    const upstreamPath = url.pathname.slice(PREFIX.length) || '/';
    const headers = {};
    for (const name of FORWARD_REQUEST) if (req.headers[name]) headers[name] = req.headers[name];
    // htmx reports the page it was called from; the service expects its own paths.
    const current = req.headers['hx-current-url'];
    if (typeof current === 'string') {
      try { const u = new URL(current); headers['hx-current-url'] = `${base}${u.pathname.startsWith(PREFIX) ? u.pathname.slice(PREFIX.length) || '/' : u.pathname}${u.search}`; } catch {}
    }
    const method = req.method || 'GET';
    let response;
    try {
      response = await fetchImpl(base + upstreamPath + url.search, {
        method, headers, redirect: 'manual',
        ...(['GET', 'HEAD'].includes(method) ? {} : { body: req, duplex: 'half' }),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
    } catch {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('Model Loader is not reachable. Check that its container is running.');
    }
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Cache-Control', response.headers.get('cache-control') || 'no-store');
    for (const name of FORWARD_RESPONSE) { const v = response.headers.get(name); if (v && name !== 'cache-control') res.setHeader(name, v); }
    for (const name of URL_HEADERS) {
      const v = response.headers.get(name);
      if (!v) continue;
      // Absolute redirects to the upstream address become noevia paths.
      let value = v;
      try { const u = new URL(v, base + '/'); if (u.origin === new URL(base).origin) value = u.pathname + u.search + u.hash; } catch {}
      res.setHeader(name, prefixUrl(value));
    }
    const type = (response.headers.get('content-type') || '').toLowerCase();
    const rewrite = type.includes('text/html') ? rewriteHtml : type.includes('json') ? rewriteJson : type.includes('javascript') ? rewriteJs : null;
    res.statusCode = response.status;
    if (!response.body || method === 'HEAD') return res.end();
    if (rewrite) {
      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_REWRITE_BYTES) { res.statusCode = 502; return res.end('Model Loader response too large.'); }
      const text = await response.text();
      return res.end(rewrite(text));
    }
    const length = response.headers.get('content-length');
    if (length) res.setHeader('Content-Length', length);
    for await (const chunk of response.body) if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve));
    res.end();
  };
}

module.exports = { createModelLoaderProxy, rewriteHtml, rewriteJson, rewriteJs, PREFIX };
