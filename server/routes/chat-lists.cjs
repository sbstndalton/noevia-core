'use strict';
// The chat lists and transcripts (the store is projects.cjs):
//   GET  /api/workspace                    the projects and free chats, chats[] sanitized, after the
//                                          delete-old-chats sweep has had its hourly chance to run
//   GET  /api/chats/:id/export             one chat as a Markdown file (#1471)
//   GET  /api/chats/search?q=              the chat ids whose message text holds q (#1450)
//   (GET/POST /api/freechats and DELETE /api/freechats/:id are the Rust front's, #1071)
//   POST /api/chats/:id/move               { projectId: string|null, frame? } moves the meta between
//                                          the caller's own lists (#738); the transcript stays put
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.
// Blocks keep their original order and an unmatched method falls through as it did inline.

const PASS = Symbol('unhandled');
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
 * @param {number} deps.STORED_HISTORY_BYTES
 * @param {() => { freeChats:object[], projects:object[] }} deps.chatLists   what the retention sweep may delete from
 * @param {(chat:{ projectId?:string, id:string }) => boolean} deps.removeChat
 * @param {object} deps.store   projects.cjs: sanitizeChats, readHistory
 * @param {(userId:string, chatId:string) => boolean} [deps.revokeChatGrant]  approvals.cjs: drops a chat's "Allow for this chat" grant
 */
function createChatListRoutes({ json, readBody, currentWorkspace, PROJECTS, FREE_CHATS, diaryExtras, STORED_HISTORY_BYTES, chatLists, removeChat, store }) {
  const { sanitizeChats } = store;
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
        // #1806: sources as metadata only; a source's text is GET /api/projects/{id}/sources/text.
        projects: PROJECTS.filter(proj => !diaryExtras.internalProject(proj)).map((proj) => ({ ...proj, chats: sanitizeChats(proj.chats),
          ...(Array.isArray(proj.files) ? { files: proj.files.map(require('../source-text.cjs').meta) } : {}) })),
        freeChats: sanitizeChats(FREE_CHATS),
      });
    }

    // GET /api/chats/:id/context-window (a chat's last context meter) is the Rust front's
    // (sbstndalton/noevia#1071): index.cjs refuses it before this mount (rust-projects.cjs refuseOwnedRoute).

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

    // GET and POST /api/freechats and DELETE /api/freechats/{id} are the Rust front's
    // (sbstndalton/noevia#1071; the delete is slice 6, one store operation): index.cjs refuses them
    // before this mount (rust-projects.cjs refuseOwnedRoute).

    // POST /api/chats/{chatId}/move is Rust-owned; index.cjs refuses it before this mount.

    // GET and POST /api/chats/:id/history are the Rust front's (sbstndalton/noevia#1071 slices 4
    // and 5): index.cjs refuses both before this mount (rust-projects.cjs refuseOwnedRoute). The
    // Rust store journals each save and chat-change-journal.cjs schedules the mirror and brain.
    return PASS;
  }

  return async function chatListRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createChatListRoutes };
