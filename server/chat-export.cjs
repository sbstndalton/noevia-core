'use strict';
// The conversation export's shared pieces: the Markdown a chat is written as (also the single-chat
// download and the vault mirror), the format name conversations.json carries (chat-import.cjs
// reads it) and a stored-entry ZIP writer. The export itself (GET /api/export/conversations) is
// the Rust front's since sbstndalton/noevia#1071 (noevia-rs crates/server-export).
// Reasoning text is left out on purpose: it is scratch work, not part of the conversation.
const zlib = require('node:zlib');

const FORMAT = 'noevia-conversations-v1';
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

// #2116: a failed reply (an assistant turn with a `failure` sentence) is not an answer: it says it failed, after any text that
// had streamed in before the failure. noevia-rs crates/server-export markdown.rs renders the same words.
const failed = (m) => m.role === 'assistant' && typeof m.failure === 'string' && m.failure.trim() !== '';

function chatMarkdown(chat, history) {
  const lines = [`# ${chat.title || 'Untitled chat'}`, ''];
  if (chat.updatedAt) lines.push(`_Last updated ${new Date(chat.updatedAt).toISOString()}_`, '');
  for (const m of history) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = String(m.content || '').trim();
    const body = failed(m) ? (text ? `${text}\n\n_(The reply failed before it finished.)_` : '_(The reply failed; no answer was written.)_') : text || '_(no text)_';
    lines.push(`## ${m.role === 'user' ? 'You' : 'Assistant'}`, '', body, '');
    const tools = (m.toolCalls || []).map((t) => t && t.name).filter(Boolean);
    if (tools.length) lines.push(`_Tools used: ${tools.join(', ')}_`, '');
  }
  return lines.join('\n');
}

module.exports = { zipStore, chatMarkdown, FORMAT };
