'use strict';
// Which instruction skills one tool call read (#272): chat.cjs noteSkillRead and the native executor's
// skills/read bridge (rust-chat-native.cjs) decide it with this one function.
//
// A skill body the model fetched itself is loaded too, at the version read. Tracked by WHAT was read, not by
// which tool read it: read_project_file, the Project documents box's project_read_file (same reader through
// MCP) or anything else. A successful call that names a skill file, or whose result carries a skill's SHA-256
// (the reader's heading), counts. Tracking too much only makes revocation stricter, which is the safe direction.

/**
 * The `candidates` (enabled skills not loaded yet, in the project's list order: {file, hash, name, ...}) that
 * the call with `rawArgs` and `result` read, in that order, at most one per file. The readers accept a unique
 * bare name for a file stored under a path (#642), so the argument is resolved against `project` the same way
 * before it is compared with a skill's stored name.
 */
function matchedReads(project, candidates, rawArgs, result) {
  let name = null;
  try { const args = JSON.parse(rawArgs || '{}'); if (args && typeof args.name === 'string') name = args.name; } catch { /* no usable args */ }
  const resolvedName = name ? require('./project-file-names.cjs').resolveProjectFile(project, name).file?.name ?? null : null;
  const text = String(result ?? '');
  const out = [], taken = new Set();
  for (const skill of Array.isArray(candidates) ? candidates : []) {
    if (taken.has(skill.file)) continue;
    if (skill.file === name || skill.file === resolvedName || text.includes(skill.hash)) { taken.add(skill.file); out.push(skill); }
  }
  return out;
}

module.exports = { matchedReads };
