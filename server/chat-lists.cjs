'use strict';
// Chat list saves merge instead of replacing. A browser tab (or another device) holding an older list
// must not erase chats created elsewhere, and deletions — which only happen through DELETE routes —
// leave a tombstone so a stale list cannot bring a chat back.
const fs = require('node:fs');
const path = require('node:path');

const LIST_CAP = 1000;
const TOMBSTONE_CAP = 5000;

/** The id a chat is stored under: the same rule for history files, metas and tombstones,
 *  so a raw id that differs only by stripped characters cannot dodge a tombstone. */
function safeChatId(id) { return String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, ''); }

function tombstoneFile(dir) { return path.join(dir, 'deleted-chats.json'); }

function readTombstones(dir) {
  try { const ids = JSON.parse(fs.readFileSync(tombstoneFile(dir), 'utf8')); return new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : []); }
  catch { return new Set(); }
}

function addTombstone(dir, id) {
  // Metas match by raw id, history files by the safe id: record both so neither can return.
  const added = [...new Set([String(id), safeChatId(id)])].filter(Boolean);
  const ids = [...readTombstones(dir)].filter((x) => !added.includes(x));
  ids.push(...added);
  fs.mkdirSync(dir, { recursive: true });
  const file = tombstoneFile(dir), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ids.slice(-TOMBSTONE_CAP)));
  fs.renameSync(tmp, file);
}

/** Chat framing (#737): a client that does not know about frames (an older tab) sends metas without
 *  one, which must not erase the stored frame; `frame: null` clears it on purpose. createdAt is set
 *  once and never moves. An invalid frame is ignored rather than stored. */
function withKeptFields(current, chat) {
  const next = { ...chat };
  if (!('frame' in chat)) { if (current && 'frame' in current) next.frame = current.frame; }
  else if (chat.frame !== null) {
    const frame = require('./chat-framing.cjs').normalizeFrame(chat.frame);
    if (frame) next.frame = frame; else if (current && 'frame' in current) next.frame = current.frame; else delete next.frame;
  }
  // #778: the per-chat routing flags follow the same rule: absent keeps the stored value (an older
  // tab), a boolean replaces it, anything else is dropped.
  for (const key of ['forceLocal', 'allowCloud']) {
    if (!(key in chat)) { if (current && typeof current[key] === 'boolean') next[key] = current[key]; }
    else if (typeof chat[key] !== 'boolean') { if (current && typeof current[key] === 'boolean') next[key] = current[key]; else delete next[key]; }
  }
  const created = Number.isFinite(current?.createdAt) ? current.createdAt : Number.isFinite(chat.createdAt) ? chat.createdAt : undefined;
  if (created === undefined) delete next.createdAt; else next.createdAt = created;
  return next;
}

/** Incoming entries replace same-id entries; entries only on the server stay; tombstoned ids never return.
 *  `elsewhere` (#755): ids that live in another list of the workspace; a stale whole-list save
 *  must not copy a moved chat back into its old list, so incoming entries with those ids are skipped. */
function mergeChats(current, incoming, tombstones = new Set(), elsewhere = new Set()) {
  const byId = new Map();
  for (const chat of current || []) if (chat && typeof chat.id === 'string' && !tombstones.has(chat.id)) byId.set(chat.id, chat);
  for (const chat of incoming || []) if (chat && typeof chat.id === 'string' && chat.id && !tombstones.has(chat.id) && !elsewhere.has(chat.id)) byId.set(chat.id, withKeptFields(byId.get(chat.id), chat));
  return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, LIST_CAP);
}

// The incoming ids mergeChats drops because another list holds them (#765), deduplicated.
function skippedElsewhere(incoming, elsewhere = new Set()) {
  const out = new Set();
  for (const chat of incoming || []) if (chat && typeof chat.id === 'string' && elsewhere.has(chat.id)) out.add(chat.id);
  return [...out];
}

module.exports = { mergeChats, skippedElsewhere, readTombstones, addTombstone, safeChatId, LIST_CAP };
