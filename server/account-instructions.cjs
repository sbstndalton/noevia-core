'use strict';
// Settings → Personalization → Custom instructions: one standing instruction for every chat of
// this user (not the Diary, which has its own prompt). Stored per user beside projects.json.
const fs = require('node:fs');
const path = require('node:path');

const MAX_CHARS = 4000;
const FILE = 'account-instructions.json';

function readable(message, status = 400) { return Object.assign(Error(message), { publicMessage: message, status }); }

function read(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return { text: typeof data.text === 'string' ? data.text.slice(0, MAX_CHARS) : '', updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : null };
  } catch { return { text: '', updatedAt: null }; }
}

function write(dir, text, now = Date.now()) {
  if (typeof text !== 'string') throw readable('Send the instructions as text.');
  const clean = text.trim();
  if (clean.length > MAX_CHARS) throw readable(`Keep custom instructions under ${MAX_CHARS} characters.`);
  const file = path.join(dir, FILE);
  if (!clean) { fs.rmSync(file, { force: true }); return { text: '', updatedAt: null }; }
  fs.mkdirSync(dir, { recursive: true });
  const record = { text: clean, updatedAt: now };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return record;
}

function systemPart(text) {
  if (!text) return null;
  return `The user's custom instructions for all chats (project instructions take precedence where they conflict):\n${text}`;
}

module.exports = { read, write, systemPart, MAX_CHARS };
