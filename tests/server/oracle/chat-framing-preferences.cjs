'use strict';
// Frozen test-only behavior oracle from core 1a28f622, chat-framing.cjs.
// Original whole source SHA256: 50c65f0445116f074852cbcc8e11cdba5a404285dd922ed0a43d28311978b42d
const PREFERENCES_FILE = 'chat-framing.json';
// The person's own framing choices, both off by default: autoAccept (#738) and keepReasoningTraces
// (#740, append the reasoner's task packets to a local JSONL file in their workspace).
const PREFERENCE_KEYS = Object.freeze(['autoAccept', 'keepReasoningTraces']);
function readPreferences(dir) {
  let data = null;
  try { data = JSON.parse(require('node:fs').readFileSync(require('node:path').join(dir, PREFERENCES_FILE), 'utf8')); } catch { data = null; }
  return Object.fromEntries(PREFERENCE_KEYS.map((k) => [k, data?.[k] === true]));
}
/** A partial update: each key given must be a boolean; keys not given keep their saved value. */
function writePreferences(dir, value) {
  const given = value && typeof value === 'object' && !Array.isArray(value) ? PREFERENCE_KEYS.filter((k) => k in value) : [];
  if (!given.length || given.some((k) => typeof value[k] !== 'boolean')) throw Object.assign(Error('autoAccept and keepReasoningTraces must be true or false'), { status: 400 });
  const fs = require('node:fs'), path = require('node:path');
  const record = { ...readPreferences(dir), ...Object.fromEntries(given.map((k) => [k, value[k]])) };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, PREFERENCES_FILE), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return record;
}

module.exports = { readPreferences, writePreferences };
