'use strict';
// sbstndalton/noevia#2257: what the Rust front's task reads cannot read from disk, because only this process has it.
// Reached only by the front's own loopback calls (the same check as its other ones); anything else gets the 404 of an
// unknown path, because with file sharing on this listener is not bound to loopback alone.
//
//   POST /internal/tasks/facts {user, surface: 'code'|'browser', admin: boolean}
//     -> {enabled: false}              the flag is off
//     -> {enabled: true}               on, and the caller is not an administrator: nothing more is looked up
//     -> {enabled: true, facts}        the service's facts for that user's workspace
//
// `features.enabled` here keeps Browser mode's Playwright check, which only this process can make. Asking for an
// administrator's facts opens the workspace's store, which recovers tasks from a previous process exactly as a read
// here used to, so the front never reads a dead task as running. Approval cards are scoped to that workspace's tasks.
const { trustedFront } = require('./trusted-front.cjs');

const PATH = '/internal/tasks/facts';
const FLAGS = Object.freeze({ code: 'codeHarness', browser: 'browserExecutor' });

function createTaskFactsBridge({ secret, asUser, features, services, workspace, json, readJson, log = (m) => console.warn(m) }) {
  return async function handle(req, res) {
    if (String(req.url || '').split('?')[0] !== PATH) return false;
    if (!trustedFront(req, secret) || req.method !== 'POST') { json(res, 404, { error: 'Not found' }); return true; }
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const { user, surface, admin } = body || {};
    if (typeof user !== 'string' || !user || !Object.hasOwn(FLAGS, String(surface))) { json(res, 400, { error: 'A user and a surface are required.' }); return true; }
    try {
      if (!features.enabled(FLAGS[surface])) { json(res, 200, { enabled: false }); return true; }
      if (admin !== true) { json(res, 200, { enabled: true }); return true; }
      const facts = await asUser(user, () => services[surface].facts(workspace()));
      json(res, 200, { enabled: true, facts });
    } catch (e) {
      log(`[tasks] facts failed: ${e?.code || e?.name || 'error'}`);
      json(res, 503, { error: 'Task facts are unavailable.' });
    }
    return true;
  };
}

module.exports = { createTaskFactsBridge, PATH, FLAGS };
