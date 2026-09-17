'use strict';
// GET /api/export/conversations -> application/zip   the signed-in user's own chats only
// Returns true when it handled the request. Auth runs before routes are mounted.
const { buildExport } = require('../chat-export.cjs');

function createExportRoutes({ json, workspace, readHistory, audit = () => {}, now = Date.now }) {
  return async function exportRoutes(req, res, { path, authn }) {
    if (path !== '/api/export/conversations') return false;
    if (!authn) return json(res, 401, { error: 'Sign in first' }), true;
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }), true;
    const ws = workspace();
    const when = now();
    const zip = buildExport({ freeChats: ws.freeChats || [], projects: ws.projects || [], readHistory, now: when });
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

module.exports = { createExportRoutes };
