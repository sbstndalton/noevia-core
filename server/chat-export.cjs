'use strict';
// Settings → Data → Export conversations. One ZIP per request with a Markdown file per chat
// (readable anywhere) and conversations.json (complete, for re-import later). Stored entries
// only: text compresses on the user's side if they care, and no dependency is needed.
// Reasoning text is left out on purpose: it is scratch work, not part of the conversation.
const zlib = require('node:zlib');

const FORMAT = 'noevia-conversations-v1';
// The ZIP is built in memory and synchronously, so a very large history must be refused rather than
// stall every tenant or throw halfway (#867). The limits bound the Markdown plus conversations.json
// payload and the number of ZIP entries (classic ZIP allows 65,535).
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_EXPORT_ENTRIES = 20000;

class ExportTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExportTooLargeError';
    this.status = 413;
    this.publicMessage = message;
  }
}
const mb = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

function dosDateTime(ms) {
  const d = new Date(ms);
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

/** @param {{name:string,data:Buffer}[]} entries @param {number} [when] */
function zipStore(entries, when = Date.now()) {
  const { time, date } = dosDateTime(when);
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8'), crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data); centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function slug(text, fallback) {
  const s = String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || fallback;
}

function chatMarkdown(chat, history) {
  const lines = [`# ${chat.title || 'Untitled chat'}`, ''];
  if (chat.updatedAt) lines.push(`_Last updated ${new Date(chat.updatedAt).toISOString()}_`, '');
  for (const m of history) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    lines.push(`## ${m.role === 'user' ? 'You' : 'Assistant'}`, '', String(m.content || '').trim() || '_(no text)_', '');
    const tools = (m.toolCalls || []).map((t) => t && t.name).filter(Boolean);
    if (tools.length) lines.push(`_Tools used: ${tools.join(', ')}_`, '');
  }
  return lines.join('\n');
}

function buildExport({ freeChats = [], projects = [], readHistory, now = Date.now(), maxBytes = MAX_EXPORT_BYTES, maxEntries = MAX_EXPORT_ENTRIES }) {
  const entries = [], taken = new Set(), chatJson = [];
  let total = 0;
  const tooLarge = () => new ExportTooLargeError(`Your conversations are too large to export in one file (the limit is ${mb(maxBytes)} and ${maxEntries.toLocaleString('en-US')} chats). Delete conversations you no longer need and try again.`);
  const projectChats = projects.reduce((n, project) => n + (project.chats || []).length, 0);
  // Two more entries: README.md and conversations.json. Checked before any history is read.
  if (freeChats.length + projectChats + 2 > maxEntries) throw tooLarge();
  const take = (bytes) => { total += bytes; if (total > maxBytes) throw tooLarge(); };
  const add = (name, text) => {
    let unique = name, n = 2;
    while (taken.has(unique)) unique = name.replace(/\.md$/, `-${n++}.md`);
    taken.add(unique);
    const data = Buffer.from(text, 'utf8');
    take(data.length);
    entries.push({ name: unique, data });
  };
  const idPart = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  // conversations.json is assembled chat by chat, byte for byte what JSON.stringify(whole, null, 2)
  // gives. Each chat's bytes are counted once, as they are made; the file itself is joined as
  // buffers, and only its wrapper (header, separators, footer) is counted when it is added (#893).
  const addChat = (chat, project) => {
    const history = readHistory(chat.id);
    const md = chatMarkdown(chat, history);
    let json;
    try {
      json = JSON.stringify({ id: chat.id, title: chat.title || '', updatedAt: chat.updatedAt || null, project, history: history.map(({ reasoning, ...m }) => m) }, null, 2).replace(/\n/g, '\n    ');
    } catch (error) {
      if (error instanceof RangeError) throw tooLarge(); // 'Invalid string length'
      throw error;
    }
    const data = Buffer.from(json, 'utf8');
    take(data.length);
    chatJson.push(data);
    return md;
  };
  for (const chat of freeChats) add(`chats/${slug(chat.title, 'untitled-chat')}-${idPart(chat.id)}.md`, addChat(chat, null));
  for (const project of projects) {
    const folder = `projects/${slug(project.name, idPart(project.id) || 'project')}`;
    for (const chat of project.chats || []) add(`${folder}/${slug(chat.title, 'untitled-chat')}-${idPart(chat.id)}.md`, addChat(chat, { id: project.id, name: project.name }));
  }
  const count = chatJson.length;
  add('README.md', `# noevia conversations\n\nExported ${new Date(now).toISOString()}. ${count} chat${count === 1 ? '' : 's'}.\n\n- \`chats/\`: chats outside projects, one Markdown file each.\n- \`projects/\`: chats grouped by project.\n- \`conversations.json\`: everything above in one file (format ${FORMAT}).\n\nThinking text is not included.\n`);
  const head = Buffer.from(`{\n  "format": ${JSON.stringify(FORMAT)},\n  "exportedAt": ${JSON.stringify(new Date(now).toISOString())},\n  "chats": ${count ? '[\n    ' : '[]'}`, 'utf8');
  const sep = Buffer.from(',\n    ', 'utf8'), tail = Buffer.from(`${count ? '\n  ]' : ''}\n}`, 'utf8');
  const parts = [head];
  chatJson.forEach((data, i) => { if (i) parts.push(sep); parts.push(data); });
  parts.push(tail);
  // The chats' own bytes were taken in addChat; count only the wrapper here.
  take(head.length + tail.length + sep.length * Math.max(0, count - 1));
  taken.add('conversations.json');
  entries.push({ name: 'conversations.json', data: Buffer.concat(parts) });
  return zipStore(entries, now);
}

module.exports = { zipStore, chatMarkdown, buildExport, FORMAT, ExportTooLargeError, MAX_EXPORT_BYTES, MAX_EXPORT_ENTRIES };
