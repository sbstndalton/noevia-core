'use strict';
// Settings → Personalization → Memory: facts about the user that apply to every non-Diary chat,
// and whether each project's own memory lines are used. Stored per user beside projects.json.
const fs = require('node:fs');
const path = require('node:path');

const FILE = 'account-memory.json';
const MAX_ITEMS = 50;
const MAX_ITEM_CHARS = 300;

function readable(message, status = 400) { return Object.assign(Error(message), { publicMessage: message, status }); }
function empty() { return { memories: [], useProjectMemories: true, updatedAt: null }; }

function read(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    const memories = Array.isArray(data.memories) ? data.memories.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim().slice(0, MAX_ITEM_CHARS)).slice(0, MAX_ITEMS) : [];
    return { memories, useProjectMemories: data.useProjectMemories !== false, updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : null };
  } catch { return empty(); }
}

function write(dir, input, now = Date.now()) {
  if (!input || !Array.isArray(input.memories) || input.memories.some((m) => typeof m !== 'string')) throw readable('Send memories as a list of text lines.');
  if (input.useProjectMemories !== undefined && typeof input.useProjectMemories !== 'boolean') throw readable('useProjectMemories must be true or false.');
  const memories = [...new Set(input.memories.map((m) => m.replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (memories.length > MAX_ITEMS) throw readable(`Keep at most ${MAX_ITEMS} memories.`);
  if (memories.some((m) => m.length > MAX_ITEM_CHARS)) throw readable(`Keep each memory under ${MAX_ITEM_CHARS} characters.`);
  const useProjectMemories = input.useProjectMemories !== false;
  const file = path.join(dir, FILE);
  if (!memories.length && useProjectMemories) { fs.rmSync(file, { force: true }); return empty(); }
  fs.mkdirSync(dir, { recursive: true });
  const record = { memories, useProjectMemories, updatedAt: now };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return record;
}

// The memory block for the system message: account lines first, then the project's own lines
// unless the user turned those off. Null when there is nothing to say.
function systemPart(settings, projectMemories = []) {
  const project = settings.useProjectMemories && Array.isArray(projectMemories) ? projectMemories.filter((m) => typeof m === 'string' && m.trim()) : [];
  const lines = [...new Set([...settings.memories, ...project])];
  if (!lines.length) return null;
  return `Things you know about the user (persistent memory, apply silently):\n${lines.map((m) => `- ${m}`).join('\n')}`;
}

module.exports = { read, write, systemPart, MAX_ITEMS, MAX_ITEM_CHARS };
