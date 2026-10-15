'use strict';
// GET /api/export/conversations -> application/zip   the signed-in user's own chats only
// Returns true when it handled the request. Auth runs before routes are mounted.
const { buildExport } = require('../chat-export.cjs');

// The Rust front owns GET /api/export/conversations (#1315) only while NOEVIA_RUST_EXPORT=1 and the
// supervisor has confirmed it (NOEVIA_RUST_EXPORT_CONFIRMED=1, once `noevia-server --features` lists
// rust-export), over the confirmed M4 projects and free-chat slices: the front exports what is on
// disk, so the free-chat list must be one this process re-reads from disk as well.
function exportRustOwned(env) {
  return require('../rust-projects.cjs').freeChatsEnabledFrom(env, () => {})
    && env.NOEVIA_RUST_EXPORT === '1' && env.NOEVIA_RUST_EXPORT_CONFIRMED === '1';
}

function createExportRoutes({ json, workspace, readHistory, audit = () => {}, now = Date.now, env = process.env }) {
  // Read once: the deployment switches do not change while the process runs.
  const rustOwned = exportRustOwned(env);
  return async function exportRoutes(req, res, { path, authn }) {
    if (path !== '/api/export/conversations') return false;
    if (!authn) return json(res, 401, { error: 'Sign in first' }), true;
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }), true;
    // Behind a front that answers this GET itself, a request reaching Node is a bypass: refused,
    // nothing read, built or audited.
    if (rustOwned) return json(res, 503, { error: 'Conversation export is owned by the Rust front.' }), true;
    const ws = workspace();
    const when = now();
    let zip;
    try { zip = buildExport({ freeChats: ws.freeChats || [], projects: ws.projects || [], readHistory, now: when }); }
    catch (error) {
      // Too large to build in memory (#867): a clear answer instead of a crash or a stalled server.
      if (error && error.status === 413) return json(res, 413, { error: error.publicMessage }), true;
      throw error;
    }
    audit('export.conversations', authn.user.id, { bytes: zip.length });
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': zip.length,
      'Content-Disposition': `attachment; filename="noevia-conversations-${new Date(when).toISOString().slice(0, 10)}.zip"`,
      'Cache-Control': 'no-store',
    });
    res.end(zip);
    return true;
  };
}

module.exports = { createExportRoutes, exportRustOwned };
