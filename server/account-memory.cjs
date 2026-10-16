'use strict';
// Settings → Personalization → Memory: facts about the user that apply to every non-Diary chat,
// and whether each project's own memory lines are used. Stored per user beside projects.json. The
// Rust front writes it (PUT /api/account/memory, sbstndalton/noevia#1071); chat.cjs reads it here.
const fs = require('node:fs');
const path = require('node:path');

const FILE = 'account-memory.json';
const MAX_ITEMS = 50;
const MAX_ITEM_CHARS = 300;

function empty() { return { memories: [], useProjectMemories: true, updatedAt: null }; }

function read(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    const memories = Array.isArray(data.memories) ? data.memories.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim().slice(0, MAX_ITEM_CHARS)).slice(0, MAX_ITEMS) : [];
    return { memories, useProjectMemories: data.useProjectMemories !== false, updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : null };
  } catch { return empty(); }
}

// The memory block for the system message: account lines first, then the project's own lines
// unless the user turned those off. Null when there is nothing to say.
function systemPart(settings, projectMemories = []) {
  const project = settings.useProjectMemories && Array.isArray(projectMemories) ? projectMemories.filter((m) => typeof m === 'string' && m.trim()) : [];
  const lines = [...new Set([...settings.memories, ...project])];
  if (!lines.length) return null;
  return `Things you know about the user (persistent memory, apply silently):\n${lines.map((m) => `- ${m}`).join('\n')}`;
}

module.exports = { read, systemPart, MAX_ITEMS, MAX_ITEM_CHARS };
