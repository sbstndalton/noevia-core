'use strict';
// GET /api/account/instructions            -> { text, updatedAt, maxChars }
// PUT /api/account/instructions { text }   -> { text, updatedAt, maxChars }   own account only
// GET /api/account/memory                 -> { memories, useProjectMemories, updatedAt, maxItems, maxItemChars }
// PUT /api/account/memory { memories, useProjectMemories }   own account only
// GET /api/account/retention               -> { days, periods, preview: { 30: n, 90: n, 365: n } }
// PUT /api/account/retention { days }      -> { days, deleted }   deletes due chats right away
// GET /api/account/preferences             -> { notifications, sendKey, locale, updatedAt, options }
// PUT /api/account/preferences { partial }  -> same                  own account only
const instructions = require('../account-instructions.cjs');
const retention = require('../chat-retention.cjs');
const memory = require('../account-memory.cjs');
const preferences = require('../account-preferences.cjs');

function createAccountRoutes({ json, readJson, dir, chatLists = null, removeChat = null, now = Date.now }) {
  return async function accountRoutes(req, res, { path, authn }) {
    if (path === '/api/account/retention' && chatLists && removeChat) {
      if (!authn) return json(res, 401, { error: 'Sign in first' }), true;
      const lists = chatLists();
      const preview = Object.fromEntries(retention.PERIODS.map((days) => [days, retention.expired({ ...lists, days, now: now() }).length]));
      if (req.method === 'GET') return json(res, 200, { days: retention.read(dir()).days, periods: retention.PERIODS, preview }), true;
      if (req.method !== 'PUT') return json(res, 405, { error: 'method not allowed' }), true;
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
      for (const chat of due) removeChat(chat);
      if (saved.days) retention.markSwept(dir(), now());
      return json(res, 200, { days: saved.days, deleted: due.length }), true;
    }
    if (path === '/api/account/memory') {
      if (!authn) return json(res, 401, { error: 'Sign in first' }), true;
      const out = (record) => json(res, 200, { ...record, maxItems: memory.MAX_ITEMS, maxItemChars: memory.MAX_ITEM_CHARS });
      if (req.method === 'GET') return out(memory.read(dir())), true;
      if (req.method !== 'PUT') return json(res, 405, { error: 'method not allowed' }), true;
      let body;
      try { body = await readJson(req); } catch { return json(res, 400, { error: 'invalid JSON' }), true; }
      try { return out(memory.write(dir(), body, now())), true; }
      catch (e) { return json(res, e.status || 500, { error: e.publicMessage || 'Could not save your memory' }), true; }
    }
    if (path === '/api/account/preferences') {
      if (!authn) return json(res, 401, { error: 'Sign in first' }), true;
      const options = { notificationEvents: preferences.NOTIFICATION_EVENTS, sendKeys: preferences.SEND_KEYS, locales: preferences.LOCALES };
      const out = (record) => json(res, 200, { ...record, options });
      if (req.method === 'GET') return out(preferences.read(dir())), true;
      if (req.method !== 'PUT') return json(res, 405, { error: 'method not allowed' }), true;
      let body;
      try { body = await readJson(req); } catch { return json(res, 400, { error: 'invalid JSON' }), true; }
      try { return out(preferences.write(dir(), body, now())), true; }
      catch (e) { return json(res, e.status || 500, { error: e.publicMessage || 'Could not save your preferences' }), true; }
    }
    if (path !== '/api/account/instructions') return false;
    if (!authn) return json(res, 401, { error: 'Sign in first' }), true;
    const out = (record) => json(res, 200, { ...record, maxChars: instructions.MAX_CHARS, styles: instructions.STYLES, advancedOptions: instructions.ADVANCED });
    if (req.method === 'GET') return out(instructions.read(dir())), true;
    if (req.method !== 'PUT') return json(res, 405, { error: 'method not allowed' }), true;
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'invalid JSON' }), true; }
    try { return out(instructions.write(dir(), body?.text, Date.now(), body?.style ?? 'default', { advanced: body?.advanced, language: body?.language })), true; }
    catch (e) { return json(res, e.status || 500, { error: e.publicMessage || 'Could not save your instructions' }), true; }
  };
}

module.exports = { createAccountRoutes };
