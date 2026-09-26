'use strict';
// Which paths are the web client's own places (#359), so the static fallback answers them with
// index.html and a shared link, a reload or Back/Forward to one of them opens the app there.
// src/routes.ts is the client's half (the full path <-> place mapping); tests/routes.test.cjs
// checks every path the client can produce is accepted here.
//
// Deliberately narrow: an unknown path still gets the JSON 404 it always did, /api/* is never a
// client route (an unmatched API call must not come back as a 200 HTML page), neither is a file
// under /assets/ that the build does not have. The page itself decides access: index.html carries
// no data, and a signed-out browser gets the sign-in screen, then the app at the same path.
// WebDAV is a separate listener (COWORK_DAV_PORT) and never reaches this.

const ID = '[A-Za-z0-9_-]{1,120}';
const SEG = '[^/]{1,600}';
const CLIENT_ROUTES = [
  /^\/$/,
  new RegExp(`^/(chat|projects|diary|archived|code|models|settings|customise|customize|plugins)/?$`),
  new RegExp(`^/c/${ID}/?$`),
  new RegExp(`^/p/${ID}(/(new|chats|sources|research|code|browser))?/?$`),
  /^\/settings\/[a-z][a-z0-9-]{0,39}\/?$/,
  /^\/(customise|customize|plugins)\/(skills|connectors|plugins|mcp|connected)\/?$/,
  new RegExp(`^/models/${SEG}$`),
];

function isClientRoute(pathname) {
  if (typeof pathname !== 'string' || pathname.length > 700) return false;
  if (pathname.startsWith('/api/') || pathname === '/api' || pathname.startsWith('/assets/')) return false;
  if (pathname.includes('\\') || pathname.startsWith('//')) return false;
  return CLIENT_ROUTES.some((re) => re.test(pathname));
}

/** The last mount in index.cjs: a file from the build if there is one, index.html for a client
 *  place, a JSON 404 for anything else. `staticFiles` is static-files.cjs; `json` is http.cjs's. */
function createStaticFallback({ staticFiles, indexFile, json }) {
  return function serveStatic(req, res, pathname) {
    const found = staticFiles.resolve(pathname);
    if (found && found.forbidden) return json(res, 403, { error: 'forbidden' });
    if (!found && !isClientRoute(pathname)) return json(res, 404, { error: 'not found' });
    try {
      return staticFiles.send(req, res, found ? found.filePath : indexFile, found ? pathname : '/');
    } catch {
      if (!res.headersSent) return json(res, 500, { error: 'read error' });
      return res.end();
    }
  };
}

module.exports = { isClientRoute, createStaticFallback };
