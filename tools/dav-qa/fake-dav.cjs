'use strict';

// A small in-memory WebDAV server for rehearsing tools/dav-qa/dav-matrix.cjs without any real
// account (and for its unit test). Basic auth, PROPFIND Depth 0/1, MKCOL, PUT with If-Match /
// If-None-Match, GET with a single Range, HEAD, DELETE. Synthetic data only.
//
//   node tools/dav-qa/fake-dav.cjs [port]    prints NOEVIA_QA_DAV_URL for a rehearsal run

const crypto = require('node:crypto');
const http = require('node:http');

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** opts.faults: { staticEtag: true } makes every ETag identical (an etag-change defect);
 *  { noChallenge: true } omits WWW-Authenticate on 401; { ignoreIfMatch: true } skips 412. */
function createFakeDav({ user = 'noevia-qa', password = 'app-password-for-tests', prefix = '/remote.php/dav/files/noevia-qa/', faults = {} } = {}) {
  const tree = new Map([['', { dir: true }]]);
  const log = [];
  const etagOf = (n) => (faults.staticEtag ? '"static"' : `"${crypto.createHash('sha1').update(n.data).digest('hex').slice(0, 24)}"`);
  const parentOf = (rel) => rel.slice(0, Math.max(0, rel.lastIndexOf('/')));

  function propEntry(rel, n) {
    const href = encodeURI(prefix).replace(/%25/g, '%') + encodePath(rel) + (n.dir && rel ? '/' : '');
    const type = n.dir ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>';
    const rest = n.dir ? '' : `<d:getcontentlength>${n.data.length}</d:getcontentlength><d:getetag>${xmlEscape(etagOf(n))}</d:getetag>`;
    return `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop>${type}${rest}<d:getlastmodified>Wed, 14 Oct 2026 10:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (status, headers = {}, data = '') => { res.writeHead(status, headers); res.end(data); };
      const want = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
      log.push({ method: req.method, url: req.url, authorized: req.headers.authorization === want });
      if (req.headers.authorization !== want) {
        return send(401, faults.noChallenge ? {} : { 'WWW-Authenticate': 'Basic realm="fake dav", charset="UTF-8"' });
      }
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (!pathname.startsWith(prefix)) return send(404);
      const rel = pathname.slice(prefix.length).replace(/\/+$/, '');
      const node = tree.get(rel);
      switch (req.method) {
        case 'PROPFIND': {
          if (!node) return send(404);
          const depth = req.headers.depth === '0' ? 0 : 1;
          let xml = propEntry(rel, node);
          if (depth === 1 && node.dir) {
            for (const [k, v] of tree) if (k && parentOf(k) === rel && (rel === '' ? !k.includes('/') : true) && k !== rel) xml += propEntry(k, v);
          }
          return send(207, { 'Content-Type': 'application/xml; charset=utf-8' }, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${xml}</d:multistatus>`);
        }
        case 'MKCOL':
          if (node) return send(405);
          if (!tree.get(parentOf(rel))?.dir) return send(409);
          tree.set(rel, { dir: true });
          return send(201);
        case 'PUT': {
          if (!tree.get(parentOf(rel))?.dir) return send(409);
          if (node?.dir) return send(405);
          if (!faults.ignoreIfMatch) {
            if (req.headers['if-none-match'] === '*' && node) return send(412);
            if (req.headers['if-match'] && (!node || etagOf(node) !== req.headers['if-match'])) return send(412);
          }
          const n = { data: body };
          tree.set(rel, n);
          return send(node ? 204 : 201, { ETag: etagOf(n) });
        }
        case 'GET':
        case 'HEAD': {
          if (!node || node.dir) return send(node ? 405 : 404);
          const h = { ETag: etagOf(node), 'Accept-Ranges': 'bytes' };
          const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
          if (m && req.method === 'GET') {
            const a = Number(m[1]); const b = m[2] ? Math.min(Number(m[2]), node.data.length - 1) : node.data.length - 1;
            return send(206, { ...h, 'Content-Range': `bytes ${a}-${b}/${node.data.length}`, 'Content-Length': b - a + 1 }, node.data.subarray(a, b + 1));
          }
          res.writeHead(200, { ...h, 'Content-Length': node.data.length });
          return res.end(req.method === 'HEAD' ? undefined : node.data);
        }
        case 'DELETE': {
          if (!node) return send(404);
          for (const k of [...tree.keys()]) if (k === rel || k.startsWith(`${rel}/`)) tree.delete(k);
          return send(204);
        }
        default:
          return send(405, { Allow: 'OPTIONS, PROPFIND, MKCOL, PUT, GET, HEAD, DELETE' });
      }
    });
  });

  return {
    server, tree, log, user, password, prefix,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}${prefix}`))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

module.exports = { createFakeDav };

if (require.main === module) {
  const f = createFakeDav();
  f.listen().then((url) => {
    console.log(`NOEVIA_QA_DAV_URL=${url}\nNOEVIA_QA_DAV_USER=${f.user}\nNOEVIA_QA_DAV_APP_PASSWORD=${f.password}`);
    console.log('(fake server, synthetic data; Ctrl-C to stop)');
  });
}
