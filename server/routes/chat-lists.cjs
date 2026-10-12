'use strict';
// The chat lists and transcripts (the store is projects.cjs):
//   GET  /api/workspace                    the projects and free chats, chats[] sanitized, after the
//                                          delete-old-chats sweep has had its hourly chance to run
//   GET  /api/chats/:id/context-window     the last context meter recorded for a chat
//   GET  /api/chats/:id/export             one chat as a Markdown file (#1471)
//   GET  /api/chats/search?q=              the chat ids whose message text holds q (#1450)
//   GET/POST /api/freechats                the free-chat metas, merged against tombstones
//   DELETE /api/freechats/:id
//   GET/POST /api/chats/:id/history        the transcript, with a revision for optimistic saves
//   POST /api/chats/:id/move               { projectId: string|null, frame? } moves the meta between
//                                          the caller's own lists (#738); the transcript stays put
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.
// Blocks keep their original order and an unmatched method falls through as it did inline.

const PASS = Symbol('unhandled');
const { saveFailureReply } = require('../http.cjs');
// #1450: the transcript search's bounds (one query reads at most this many chats).
const SEARCH_MIN_QUERY = 2, SEARCH_MAX_QUERY = 200, SEARCH_MAX_CHATS = 500, SEARCH_MAX_RESULTS = 100;

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
 * @param {object} deps.store   projects.cjs: sanitizeChats, saveFreeChats, deleteFreeChat, readHistory, writeHistory, moveChat
 * @param {(userId:string, chatId:string) => boolean} [deps.revokeChatGrant]  approvals.cjs: drops a chat's "Allow for this chat" grant
 * @param {boolean} [deps.rustFreeChats]  M4 (rust-projects.cjs freeChatsEnabledFrom): the Rust front saves the free-chat list; this copy refuses it
 */
function createChatListRoutes({ json, readBody, currentWorkspace, PROJECTS, FREE_CHATS, diaryExtras, crypto, STORED_HISTORY_BYTES, STORED_HISTORY_CAP, chatLists, removeChat, store, revokeChatGrant = () => false, rustFreeChats = false }) {
  const { sanitizeChats, saveFreeChats, deleteFreeChat, readHistory, writeHistory, moveChat } = store;
  // #812: a malformed percent-escape in the URL is the caller's mistake (400), not a server error.
  const decodeChatId = require('../http.cjs').decodePathPart;
  const badChatId = (res) => json(res, 400, { error: 'invalid chat id' });

  // Delete-old-chats sweep (chat-retention.cjs): runs as the user's workspace loads, at most hourly.
  function sweepRetention() {
    const retention = require('../chat-retention.cjs');
    const dir = currentWorkspace().dir, settings = retention.read(dir);
    if (!retention.sweepDue(settings)) return;
    for (const chat of retention.expired({ ...chatLists(), days: settings.days })) removeChat(chat);
    retention.markSwept(dir);
  }

  async function handle(req, res, { path: p, authn, url }) {
    // #1450: the chats whose message text holds the query. Titles are matched in the client; this covers the
    // transcripts, which the sidebar does not load. Only this person's own lists are read, and the scan is capped.
    if (p === '/api/chats/search' && req.method === 'GET') {
      const q = String(url?.searchParams?.get('q') ?? '').trim();
      if (q.length > SEARCH_MAX_QUERY) return json(res, 400, { error: `Search for at most ${SEARCH_MAX_QUERY} characters.` });
      if (q.length < SEARCH_MIN_QUERY) return json(res, 200, { chats: [], truncated: false });
      const needle = q.toLowerCase();
      const dir = currentWorkspace().dir, lists = require('../chat-lists.cjs');
      const tombstones = lists.readTombstones(dir);
      const candidates = [];
      for (const chat of FREE_CHATS) if (chat && typeof chat.id === 'string') candidates.push(chat);
      for (const project of PROJECTS) {
        if (diaryExtras.internalProject(project)) continue;
        for (const chat of project.chats || []) if (chat && typeof chat.id === 'string') candidates.push(chat);
      }
      const matches = [];
      let scanned = 0, truncated = false;
      for (const chat of candidates) {
        if (tombstones.has(chat.id)) continue;
        if (scanned >= SEARCH_MAX_CHATS) { truncated = true; break; }
        scanned++;
        const history = store.readHistory(chat.id) || [];
        if (history.some((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.toLowerCase().includes(needle))) {
          matches.push(chat.id);
          if (matches.length >= SEARCH_MAX_RESULTS) { truncated = true; break; }
        }
      }
      return json(res, 200, { chats: matches, truncated });
    }
    if (p === '/api/workspace') {
      try { sweepRetention(); } catch (e) { console.warn('[retention] sweep failed:', e?.message || e); }
      // Attachments projects of chats deleted before #788 (only provably deleted ones; bounded).
      try { store.removeOrphanChatContexts?.(); } catch (e) { console.warn('[projects] orphan chat attachments cleanup failed:', e?.message || e); }
      // PROJECTS is served raw everywhere else; here it crosses to the client,
      // so chats[] must be sanitized exactly as loadChats does.
      return json(res, 200, {
        projects: PROJECTS.filter(proj => !diaryExtras.internalProject(proj)).map((proj) => ({ ...proj, chats: sanitizeChats(proj.chats) })),
        freeChats: sanitizeChats(FREE_CHATS),
      });
    }

    const windowMatch=p.match(/^\/api\/chats\/([^/]+)\/context-window$/);
    if(windowMatch && req.method==='GET') {
      const dir=currentWorkspace().dir,lists=require('../chat-lists.cjs'),id=decodeChatId(windowMatch[1]);
      if(id===null) return badChatId(res);
      // A deleted chat answers exactly like one that never existed (#554), even if state was written back late.
      if(lists.readTombstones(dir).has(lists.safeChatId(id)||id)) return json(res,200,{meter:null});
      return json(res,200,{meter:require('../chat-context.cjs').read(dir,id).meter||null});
    }

    // #1471: one chat as a Markdown file, from the same writer as the conversation export (chat-export.cjs).
    // Only a chat in this person's own lists can be read; a deleted or unknown id answers 404.
    const exportMatch = p.match(/^\/api\/chats\/([^/]+)\/export$/);
    if (exportMatch) {
      if (req.method !== 'GET') return PASS;
      const rawId = decodeChatId(exportMatch[1]);
      if (rawId === null) return badChatId(res);
      const lists = require('../chat-lists.cjs');
      const spaceId = lists.safeChatId(rawId);
      if (!spaceId) return json(res, 400, { error: 'invalid chat id' });
      const dir = currentWorkspace().dir;
      let chat = FREE_CHATS.find((c) => c && c.id === spaceId) || null;
      if (!chat && !lists.readTombstones(dir).has(spaceId)) {
        for (const project of PROJECTS) {
          if (diaryExtras.internalProject(project)) continue;
          const hit = (project.chats || []).find((c) => c && c.id === spaceId);
          if (hit) { chat = hit; break; }
        }
      }
      if (!chat || lists.readTombstones(dir).has(spaceId)) return json(res, 404, { error: 'This chat was not found.' });
      const { chatMarkdown } = require('../chat-export.cjs');
      const text = chatMarkdown(chat, store.readHistory(spaceId));
      const name = `noevia-chat-${String(chat.title || 'untitled-chat').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled-chat'}-${spaceId}.md`;
      const body = Buffer.from(text, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Length': body.length,
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return true;
    }

    // ── Free-chat metas (server-side so they survive browser switches) ──
    if (p === '/api/freechats') {
      if (req.method === 'GET') {
        // #1420: the list is read before the status line goes out, so a broken store is a clean 500.
        let chats;
        try { chats = Array.from(FREE_CHATS); } catch { return json(res, 500, { error: 'could not read the free chats' }); }
        return json(res, 200, { chats });
      }
      if (req.method === 'POST') {
        // M4: the Rust front saves the free-chat list while NOEVIA_RUST_PROJECTS is on and the
        // supervisor confirmed that this front has the slice (rust-free-chats). The read stays.
        if (require('../rust-projects.cjs').refuseOwned(rustFreeChats, json, res)) return true;
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid JSON' }); }
        if (!body || typeof body !== 'object' || !Array.isArray(body.chats)) return json(res, 400, { error: 'chats array required' });
        // #1419: only the reading of the request is a 400; a lock or disk failure below is 503/500.
        try {
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
              // Chat framing (#737/#738): the frame (null clears it) and the first-saved time; the
              // merge (chat-lists.cjs) validates the frame and keeps the first createdAt.
              ...('frame' in c ? { frame: c.frame } : {}),
              // #778: the per-chat routing flags; the merge keeps them when a save leaves them out.
              ...(typeof c.forceLocal === 'boolean' ? { forceLocal: c.forceLocal } : {}),
              ...(typeof c.allowCloud === 'boolean' ? { allowCloud: c.allowCloud } : {}),
              ...(Number.isFinite(c.createdAt) ? { createdAt: c.createdAt } : {}),
              // The session's harness (#236); absent means Chat, as for every older chat. Only an
              // admin may run Cowork, so a member's saved 'cowork' is coerced to Chat rather than
              // planting a mode that would fail every turn.
              ...(c.mode === 'cowork' && authn?.user?.role === 'admin' ? { mode: 'cowork' } : {}),
            }));
          const lists = require('../chat-lists.cjs');
          const elsewhere = store.chatIdsElsewhere ? store.chatIdsElsewhere(null) : new Set();
          FREE_CHATS.splice(0, FREE_CHATS.length, ...lists.mergeChats(Array.from(FREE_CHATS), nextFreeChats, lists.readTombstones(currentWorkspace().dir), elsewhere));
          saveFreeChats(FREE_CHATS);
          // Ids a project holds were not saved here (#765): say so, so a stale tab refreshes.
          const skipped = lists.skippedElsewhere(nextFreeChats, elsewhere);
          return json(res, 200, skipped.length ? { ok: true, skipped } : { ok: true });
        } catch (e) {
          return saveFailureReply(json, res, e, 'could not save the free chats; nothing was changed');
        }
      }
    }

    const freeDel = p.match(/^\/api\/freechats\/([^/]+)$/);
    if (freeDel && req.method === 'DELETE') {
      const id = decodeChatId(freeDel[1]);
      if (id === null) return badChatId(res);
      const removed = deleteFreeChat(id);
      return json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'no such chat' });
    }

    const moveMatch = p.match(/^\/api\/chats\/([^/]+)\/move$/);
    if (moveMatch && req.method === 'POST' && moveChat) {
      const chatId = decodeChatId(moveMatch[1]);
      if (chatId === null) return badChatId(res);
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid JSON' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || !(body.projectId === null || typeof body.projectId === 'string')) return json(res, 400, { error: 'projectId (or null) required' });
      let patch = {};
      if ('frame' in body) {
        // An invalid frame is refused outright (#759); the merge would otherwise drop the stored one.
        // The store's merge normalizes it again, so the body's frame is passed on as before.
        if (body.frame !== null && !require('../chat-framing.cjs').normalizeFrame(body.frame)) return json(res, 400, { error: 'invalid frame' });
        patch = { frame: body.frame };
      }
      // Only the caller's own lists (the request-scoped workspace); Diary's internal project is not a
      // destination, and neither is a project without Chat mode or an archived one (#810).
      const moved = moveChat(chatId, body.projectId, patch, (proj) => !diaryExtras.internalProject(proj), require('../project-modes.cjs').chatDestination);
      // #814: a chat that changed lists loses its "Allow for this chat" grant; a frame saved in place keeps it.
      if (moved.status === 200 && moved.from !== body.projectId) {
        for (const userId of new Set([currentWorkspace().userId, authn?.user?.id])) if (userId) revokeChatGrant(userId, chatId);
      }
      return json(res, moved.status, moved.status === 200 ? { ok: true, from: moved.from, projectId: body.projectId } : { error: 'no such chat or project' });
    }

    const historyMatch = p.match(/^\/api\/chats\/([^/]+)\/history$/);
    if (historyMatch) {
      // Sanitized here, exactly as storage does, so the tombstone check sees the stored id.
      const rawId = decodeChatId(historyMatch[1]);
      if (rawId === null) return badChatId(res);
      const spaceId = require('../chat-lists.cjs').safeChatId(rawId);
      if (!spaceId) return json(res, 400, { error: 'invalid chat id' });
      const revisionOf = (history) => crypto.createHash('sha256').update(JSON.stringify(history)).digest('hex');
      // #1507: a reply the client lost (reload, restart) is offered as `partial`, an interrupted turn.
      if (req.method === 'GET') {
        const history = readHistory(spaceId);
        const partial = require('../chat-partial.cjs').partialFor(currentWorkspace().dir, spaceId);
        return json(res, 200, { history, revision: revisionOf(history), ...(partial ? { partial } : {}) });
      }
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
          const next = Array.isArray(body.history) ? require('../chat-sources.cjs').sanitizeHistory(body.history.slice(-STORED_HISTORY_CAP)) : [];
          writeHistory(spaceId, next);
          // #1507: a transcript saved by the client (not by a running reply) supersedes a saved partial.
          require('../chat-partial.cjs').supersedePartial(currentWorkspace().dir, spaceId);
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
