'use strict';
// #1805: import a whole folder from this computer, every subfolder included, and read every
// subfolder of an attached storage folder.
//
// The rules live here so the upload route, the plan route and the folder refresh agree:
//  - relativePath: a folder import names each file by its path inside the chosen folder
//    (`docs/api/auth.md`). Backslashes become `/`, empty segments collapse, and anything that
//    could leave the folder (`..`, `.`, a leading `/`, a drive letter, a control character) is
//    refused, never rewritten.
//  - skipReason: one shared list (contracts/folder-import.json, pinned in noevia-web) of system
//    and tool folders and files, skipped at any depth, plus every hidden (dot) name, plus any
//    type a project cannot read.
//  - caps: files and bytes per import, from FOLDER_IMPORT_MAX_FILES (default: the project source
//    limit) / FOLDER_IMPORT_MAX_BYTES. The project limits (source-limits.cjs) apply on top.
//  - plan + tickets: the client sends the folder's manifest (path, size, SHA-256) first. The
//    plan answers what will be uploaded, what is unchanged (same content hash at the same path)
//    and what is skipped and why. Only a path the plan accepted can be uploaded under that
//    import's id, so the caps hold on the server, not only in the browser.
//  - listTree: a breadth-first walk of an attached folder, bounded by depth and folder count,
//    that skips the same names and leaves a nested attached folder to its own entry.

const crypto = require('node:crypto');
const contract = require('../contracts/folder-import.json');
const sourceLimits = require('./source-limits.cjs');

const SKIP = new Set(contract.skipNames.map((n) => n.toLowerCase()));
const READABLE = new Set(contract.readableExtensions);
const PATH_MAX = 1000;
const SEGMENT_MAX = 200;
const TICKET_TTL_MS = 60 * 60 * 1000;
// Per person: a new plan retires that person's oldest open import beyond this, never anyone else's.
const TICKETS_PER_USER = 4;
// Across everyone: past this, a new plan is refused (429) rather than evicting another person's import.
const TICKETS_MAX = 1024;
const MANIFEST_MAX = 20000;

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** The caps in force: env first, then defaults. A folder import's file cap defaults to the project
 *  source limit (source-limits.cjs), so raising that raises this. Read per call. */
function limits(env = process.env) {
  return {
    maxFiles: positiveInt(env.FOLDER_IMPORT_MAX_FILES, sourceLimits.limits(env).sources),
    maxBytes: positiveInt(env.FOLDER_IMPORT_MAX_BYTES, contract.maxBytes),
    maxDepth: contract.maxDepth,
    maxFolders: contract.maxFolders,
  };
}

const refuse = (message) => Object.assign(new Error(message), { status: 400, code: 'invalidPath' });

/** The canonical relative path (NFC, `/`-separated), or a thrown 400. Never rewrites a traversal. */
function relativePath(raw) {
  if (typeof raw !== 'string') throw refuse('A folder import names each file by its path inside the folder.');
  // NFC: macOS file systems hand out decomposed names; one spelling per name, or `é` arrives twice.
  const value = raw.normalize('NFC').replace(/\\/g, '/');
  if (!value || value.length > PATH_MAX) throw refuse('That path is empty or too long.');
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw refuse('An absolute path cannot be imported; send the path inside the folder.');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) throw refuse('That path contains a control character.');
  const segments = value.split('/').filter(Boolean);
  if (!segments.length) throw refuse('That path is empty.');
  if (segments.some((s) => s === '.' || s === '..')) throw refuse('A path that leaves the folder cannot be imported.');
  if (segments.some((s) => s.length > SEGMENT_MAX || s.trim() !== s || !s.trim())) throw refuse('A folder or file name in that path is too long or blank at its ends.');
  if (segments.length > contract.maxDepth) throw refuse(`That file is more than ${contract.maxDepth} folders deep.`);
  return segments.join('/');
}

const extensionOf = (name) => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot).toLowerCase() : ''; };
/** The case-folded key two names collide under on a case-insensitive disk (macOS, Windows, Nextcloud on them). */
const foldKey = (name) => String(name).normalize('NFC').toLowerCase();

/** Whether one folder or file name is skipped wherever it appears: 'hidden', 'system' or null. */
function skippedName(name) {
  if (SKIP.has(String(name).toLowerCase())) return 'system';
  if (contract.skipHidden && String(name).startsWith('.')) return 'hidden';
  return null;
}

/** Why a canonical relative path is not imported: { code, at } or null. `at` names the segment. */
function skipReason(rel) {
  const segments = rel.split('/');
  for (const s of segments) {
    const why = skippedName(s);
    if (why) return { code: why, at: s };
  }
  const name = segments[segments.length - 1];
  if (!READABLE.has(extensionOf(name))) return { code: 'unsupported', at: extensionOf(name) || name };
  return null;
}

const REASONS = {
  invalidPath: 'This path is not a safe path inside the folder.',
  system: 'System or tool folder, skipped on purpose.',
  hidden: 'Hidden file or folder, skipped on purpose.',
  unsupported: 'This file type cannot be read as a project source.',
  duplicate: 'Listed twice in this import.',
  caseCollision: 'Differs only in letter case from another file in this import or project.',
  empty: 'The file is empty.',
  tooLarge: 'Files are limited to 25 MB; PDFs up to 60 MB.',
  fileLimit: 'This import reached its file limit.',
  sizeLimit: 'This import reached its size limit.',
  projectLimit: 'The project already holds its maximum number of sources.',
  documentLimit: 'The project already holds its maximum number of documents.',
  imageLimit: 'The project already holds its maximum number of images.',
};

const tickets = new Map();
function pruneTickets(now = Date.now()) {
  for (const [id, t] of tickets) if (t.expires <= now) tickets.delete(id);
}
/** Open a ticket for one person, retiring only that person's oldest beyond TICKETS_PER_USER. */
function openTicket(userId, ticket) {
  pruneTickets();
  const mine = [...tickets].filter(([, t]) => t.userId === userId).map(([id]) => id);
  while (mine.length >= TICKETS_PER_USER) tickets.delete(mine.shift());
  if (tickets.size >= TICKETS_MAX) throw Object.assign(new Error('Too many folder imports are in progress on this server. Try again in a few minutes.'), { status: 429 });
  const importId = crypto.randomBytes(16).toString('hex');
  tickets.set(importId, { userId, ...ticket, expires: Date.now() + TICKET_TTL_MS });
  return importId;
}

/**
 * Decide what an import does, and open a ticket for the accepted paths with their declared sizes.
 * @param {object} o
 * @param {string} o.userId
 * @param {object} o.project
 * @param {{path:string,size:number,sha256?:string}[]} o.entries
 * @param {(rel:string) => string} o.destination  the source name a relative path is stored under
 * @param {(name:string) => number} o.perFileCap
 */
function plan({ userId, project, entries, destination, perFileCap, env = process.env }) {
  if (!Array.isArray(entries)) throw Object.assign(new Error('entries must be a list'), { status: 400 });
  if (entries.length > MANIFEST_MAX) throw Object.assign(new Error(`A folder import lists at most ${MANIFEST_MAX} files.`), { status: 400 });
  const caps = limits(env), project_ = sourceLimits.limits(env);
  const files = project.files || [];
  const byName = new Map(files.map((f) => [f.name, f]));
  const byFold = new Map(files.map((f) => [foldKey(f.name), f.name]));
  // Room left in each pool; an update replaces a source of its own kind and takes no new room.
  const held = sourceLimits.counts(files);
  const room = { sources: project_.sources - held.sources, documents: project_.documents - held.documents, images: project_.images - (project.assets || []).length };
  const accepted = [], unchanged = [], skipped = [], seen = new Set(), seenFold = new Set();
  let bytes = 0;
  const skip = (p, code, extra = {}) => skipped.push({ path: p, code, reason: REASONS[code], ...extra });
  const rows = entries.map((e) => (e && typeof e === 'object' ? e : {})).map((e) => ({ raw: String(e.path ?? ''), size: Number(e.size), sha256: typeof e.sha256 === 'string' ? e.sha256.toLowerCase() : '' }));
  rows.sort((a, b) => (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0));
  for (const row of rows) {
    let rel;
    try { rel = relativePath(row.raw); } catch { skip(row.raw.slice(0, PATH_MAX), 'invalidPath'); continue; }
    const why = skipReason(rel);
    if (why) { skip(rel, why.code, { at: why.at }); continue; }
    if (seen.has(rel)) { skip(rel, 'duplicate'); continue; }
    if (seenFold.has(foldKey(rel))) { skip(rel, 'caseCollision'); continue; }
    seen.add(rel); seenFold.add(foldKey(rel));
    if (!Number.isFinite(row.size) || row.size <= 0) { skip(rel, 'empty'); continue; }
    if (row.size > perFileCap(rel)) { skip(rel, 'tooLarge'); continue; }
    const dest = destination(rel);
    const previous = byName.get(dest);
    if (!previous && dest && byFold.has(foldKey(dest))) { skip(rel, 'caseCollision', { existing: byFold.get(foldKey(dest)) }); continue; }
    if (previous && /^[a-f0-9]{64}$/.test(row.sha256) && previous.attachment?.id === row.sha256) { unchanged.push({ path: rel }); continue; }
    if (accepted.length >= caps.maxFiles) { skip(rel, 'fileLimit'); continue; }
    if (bytes + row.size > caps.maxBytes) { skip(rel, 'sizeLimit'); continue; }
    if (!previous) {
      const kind = sourceLimits.kindOf(rel);
      if (room.sources <= 0) { skip(rel, 'projectLimit', { max: project_.sources }); continue; }
      if (kind === 'document' && room.documents <= 0) { skip(rel, 'documentLimit', { max: project_.documents }); continue; }
      // Only an image small enough to be model input (uploads.cjs, 8 MB) takes an image slot.
      if (kind === 'image' && row.size <= 8 * 1024 * 1024 && room.images <= 0) { skip(rel, 'imageLimit', { max: project_.images }); continue; }
      room.sources -= 1;
      if (kind === 'document') room.documents -= 1;
      if (kind === 'image' && row.size <= 8 * 1024 * 1024) room.images -= 1;
    }
    bytes += row.size;
    accepted.push({ path: rel, size: row.size, change: previous ? 'changed' : 'new' });
  }
  const importId = openTicket(userId, { projectId: project.id, paths: new Map(accepted.map((a) => [a.path, a.size])), maxBytes: caps.maxBytes, usedBytes: 0 });
  return { importId, limits: { maxFiles: caps.maxFiles, maxBytes: caps.maxBytes, projectSources: project_.sources, projectDocuments: project_.documents, projectImages: project_.images }, accepted, unchanged, skipped };
}

/**
 * Whether these bytes may be uploaded at this path under this import: null when yes, otherwise
 * { status, code, error }. Refused when the ticket is unknown, expired, another person's or
 * another project's, the plan did not accept the path (or it is done), the body is larger than
 * the size the plan accepted, or it would take the import past its byte cap.
 */
function admit(importId, userId, projectId, rel, size) {
  pruneTickets();
  const t = typeof importId === 'string' ? tickets.get(importId) : null;
  if (!t || t.userId !== userId || t.projectId !== projectId || !t.paths.has(rel)) {
    return { status: 409, code: 'importNotPlanned', error: 'This file is not part of the current folder import, or the import expired. Import the folder again.' };
  }
  if (!(size <= t.paths.get(rel))) return { status: 413, code: 'sizeMismatch', error: 'This file is larger than the folder import declared for it. Import the folder again.' };
  if (t.usedBytes + size > t.maxBytes) return { status: 413, code: 'sizeLimit', error: REASONS.sizeLimit };
  return null;
}

/** Mark one accepted path done, after it was recorded (or found unchanged), and count its bytes
 *  against the import's cap. A failed upload is not consumed, so it can be retried. */
function consume(importId, rel, size = 0) {
  const t = tickets.get(importId);
  if (t && t.paths.delete(rel)) t.usedBytes += size;
}

/**
 * Every file under `root`, breadth-first, through `list(dir)` (one directory level, entries with
 * `{ name, path, isDir }`). Skipped names are not entered. A folder in `exclude` (another attached
 * folder) is left to its own entry, so a file is never synced twice. `onDirError(dir, err)` is
 * told about a subfolder whose listing failed; the walk goes on without it.
 * @returns {Promise<{ files: object[], limited: {path:string, code:'depthLimit'|'folderLimit'}[] }>}
 */
async function listTree(list, root, { exclude = new Set(), onDirError = () => {}, maxDepth = contract.maxDepth, maxFolders = contract.maxFolders, first } = {}) {
  const files = [], limited = [];
  let queue = [{ dir: root, depth: 0, entries: first }], listed = 0;
  while (queue.length) {
    const next = [];
    for (const { dir, depth, entries: given } of queue) {
      let entries = given;
      if (!entries) {
        if (listed >= maxFolders) { limited.push({ path: dir, code: 'folderLimit' }); continue; }
        listed += 1;
        try { entries = await list(dir); }
        catch (err) { if (dir === root) throw err; onDirError(dir, err); continue; }
      } else listed += 1;
      for (const entry of entries) {
        if (skippedName(entry.name)) continue;
        if (!entry.isDir) { files.push(entry); continue; }
        if (exclude.has(entry.path)) continue;
        if (depth + 1 >= maxDepth) { limited.push({ path: entry.path, code: 'depthLimit' }); continue; }
        next.push({ dir: entry.path, depth: depth + 1 });
      }
    }
    queue = next;
  }
  return { files, limited };
}

module.exports = { contract, limits, relativePath, skippedName, skipReason, plan, admit, consume, foldKey, listTree, REASONS, TICKETS_PER_USER, _tickets: tickets };
