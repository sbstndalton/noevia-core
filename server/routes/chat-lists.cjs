'use strict';
// The chat lists and transcripts (the store is projects.cjs):
//   GET  /api/workspace                    the projects and free chats, chats[] sanitized, after the
//                                          delete-old-chats sweep has had its hourly chance to run
//   GET  /api/chats/:id/context-window     the last context meter recorded for a chat
//   GET/POST /api/freechats                the free-chat metas, merged against tombstones
//   DELETE /api/freechats/:id
//   GET/POST /api/chats/:id/history        the transcript, with a revision for optimistic saves
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.
// Blocks keep their original order and an unmatched method falls through as it did inline.

const PASS = Symbol('unhandled');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req, limit?:number) => Promise<string>} deps.readBody
 * @param {() => object} deps.currentWorkspace
 * @param {object[]} deps.PROJECTS
 * @param {object[]} deps.FREE_CHATS
 * @param {object} deps.diaryExtras
 * @param {object} deps.crypto
 * @param {number} deps.STORED_HISTORY_BYTES
 * @param {number} deps.STORED_HISTORY_CAP
 * @param {() => { freeChats:object[], projects:object[] }} deps.chatLists   what the retention sweep may delete from
 * @param {(chat:{ projectId?:string, id:string }) => boolean} deps.removeChat
 * @param {object} deps.store   projects.cjs: sanitizeChats, saveFreeChats, deleteFreeChat, readHistory, writeHistory
 */
function createChatListRoutes({ json, readBody, currentWorkspace, PROJECTS, FREE_CHATS, diaryExtras, crypto, STORED_HISTORY_BYTES, STORED_HISTORY_CAP, chatLists, removeChat, store }) {
  const { sanitizeChats, saveFreeChats, deleteFreeChat, readHistory, writeHistory } = store;

  // Delete-old-chats sweep (chat-retention.cjs): runs as the user's workspace loads, at most hourly.
  function sweepRetention() {
    const retention = require('../chat-retention.cjs');
    const dir = currentWorkspace().dir, settings = retention.read(dir);
    if (!retention.sweepDue(settings)) return;
    for (const chat of retention.expired({ ...chatLists(), days: settings.days })) removeChat(chat);
    retention.markSwept(dir);
  }

  async function handle(req, res, { path: p, authn }) {
    if (p === '/api/workspace') {
      try { sweepRetention(); } catch (e) { console.warn('[retention] sweep failed:', e?.message || e); }
      // PROJECTS is served raw everywhere else; here it crosses to the client,
      // so chats[] must be sanitized exactly as loadChats does.
      return json(res, 200, {
        projects: PROJECTS.filter(proj => !diaryExtras.internalProject(proj)).map((proj) => ({ ...proj, chats: sanitizeChats(proj.chats) })),
        freeChats: sanitizeChats(FREE_CHATS),
      });
    }

    const windowMatch=p.match(/^\/api\/chats\/([^/]+)\/context-window$/);
    if(windowMatch && req.method==='GET') return json(res,200,{meter:require('../chat-context.cjs').read(currentWorkspace().dir,decodeURIComponent(windowMatch[1])).meter||null});

    // ── Free-chat metas (server-side so they survive browser switches) ──
    if (p === '/api/freechats') {
      if (req.method === 'GET') return json(res, 200, { chats: FREE_CHATS });
      if (req.method === 'POST') {
        const raw = await readBody(req);
        try {
          const body = JSON.parse(raw);
          if (!Array.isArray(body.chats)) return json(res, 400, { error: 'chats array required' });
          const nextFreeChats = body.chats
            .filter((c) => c && typeof c.id === 'string')
            .slice(0, require('../chat-lists.cjs').LIST_CAP)
            .map((c) => ({
              id: c.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
              title: String(c.title || 'New chat').slice(0, 120),
              updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
              preview: String(c.preview || '').slice(0, 200),
              pinned: c.pinned === true,
              archived: c.archived === true,
              // The session's harness (#236); absent means Chat, as for every older chat. Only an
              // admin may run Cowork, so a member's saved 'cowork' is coerced to Chat rather than
              // planting a mode that would fail every turn.
              ...(c.mode === 'cowork' && authn?.user?.role === 'admin' ? { mode: 'cowork' } : {}),
            }));
          const lists = require('../chat-lists.cjs');
          FREE_CHATS.splice(0, FREE_CHATS.length, ...lists.mergeChats(Array.from(FREE_CHATS), nextFreeChats, lists.readTombstones(currentWorkspace().dir)));
          saveFreeChats(FREE_CHATS);
          return json(res, 200, { ok: true });
        } catch {
          return json(res, 400, { error: 'invalid JSON' });
        }
      }
    }

    const freeDel = p.match(/^\/api\/freechats\/([^/]+)$/);
    if (freeDel && req.method === 'DELETE') {
      const removed = deleteFreeChat(decodeURIComponent(freeDel[1]));
      return json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'no such chat' });
    }

    const historyMatch = p.match(/^\/api\/chats\/([^/]+)\/history$/);
    if (historyMatch) {
      // Sanitized here, exactly as storage does, so the tombstone check sees the stored id.
      const spaceId = require('../chat-lists.cjs').safeChatId(decodeURIComponent(historyMatch[1]));
      if (!spaceId) return json(res, 400, { error: 'invalid chat id' });
      const revisionOf = (history) => crypto.createHash('sha256').update(JSON.stringify(history)).digest('hex');
      if (req.method === 'GET') { const history = readHistory(spaceId); return json(res, 200, { history, revision: revisionOf(history) }); }
      if (req.method === 'POST') {
        // A reply that finishes after its chat was deleted must not write the transcript back.
        if (require('../chat-lists.cjs').readTombstones(currentWorkspace().dir).has(spaceId)) return json(res, 410, { error: 'This chat was deleted.' });
        let raw;
        try { raw = await readBody(req, STORED_HISTORY_BYTES); }
        catch (e) { return json(res, e.status || 400, { error: e.status === 413 ? 'This chat is too large to save; start a new chat to keep going.' : 'could not read the chat' }); }
        try {
          const body = JSON.parse(raw);
          if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'request body must be a JSON object' });
          // Optimistic concurrency: a save based on an older copy (another device saved meanwhile)
          // gets the current copy back to merge. Saves without a base revision are accepted as before.
          if (typeof body.baseRevision === 'string') {
            const current = readHistory(spaceId);
            const revision = revisionOf(current);
            if (body.baseRevision !== revision) return json(res, 409, { error: 'This chat changed on another device.', history: current, revision });
          }
          const next = Array.isArray(body.history) ? body.history.slice(-STORED_HISTORY_CAP) : [];
          writeHistory(spaceId, next);
          return json(res, 200, { ok: true, revision: revisionOf(next) });
        } catch {
          return json(res, 400, { error: 'invalid JSON' });
        }
      }
    }
    return PASS;
  }

  return async function chatListRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createChatListRoutes };
