'use strict';
// Chat list saves merge instead of replacing. A browser tab (or another device) holding an older list
// must not erase chats created elsewhere, and deletions — which only happen through DELETE routes —
// leave a tombstone so a stale list cannot bring a chat back.
const fs = require('node:fs');
const path = require('node:path');

const LIST_CAP = 1000;
const TOMBSTONE_CAP = 5000;

function tombstoneFile(dir) { return path.join(dir, 'deleted-chats.json'); }

function readTombstones(dir) {
  try { const ids = JSON.parse(fs.readFileSync(tombstoneFile(dir), 'utf8')); return new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : []); }
  catch { return new Set(); }
}

function addTombstone(dir, id) {
  const ids = [...readTombstones(dir)].filter((x) => x !== id);
  ids.push(id);
  fs.mkdirSync(dir, { recursive: true });
  const file = tombstoneFile(dir), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ids.slice(-TOMBSTONE_CAP)));
  fs.renameSync(tmp, file);
}

/** Incoming entries replace same-id entries; entries only on the server stay; tombstoned ids never return. */
function mergeChats(current, incoming, tombstones = new Set()) {
  const byId = new Map();
  for (const chat of current || []) if (chat && typeof chat.id === 'string' && !tombstones.has(chat.id)) byId.set(chat.id, chat);
  for (const chat of incoming || []) if (chat && typeof chat.id === 'string' && chat.id && !tombstones.has(chat.id)) byId.set(chat.id, chat);
  return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, LIST_CAP);
}

module.exports = { mergeChats, readTombstones, addTombstone, LIST_CAP };
