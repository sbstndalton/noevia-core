'use strict';
// Project modes (#1576). A project used to record which app modes it appeared in (Chat, Cowork,
// Code), and a project without Chat refused chat turns and was hidden from the chat sidebar. Since
// #1576 there is one chat surface: a project is just a project, every live project takes chats, and
// Task (internal id `cowork`) is a per-send choice in the composer that chat-mode.cjs authorises.
//
// `modes` stays in projects.json as a storage name so older clients and the Rust front (which pass
// it through untouched) keep working. It is now informational: the load migration makes sure it
// names Chat, keeping every other recorded value (no data loss, idempotent), and writes from old
// clients are accepted and normalised the same way rather than refused.
const MODES = ['chat', 'cowork', 'code'];

/** Ensure the stored list names Chat first; other recorded values are kept. True when it changed. */
function migrate(project) {
  if (!project || typeof project !== 'object') return false;
  const before = Array.isArray(project.modes) ? project.modes : null;
  const kept = before ? MODES.filter((mode) => mode !== 'chat' && before.includes(mode)) : [];
  const next = ['chat', ...kept];
  if (before && before.length === next.length && before.every((mode, i) => mode === next[i])) return false;
  project.modes = next;
  return true;
}

/** A `modes` value from a request. Accepted for compatibility; it never turns Chat off. */
function sanitize(value) {
  if (!Array.isArray(value)) throw Object.assign(new Error('modes must be an array'), { status: 400 });
  if (value.some((mode) => !MODES.includes(mode))) throw Object.assign(new Error(`modes may only contain ${MODES.join(', ')}`), { status: 400 });
  return ['chat', ...MODES.filter((mode) => mode !== 'chat' && value.includes(mode))];
}

/** Every project takes chats (#1576); Cowork and Code stay recorded values only. */
function enabled(project, mode) {
  if (mode === 'chat') return true;
  return Array.isArray(project?.modes) && project.modes.includes(mode);
}

// Where a chat may live (#810): a project that is not archived. Since #1576 every project is a chat
// project, so archiving is the only thing that keeps chats out.
function chatDestination(project) {
  return !!project && typeof project === 'object' && project.archived !== true;
}

module.exports = { MODES, migrate, sanitize, enabled, chatDestination };
