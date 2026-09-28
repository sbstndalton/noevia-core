'use strict';
// What may leave the server through an EXTERNAL provider (#447).
//
// An external provider is one the server marks as sending chats to a third-party service on a
// person's own account: today only "Sign in with ChatGPT" rows (kind chatgpt-oauth, or a row the
// server flagged external:true; neither can be set through POST /api/providers). Custom
// OpenAI-compatible endpoints keep their existing behaviour.
//
// The rules, enforced in code by chat.cjs rather than by instructions to the model:
//   1. Diary text never goes to an external provider. The Diary space itself always talks to the
//      Diary sidecar; Diary extras (the preparation step that runs on a chat model, with the Diary
//      message as its prompt) are refused on an external provider.
//   2. Private tools are not offered through an external provider: the `diary` toolbox would read
//      the private journal into a request bound for a third party.
//   3. Project images are not attached automatically (spec-document-understanding: "Do not
//      automatically send sources to a new cloud provider").
//   4. Storage tools cannot reach the Diary folder (#452). Nextcloud Files reads run without an
//      approval card, so `nc_webdav_read_file` on a journal entry would hand it to the provider.
//      Every path-like argument of a storage tool is normalised (URL-decoding, backslashes, ./..,
//      duplicate and trailing slashes, a full DAV URL, case, Unicode form) and refused when it is
//      the Diary folder or inside it. The folder is the storage connection's corpusRoot, the
//      same setting the Diary and storage-client.cjs use, placed under the connection's DAV root.
//      If the folder cannot be worked out, storage tools are refused outright (fail closed).
// Every write still goes through the approval card; nothing here widens what a chat may do.
//
// Separately (#516), `evaluateToolCall`/`validateToolArguments` validate a tool call's arguments
// against an optional registered JSON-schema subset for EVERY provider, not just external ones —
// local models are the primary target. It is off by default (a code flag, not a live preference)
// and a no-op with no registered schema, so it never changes today's behaviour on its own.

const { createValidator } = require('./stream-guard.cjs');

const PRIVATE_TOOLBOXES = new Set(['diary']);

// ── Stream-guard integration (#516) ─────────────────────────────────────────
// An optional, additive check, independent of isExternalProvider: when
// enabled, tool-call arguments for EVERY provider — local/default included,
// which is the common case a local-model harness needs — are validated
// against a restricted JSON-schema subset registered per tool name, using the
// same incremental validator the streaming path uses (stream-guard.cjs). It is
// fed the arguments in one chunk here because by the time a tool call reaches
// this seam its arguments have already fully arrived off the SSE stream; the
// validator itself is what is incremental, not this call site.
//
// OFF by default: this is a code flag, never a live/user preference, and no
// tool has a registered schema yet, so enabling it with no registrations is
// still a no-op. Flipping it on and registering schemas does not touch any
// of the external-provider-only rules in `toolRefusal` below.
// `__setStreamGuardEnabledForTests` only works under the test runner (guarded
// by NODE_TEST_CONTEXT/NODE_ENV=test); production code cannot flip the flag.
let STREAM_GUARD_ENABLED = false;
const TOOL_ARGUMENT_SCHEMAS = Object.create(null);

/** Registers (or clears, with schema=null/undefined) a restricted JSON-schema
 *  for a tool's arguments. Only consulted when STREAM_GUARD_ENABLED is true. */
function setToolArgumentSchema(toolName, schema) {
  if (schema) TOOL_ARGUMENT_SCHEMAS[toolName] = schema;
  else delete TOOL_ARGUMENT_SCHEMAS[toolName];
}

/** Test-only: flips the code-level enable flag. Throws outside a test run
 *  (no NODE_TEST_CONTEXT and NODE_ENV !== 'test') so production code cannot
 *  use this as a back door to a live toggle. */
function __setStreamGuardEnabledForTests(enabled) {
  if (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== 'test') {
    throw new Error('__setStreamGuardEnabledForTests is test-only; flip STREAM_GUARD_ENABLED in code instead.');
  }
  STREAM_GUARD_ENABLED = !!enabled;
}

/** First schema violation in a tool's arguments against its registered schema,
 *  or null when the flag is off, no schema is registered, or they validate.
 *  Runs for every provider — this is not one of the external-provider-only
 *  rules below. */
function validateToolArguments(toolName, rawArgs) {
  if (!STREAM_GUARD_ENABLED) return null;
  const schema = TOOL_ARGUMENT_SCHEMAS[toolName];
  if (!schema) return null;
  const validator = createValidator(schema);
  const text = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});
  return validator.feed(text) || validator.end();
}

function isExternalProvider(provider) {
  return !!provider && (provider.kind === 'chatgpt-oauth' || provider.external === true);
}

/** Why this request may not use this provider, or null. */
function egressRefusal({ provider, spaceId, projectId, diaryProjectId }) {
  if (!isExternalProvider(provider)) return null;
  if ((typeof spaceId === 'string' && spaceId.startsWith('diary')) || (diaryProjectId && projectId === diaryProjectId)) {
    return `Diary text is never sent to an external provider (${provider.label || 'ChatGPT'}). Choose a local model for Diary attachments and tools.`;
  }
  return null;
}

/** Removes private toolboxes from the selection, in place; returns the ids removed. */
function stripPrivateToolboxes(selected, provider) {
  if (!isExternalProvider(provider)) return [];
  const removed = [];
  for (let k = selected.length - 1; k >= 0; k--) if (PRIVATE_TOOLBOXES.has(selected[k])) removed.unshift(...selected.splice(k, 1));
  return removed;
}

// ── Rule 4: the Diary folder ────────────────────────────────────────────────
const STORAGE_TOOL = /^nc_webdav_/;
// Tree tools search or recurse below their scope, so a scope that CONTAINS the Diary (the root,
// '', or any ancestor) reaches it too. The manifest (mcp-toolbox-manifest.cjs) gives no argument
// schema, so the Nextcloud search/find tools are all treated as tree tools, and any storage call
// carrying a recursive/depth argument counts as one. A plain listing of an ancestor stays allowed:
// it returns only the names directly in that folder, never file content.
const TREE_TOOL = /^nc_webdav_(?:search_files|find_by_name|find_by_type)$/;
const recursiveArgs = (args) => Object.entries(args || {}).some(([k, v]) => /recurs|depth|deep/i.test(k) && v !== false && v !== 0 && v !== '0' && v !== 1 && v !== '1' && v !== null);
const PATH_KEY = /path|dir|folder|file|scope|source|destination|target|href|url|location|from|to$/i;

/** One path, reduced to its canonical folder-relative form ('' is the files root). */
function canonicalPath(value) {
  let text = String(value ?? '').normalize('NFC');
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(text); i++) { try { text = decodeURIComponent(text); } catch { break; } }
  text = text.replace(/\\/g, '/');
  // A full DAV URL or a /remote.php/... path: keep what follows the user's files root.
  const dav = /(?:^[a-z][a-z0-9+.-]*:\/\/[^/]*)?\/?remote\.php\/(?:dav\/files\/[^/]+|webdav)(\/.*)?$/i.exec(text);
  if (dav) text = dav[1] || '';
  else text = text.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  const out = [];
  for (const segment of text.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { out.pop(); continue; }
    out.push(segment);
  }
  return out.join('/').toLowerCase();
}

/** The Diary folder relative to the Nextcloud files root, or null when it cannot be worked out. */
function diaryFolderFor(storage) {
  if (!storage || !['nextcloud', 'webdav'].includes(storage.kind)) return null;
  const root = String(storage.corpusRoot || '').trim();
  if (!root) return null; // the Diary is the whole connection: nothing outside it is known to be safe
  let base = '';
  try { base = new URL(String(storage.baseUrl || '')).pathname; } catch { base = String(storage.baseUrl || ''); }
  const dav = /\/remote\.php\/(?:dav\/files\/[^/]+|webdav)(\/.*)?$/i.exec(base);
  const prefix = dav ? canonicalPath(dav[1] || '') : '';
  const folder = [prefix, canonicalPath(root)].filter(Boolean).join('/');
  return folder || null;
}

function pathArguments(args, depth = 0, out = []) {
  if (depth > 3 || !args || typeof args !== 'object') return out;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && PATH_KEY.test(key)) out.push(value);
    else if (Array.isArray(value)) for (const v of value) { if (typeof v === 'string' && PATH_KEY.test(key)) out.push(v); else pathArguments(v, depth + 1, out); }
    else if (value && typeof value === 'object') pathArguments(value, depth + 1, out);
  }
  return out;
}

/** Why this tool call may not run for an external provider, or null. `storage` is the account's
 *  storage connection (authService.getStorage). Diary tools are refused by name as well.
 *  External-provider-only: a local/default provider always gets null from this function. Use
 *  `evaluateToolCall` for the combined check (stream-guard, for every provider, ahead of this). */
function toolRefusal({ provider, toolName, rawArgs, storage }) {
  const name = String(toolName || '');
  if (!isExternalProvider(provider)) return null;
  const label = provider.label || 'an external provider';
  if (/^diary_/.test(name)) return `ERROR: ${name} is not available with ${label}: Diary content is never sent to an external provider.`;
  if (!STORAGE_TOOL.test(name)) return null;
  const folder = diaryFolderFor(storage);
  if (!folder) return `ERROR: ${name} is not available with ${label}: the Diary folder could not be identified, so storage is closed to external providers. Use a local model for file work.`;
  let args;
  try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {}; } catch { return `ERROR: ${name} arguments could not be read, so it was not run.`; }
  const paths = pathArguments(args);
  const tree = TREE_TOOL.test(name) || recursiveArgs(args);
  // A search with no folder to search in would search the Diary too.
  if (tree && !paths.length) return `ERROR: ${name} needs a folder to search in when used with ${label}, so it was not run. Search a specific folder outside the Diary.`;
  for (const value of paths) {
    const target = canonicalPath(value);
    if (target === folder || target.startsWith(`${folder}/`)) {
      return `ERROR: ${name} was not run: that path is in the Diary folder, and Diary content is never sent to ${label}. Do not retry; tell the user to use a local model for Diary files.`;
    }
    // An ancestor scope ('' is the root) contains the Diary: refused for tree tools only.
    if (tree && (target === '' || folder.startsWith(`${target}/`))) {
      return `ERROR: ${name} was not run: that folder contains the Diary folder, and Diary content is never sent to ${label}. Search a folder that does not contain the Diary.`;
    }
  }
  return null;
}

/** The combined tool-call check chat.cjs's `egressToolRefusal` wrapper uses: the stream-guard
 *  schema check first (#516, every provider), then the external-provider-only rules in
 *  `toolRefusal` (Diary/storage, unchanged). Returns the reason the call may not run, or null. */
function evaluateToolCall({ provider, toolName, rawArgs, storage }) {
  const name = String(toolName || '');
  const guardViolation = validateToolArguments(name, rawArgs);
  if (guardViolation) return `ERROR: ${name} arguments failed schema validation (${guardViolation.message}), so it was not run.`;
  return toolRefusal({ provider, toolName: name, rawArgs, storage });
}

module.exports = {
  PRIVATE_TOOLBOXES,
  isExternalProvider,
  egressRefusal,
  stripPrivateToolboxes,
  toolRefusal,
  evaluateToolCall,
  diaryFolderFor,
  canonicalPath,
  setToolArgumentSchema,
  validateToolArguments,
  __setStreamGuardEnabledForTests,
};
