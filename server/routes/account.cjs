'use strict';
// PUT /api/account/retention { days, confirmDeletes } -> { days, deleted }   deletes due chats right away
//   (409 { error, preview: { 30: n, 90: n, 365: n } } when more chats are due than were confirmed)
// GET /api/account/retention (the preview) is the Rust front's (noevia-rs crates/server-projects
// `retention`, sbstndalton/noevia#1071); rust-auth.cjs refuses it before this module runs.
// /api/account/instructions, /memory and /preferences are the Rust front's (sbstndalton/noevia#1071;
// rust-auth.cjs refuses them before this module runs).
const retention = require('../chat-retention.cjs');

function createAccountRoutes({ json, readJson, dir, chatLists = null, removeChat = null, now = Date.now }) {
  return async function accountRoutes(req, res, { path, authn }) {
    if (path === '/api/account/retention' && chatLists && removeChat) {
      if (!authn) return json(res, 401, { error: 'Sign in first' }), true;
      if (req.method !== 'PUT') return json(res, 405, { error: 'method not allowed' }), true;
      const lists = chatLists();
      const preview = Object.fromEntries(retention.PERIODS.map((days) => [days, retention.expired({ ...lists, days, now: now() }).length]));
      let body;
      try { body = await readJson(req); } catch { return json(res, 400, { error: 'invalid JSON' }), true; }
      // Never delete more than the person just confirmed: a stale preview must not become a silent delete.
      if (retention.PERIODS.includes(body?.days)) {
        const count = retention.expired({ ...lists, days: body.days, now: now() }).length;
        const confirmed = Number.isInteger(body.confirmDeletes) ? body.confirmDeletes : 0;
        if (count > confirmed) return json(res, 409, { error: `${count} chat${count === 1 ? '' : 's'} would be deleted now. Confirm to continue.`, preview }), true;
      }
      let saved;
      try { saved = retention.write(dir(), body?.days); } catch (e) { return json(res, e.status || 500, { error: e.publicMessage || 'Could not save' }), true; }
      const due = retention.expired({ ...lists, days: saved.days, now: now() });
      // The 200 says the chats are gone, so wait for each removal: the store deletes the transcript
      // under its lock after the list write, and a history read right after an early answer still
      // returned it (#2230). A chat whose removal failed is not counted and the retention sweep
      // (which stays armed: markSwept only runs after a clean pass) takes it again.
      let deleted = 0, failure = null;
      for (const chat of due) {
        try { if ((await removeChat(chat)) !== false) deleted += 1; } catch (e) { failure = failure || e; }
      }
      if (failure) return json(res, [429, 503].includes(failure.status) ? failure.status : 500, { error: 'Some chats could not be deleted. Try again shortly.', days: saved.days, deleted }), true;
      if (saved.days) retention.markSwept(dir(), now());
      return json(res, 200, { days: saved.days, deleted }), true;
    }
    return false;
  };
}

module.exports = { createAccountRoutes };
