'use strict';
// POST /api/import/conversations  body: conversations.json from an export -> { imported, skipped, projectsCreated }
// Adds chats to the signed-in user's own account; never overwrites or deletes. Auth/CSRF run before routes.
const { planImport } = require('../chat-import.cjs');

const MAX_BYTES = 64 * 1024 * 1024;

function createImportRoutes({ json, readBody, context, audit = () => {}, newId }) {
  return async function importRoutes(req, res, { path, authn }) {
    if (path !== '/api/import/conversations') return false;
    if (!authn) return json(res, 401, { error: 'Sign in first' }), true;
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }), true;
    let data;
    try { data = JSON.parse(await readBody(req, MAX_BYTES)); }
    catch (e) { return json(res, e.status === 413 ? 413 : 400, { error: e.status === 413 ? 'That file is over 64 MB. Split the export and import each part.' : 'Choose a conversations.json from a noevia conversations export.' }), true; }
    const ctx = context();
    let plan;
    try { plan = planImport(data, { existingChatIds: ctx.existingChatIds(), tombstones: ctx.tombstones(), projects: ctx.projects(), newId }); }
    catch (e) { return json(res, e.status || 400, { error: e.publicMessage || 'Import failed.' }), true; }
    // Histories first: a chat only appears in a list once its transcript is on disk.
    for (const [id, history] of Object.entries(plan.histories)) ctx.writeHistory(id, history);
    if (plan.freeChats.length) ctx.addFreeChats(plan.freeChats);
    let projectsCreated = 0;
    for (const group of plan.projectChats) {
      let projectId = group.projectId;
      if (!projectId) { projectId = (await ctx.createProject({ name: group.name, toolboxes: [] })).id; projectsCreated++; }
      ctx.addProjectChats(projectId, group.chats);
    }
    audit('import.conversations', authn.user.id, { imported: plan.imported, skipped: plan.skipped.length, projectsCreated });
    return json(res, 200, { imported: plan.imported, skipped: plan.skipped, projectsCreated }), true;
  };
}

module.exports = { createImportRoutes, MAX_BYTES };
