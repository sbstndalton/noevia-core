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

const PRIVATE_TOOLBOXES = new Set(['diary']);

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
 *  storage connection (authService.getStorage). Diary tools are refused by name as well. */
function toolRefusal({ provider, toolName, rawArgs, storage }) {
  if (!isExternalProvider(provider)) return null;
  const name = String(toolName || '');
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

module.exports = { PRIVATE_TOOLBOXES, isExternalProvider, egressRefusal, stripPrivateToolboxes, toolRefusal, diaryFolderFor, canonicalPath };
