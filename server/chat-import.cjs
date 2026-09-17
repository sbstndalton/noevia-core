'use strict';
// Settings → Data → Import conversations: reads a conversations.json made by chat-export.cjs and
// plans what to add. Pure: the route applies the plan. Import only ever adds chats; it never
// overwrites or deletes one. Content is treated as untrusted: only user/assistant text and tool
// names survive, with the same size caps as history saves.
const { FORMAT } = require('./chat-export.cjs');

const MAX_CHATS = 2000;
const SAFE_ID = /^c-[A-Za-z0-9_-]{1,80}$/;

function readable(message, status = 400) { return Object.assign(Error(message), { publicMessage: message, status }); }

function cleanHistory(history, { maxMessages, maxChars }) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-maxMessages)
    .map((m) => {
      const out = { role: m.role, content: m.content.slice(0, maxChars) };
      const tools = Array.isArray(m.toolCalls) ? m.toolCalls.filter((t) => t && typeof t.name === 'string').slice(0, 50) : [];
      if (tools.length) out.toolCalls = tools.map((t) => ({ name: t.name.slice(0, 120), status: 'done' }));
      return out;
    });
}

/**
 * @param {unknown} data parsed conversations.json
 * @param {{ existingChatIds: Set<string>, tombstones: Set<string>, projects: {id:string,name:string}[], newId: () => string,
 *           maxMessages?: number, maxChars?: number }} ctx
 */
function planImport(data, { existingChatIds, tombstones, projects, newId, maxMessages = 5000, maxChars = 200000 }) {
  if (!data || typeof data !== 'object' || data.format !== FORMAT || !Array.isArray(data.chats)) throw readable('Choose a conversations.json from a noevia conversations export.');
  if (data.chats.length > MAX_CHATS) throw readable(`An import holds at most ${MAX_CHATS} chats. Split the file and import each part.`);
  const byName = new Map(projects.map((p) => [String(p.name).trim().toLowerCase(), p]));
  const freeChats = [], groups = new Map(), histories = {}, skipped = [];
  const used = new Set();
  for (const raw of data.chats) {
    if (!raw || typeof raw !== 'object') continue;
    const title = String(raw.title || '').slice(0, 200);
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (SAFE_ID.test(id) && existingChatIds.has(id)) { skipped.push({ title: title || 'Untitled chat', reason: 'already in this account' }); continue; }
    let chatId = SAFE_ID.test(id) && !tombstones.has(id) && !used.has(id) ? id : newId();
    while (used.has(chatId) || existingChatIds.has(chatId)) chatId = newId();
    used.add(chatId);
    const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now();
    const meta = { id: chatId, title, updatedAt };
    histories[chatId] = cleanHistory(raw.history, { maxMessages, maxChars });
    const projectName = raw.project && typeof raw.project.name === 'string' ? raw.project.name.trim().slice(0, 120) : '';
    if (!projectName) { freeChats.push(meta); continue; }
    const key = projectName.toLowerCase();
    if (!groups.has(key)) { const match = byName.get(key); groups.set(key, { projectId: match ? match.id : null, name: match ? match.name : projectName, chats: [] }); }
    groups.get(key).chats.push(meta);
  }
  const projectChats = [...groups.values()];
  return { freeChats, projectChats, histories, skipped, imported: freeChats.length + projectChats.reduce((n, g) => n + g.chats.length, 0) };
}

module.exports = { planImport, MAX_CHATS };
