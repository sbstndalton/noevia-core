'use strict';
// POST /api/import/conversations  body: conversations.json from an export -> { imported, skipped, projectsCreated }
// Adds chats to the signed-in user's own account; never overwrites or deletes. Auth/CSRF run before routes.
const { importConversations } = require('../conversation-import.cjs');

const MAX_BYTES = 64 * 1024 * 1024;

function createImportRoutes({ json, readBody, context, audit = () => {}, newId }) {
  return async function importRoutes(req, res, { path, authn }) {
    if (path !== '/api/import/conversations') return false;
    if (!authn) return json(res, 401, { error: 'Sign in first' }), true;
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }), true;
    let data;
    try { data = JSON.parse(await readBody(req, MAX_BYTES)); }
    catch (e) { return json(res, e.status === 413 ? 413 : 400, { error: e.status === 413 ? 'That file is over 64 MB. Split the export and import each part.' : 'Choose a conversations.json from a noevia conversations export.' }), true; }
    try {
      const result = await importConversations(data, context(), newId, result => {
        audit('import.conversations', authn.user.id, { imported: result.imported, skipped: result.skipped.length, projectsCreated: result.projectsCreated });
      });
      return json(res, 200, result), true;
    } catch (e) {
      return json(res, e.status || 503, { error: e.publicMessage || 'Import was interrupted. Some conversations may already be available. Retry the same file to finish; unfinished imports are kept for recovery.' }), true;
    }
  };
}

module.exports = { createImportRoutes, MAX_BYTES };
