const { readCappedJson } = require('./http.cjs');
const MAX_UPLOAD = 32 * 1024 * 1024;
// The preview reply lists every file, directory, duplicate and conflict path
// (services/diary/agent/workspace_import.py prepare). Those paths all come from the archive's
// manifest, which the Diary caps at 8 MiB (workspace_restore.py), and each path can appear in at
// most about three of the lists (files or directories, then duplicates or conflicts), so the
// largest honest reply is about 3 x 8 MiB = 24 MiB (#920). An apply reply is tiny.
const MAX_REPLY = 3 * 8 * 1024 * 1024;
// `headers` is an object or `(withSecret) => headers`; with `retry` (diary.cjs withStorageCredential)
// a 428 from the sidecar is retried once with the storage secret. The body is buffered, so resending is safe.
async function proxyWorkspaceImport(req, res, url, headers, retry = (send) => send(true)) {
  const headersFor = typeof headers === 'function' ? headers : () => headers;
  const controller = new AbortController();
  const close = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', close);
  const deadline = setTimeout(() => { controller.abort(); if (!req.complete) req.destroy(); }, 120000);
  const send = (status, body) => {
    res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
    res.end(JSON.stringify(body));
  };
  try {
    const chunks = []; let size = 0;
    if (Number(req.headers['content-length']) > MAX_UPLOAD) return send(413, {error:'Browser imports support ZIP files up to 32 MiB'});
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_UPLOAD) return send(413, {error:'Browser imports support ZIP files up to 32 MiB'});
      chunks.push(chunk);
    }
    const payload = Buffer.concat(chunks);
    const response = await retry((secret) => fetch(url, {method:'POST', headers:{...headersFor(secret), 'Content-Type':'application/zip'}, body:payload, signal:controller.signal}));
    const body = await readCappedJson(response, MAX_REPLY);
    send(response.status, response.ok ? body : {error:typeof body.detail === 'string' ? body.detail : 'Workspace import failed'});
  } catch {
    if (!res.headersSent) send(502, {error:'Import response unavailable. Retry with the same file and folder to safely check whether it completed.'});
  } finally { clearTimeout(deadline); res.off('close',close); controller.abort(); }
}
module.exports = {proxyWorkspaceImport, MAX_UPLOAD, MAX_REPLY};
