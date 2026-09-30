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
function planEdit(project, raw, { storageAccount: account = null } = {}) {
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

/**
 * For the chat loop: the stored path an edit tool call would change (for a plain-named file in a
 * project with connected storage, the path it is moved to), resolved against the project as it is
 * now. `{ path, account }` (account: the storage account a move is bound to, else null) or `{ error }`.
 */
function resolveEditTarget(project, rawArgs, { storageAccount: account = null } = {}) {
  if (!project) return { error: 'this chat is not in a project, so there are no project files to edit.' };
  let args;
  try { args = JSON.parse(rawArgs || '{}'); } catch { return { error: 'the tool arguments were not valid JSON.' }; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'the tool arguments must be a JSON object.' };
  try { const plan = planEdit(project, args.name, { storageAccount: account }); return { path: plan.target, account: plan.account }; }
  catch (err) { return { error: String((err && err.message) || err) }; }
}

/** What the capability token carries for an approved edit: a fixed-size digest of the path. */
/** A move into the project folder (#687) is also bound to the storage account it was approved for. */
function targetDigest(storedPath, account = null) {
  return crypto.createHash('sha256').update(`noevia-edit-target\0${String(storedPath)}${account ? `\0${account}` : ''}`).digest('hex');
}

module.exports = { EDIT_TOOLS, uploadPathFor, isProjectUpload, planEdit, resolveEditTarget, targetDigest, storageAccount };
