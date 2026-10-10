'use strict';
// Which stored file a project edit tool will change (#648). One answer, shared by the chat loop
// (which shows it on the approval card and pins the call to it) and the Project documents box's
// project_append_file / project_replace_text (which refuse when the file has moved since).
//
// A project file can be edited in place when it is:
//   - a connected upload: an `attachment` record with `source === project.projectFolder`, stored
//     at exactly `<projectFolder>/<group>/<name>` (the path uploads.ingest writes it to), or
//   - a local upload stored under its plain name, or
//   - (#687) a plain-named upload noevia keeps itself (a file added in the Create-project dialog
//     before that dialog stored files in storage, or one uploaded while storage was disconnected)
//     in a project whose storage is connected now. Its edit MOVES it to `<folder>/Text/<name>`,
//     the path every connected upload has: `target` is that path, shown on the approval card and
//     pinned for the call, and the write creates it there (never over an existing file) and drops
//     the plain-named copy. `adopt` marks such a plan.
// Everything else is refused with a reason and nothing is written: files synced from an attached
// folder (the sync loop owns them), path-named files of no known origin, originals with no
// editable text, unreadable sources (#586), extracted documents, and text that was only read in
// part or in another encoding (writing it back as UTF-8 would lose what was not read).
//
// This module only looks names up in the project's own file list (project-file-names.cjs); it
// never touches storage. The write path (projects.writeProjectTextFile) checks again, under the
// source lock, that the destination it would write is this same stored file.
//
// PROJECT_EDIT_TARGET_IMPL=js|wasm (default js; any other value means js, with one warning), read
// from the `env` option (process.env) on every planEdit call. wasm also asks noevia-rs's
// project-edit-target crate (dav-parse.wasm project_edit_target) with a projection of the project
// (its folders, every file's stored name), whether storage is connected, and the resolved file's
// source, attachment state and group, and whether it has a document. The JS plan is computed
// first; a JS refusal is thrown as is, without asking. The edit goes ahead only when the port gives
// the identical plan (writeName, target, adopt). When the port refuses, faults, replies badly or
// plans anything else, or the project cannot be projected (a folder or source that is not a
// string), the edit is refused with a model-readable error and nothing is written (logged once
// per reason, name-free). The flag is in dav-parse-wasm.cjs IMPL_FLAGS (a missing or tampered
// module stops startup).

const crypto = require('node:crypto');
const { resolveProjectFile } = require('./project-file-names.cjs');
const { classify } = require('./uploads.cjs');
const { isUnreadable } = require('./source-readability.cjs');

const EDIT_TOOLS = new Set(['project_append_file', 'project_replace_text']);

/** The storage path an upload named `base` is written to (see uploads.ingest). */
function uploadPathFor(project, base) {
  return project.projectFolder ? `${project.projectFolder}/${classify(base)}/${base}` : base;
}

/** An upload into the project's own storage folder, detected the way ownsFile does. */
const isProjectUpload = (project, file) => !!(project.projectFolder && file.attachment && file.source === project.projectFolder);

/**
 * Which storage account a connection is (#687 review): a digest of its kind, server, bucket and
 * user, never the secret. A move into the project folder is bound to it, so an approval given
 * while one account was connected cannot create the file in another one connected since.
 * `null` for no connection.
 */
function storageAccount(connection) {
  if (!connection || typeof connection !== 'object') return null;
  const where = String(connection.baseUrl || connection.url || '').replace(/\/+$/, '');
  return crypto.createHash('sha256').update(JSON.stringify(['noevia-storage-account', String(connection.kind || ''), where, String(connection.bucket || ''), String(connection.region || ''), String(connection.username || '')])).digest('hex');
}

/**
 * The file an edit named `raw` would change, the plain name to hand the write path, and `target`,
 * the stored path the edit writes (the card shows it). `storageAccount` is the connected storage
 * account (storageAccount() of a browsable connection) or null; it only matters for a plain-named
 * file (see the header), whose plan then carries it as `account`.
 * Throws a model-readable Error when the name does not resolve or the file may not be edited.
 * @returns {{ file: any, writeName: string, target: string, adopt: boolean, account: string|null }}
 */
function planEditJs(project, raw, { storageAccount: account = null } = {}) {
  const found = resolveProjectFile(project, raw);
  if (!found.file) throw new Error(found.error);
  const file = found.file;
  const storageConnected = typeof account === 'string' && !!account;
  let writeName = file.name, target = file.name, adopt = false;
  if (isProjectUpload(project, file)) {
    const base = file.name.slice(file.name.lastIndexOf('/') + 1);
    // Only the exact place uploads.ingest writes to: anything else would be written to that place
    // instead, leaving the listed file untouched and a second copy beside it.
    if (file.name !== uploadPathFor(project, base)) throw new Error(`"${file.name}" is not stored where this project's uploads are kept, so it cannot be edited in place. Nothing was changed.`);
    writeName = base;
  } else {
    if (file.source) throw new Error(`"${file.name}" comes from the attached folder "${file.source}" and is kept in sync from there. Edit it in that folder instead.`);
    if (file.name.includes('/')) throw new Error(`"${file.name}" is stored under a folder path; editing it with tools isn't supported yet. Use project_create_file to write a new file.`);
    if (storageConnected) {
      // Written as it is now, the file would land at the connected-upload path, not its plain name
      // (uploads.destinationFor). So that path is the target, and it is the one the card shows.
      const folder = project.projectFolder || project.reservedFolder;
      if (!folder) throw new Error(`"${file.name}" is kept only in noevia and this project has no storage folder yet, so it cannot be edited in place. Nothing was changed. Add it again from the project's Sources to store it in the project folder.`);
      if (classify(file.name) !== 'Text') throw new Error(`"${file.name}" is not a text file type that can be stored in the project folder, so it cannot be edited in place. Nothing was changed.`);
      target = `${folder}/Text/${file.name}`;
      if ((project.files || []).some((f) => f !== file && f.name === target)) throw new Error(`"${target}" is already a separate file in this project, so "${file.name}" cannot be moved there. Nothing was changed. Edit "${target}" instead.`);
      adopt = true;
    }
  }
  if (file.attachment && file.attachment.state === 'stored') throw new Error(`"${file.name}" is stored in its original format and has no editable text.`);
  if (isUnreadable(file)) throw new Error(`"${file.name}" could not be read when it was added, so it cannot be edited. Nothing was changed.`);
  if (file.document) throw new Error(`"${file.name}" is an extracted document, not an editable text file.`);
  if (file.attachment && (file.attachment.state !== 'ready' || classify(writeName) !== 'Text')) {
    throw new Error(`"${file.name}" was only read in part or in another encoding, so writing it back would lose content. Nothing was changed.`);
  }
  return { file, writeName, target, adopt, account: adopt ? account : null };
}

// ── PROJECT_EDIT_TARGET_IMPL ────────────────────────────────────────────────

const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';
/** PROJECT_EDIT_TARGET_IMPL: 'js' (default) or 'wasm'. */
function projectEditTargetImpl(env = process.env) {
  const raw = env?.PROJECT_EDIT_TARGET_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const value = String(raw).trim().toLowerCase();
  if (IMPLS.has(value)) return value;
  if (warnedImpl !== value) {
    warnedImpl = value;
    console.warn(`[project-edit-target] PROJECT_EDIT_TARGET_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}
const defaultLoader = () => require('./dav-parse-wasm.cjs');

const warnedPort = new Set();
function portWarn(event, reason) {
  const key = `${event}:${reason}`;
  if (warnedPort.has(key)) return;
  warnedPort.add(key);
  console.warn(`[project-edit-target] ${event} (${reason}); the edit was refused`);
}

/** A folder or source the port reads: a string, '' and other falsy values as null; undefined
 *  (not projectable: a truthy non-string) otherwise. */
const projected = (v) => (typeof v === 'string' ? (v || null) : (v ? undefined : null));
const stringOrNull = (v) => (typeof v === 'string' ? v : null);

/**
 * The port's request for `file` (one of project.files) as the JS planned it, or null when the
 * project cannot be projected: `[folder, reserved, connected, index, names, [source, attachment,
 * document]]` (see noevia-rs crates/project-edit-target).
 */
function editTargetInput(project, file, account = null) {
  const files = project && Array.isArray(project.files) ? project.files : null;
  const index = files ? files.indexOf(file) : -1;
  if (index < 0 || typeof file.name !== 'string') return null;
  const folder = projected(project.projectFolder), reserved = projected(project.reservedFolder), source = projected(file.source);
  if (folder === undefined || reserved === undefined || source === undefined) return null;
  const a = file.attachment;
  return [folder, reserved, typeof account === 'string' && !!account, index,
    files.map((f) => (f && typeof f.name === 'string' ? f.name : null)),
    [source, a ? [stringOrNull(a.state), stringOrNull(a.group)] : null, !!file.document]];
}

/**
 * The file an edit named `raw` would change (planEditJs above), confirmed by the Rust port under
 * PROJECT_EDIT_TARGET_IMPL=wasm: the plan stands only when both give the same one. Options:
 * `storageAccount`, `env`, `impl`, `wasmLoader`. Throws a model-readable Error otherwise.
 * @returns {{ file: any, writeName: string, target: string, adopt: boolean, account: string|null }}
 */
function planEdit(project, raw, { storageAccount: account = null, env = process.env, impl = projectEditTargetImpl(env), wasmLoader = defaultLoader } = {}) {
  const plan = planEditJs(project, raw, { storageAccount: account });
  if (impl !== 'wasm') return plan;
  const input = editTargetInput(project, plan.file, account);
  let port = null;
  if (!input) portWarn('project_edit_target.unprojectable', 'shape');
  else {
    try {
      port = wasmLoader().projectEditTarget(input);
    } catch (err) {
      portWarn('project_edit_target.wasm_fault', String(err?.reason || 'unexpected').slice(0, 40));
    }
  }
  const p = port && port.plan;
  if (p && p.write === plan.writeName && p.target === plan.target && p.adopt === plan.adopt) return plan;
  if (port) portWarn('project_edit_target.impl_mismatch', p ? 'plan' : String(port.refused || 'reply').slice(0, 40));
  throw new Error(`"${plan.file.name}" could not be confirmed as a file that can be edited in place, so nothing was changed. Ask again, or use project_create_file to write a new file.`);
}

/**
 * For the chat loop: the stored path an edit tool call would change (for a plain-named file in a
 * project with connected storage, the path it is moved to), resolved against the project as it is
 * now. `{ path, account }` (account: the storage account a move is bound to, else null) or `{ error }`.
 */
function resolveEditTarget(project, rawArgs, { storageAccount: account = null, ...opts } = {}) {
  if (!project) return { error: 'this chat is not in a project, so there are no project files to edit.' };
  let args;
  try { args = JSON.parse(rawArgs || '{}'); } catch { return { error: 'the tool arguments were not valid JSON.' }; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'the tool arguments must be a JSON object.' };
  try { const plan = planEdit(project, args.name, { ...opts, storageAccount: account }); return { path: plan.target, account: plan.account }; }
  catch (err) { return { error: String((err && err.message) || err) }; }
}

/** What the capability token carries for an approved edit: a fixed-size digest of the path. */
/** A move into the project folder (#687) is also bound to the storage account it was approved for. */
function targetDigest(storedPath, account = null) {
  return crypto.createHash('sha256').update(`noevia-edit-target\0${String(storedPath)}${account ? `\0${account}` : ''}`).digest('hex');
}

module.exports = { EDIT_TOOLS, uploadPathFor, isProjectUpload, planEdit, planEditJs, editTargetInput, projectEditTargetImpl, resolveEditTarget, targetDigest, storageAccount };
