'use strict';
// Which stored file a project edit tool will change (#648). One answer, shared by the chat loop
// (which shows it on the approval card and pins the call to it) and the Project documents box's
// project_append_file / project_replace_text (which refuse when the file has moved since).
//
// A project file can be edited in place when it is:
//   - a connected upload: an `attachment` record with `source === project.projectFolder`, stored
//     at exactly `<projectFolder>/<group>/<name>` (the path uploads.ingest writes it to), or
//   - a local upload stored under its plain name.
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
 * The file an edit named `raw` would change, and the plain name to hand the write path.
 * Throws a model-readable Error when the name does not resolve or the file may not be edited.
 * @returns {{ file: any, writeName: string }}
 */
function planEdit(project, raw) {
  const found = resolveProjectFile(project, raw);
  if (!found.file) throw new Error(found.error);
  const file = found.file;
  let writeName = file.name;
  if (isProjectUpload(project, file)) {
    const base = file.name.slice(file.name.lastIndexOf('/') + 1);
    // Only the exact place uploads.ingest writes to: anything else would be written to that place
    // instead, leaving the listed file untouched and a second copy beside it.
    if (file.name !== uploadPathFor(project, base)) throw new Error(`"${file.name}" is not stored where this project's uploads are kept, so it cannot be edited in place. Nothing was changed.`);
    writeName = base;
  } else {
    if (file.source) throw new Error(`"${file.name}" comes from the attached folder "${file.source}" and is kept in sync from there. Edit it in that folder instead.`);
    if (file.name.includes('/')) throw new Error(`"${file.name}" is stored under a folder path; editing it with tools isn't supported yet. Use project_create_file to write a new file.`);
  }
  if (file.attachment && file.attachment.state === 'stored') throw new Error(`"${file.name}" is stored in its original format and has no editable text.`);
  if (isUnreadable(file)) throw new Error(`"${file.name}" could not be read when it was added, so it cannot be edited. Nothing was changed.`);
  if (file.document) throw new Error(`"${file.name}" is an extracted document, not an editable text file.`);
  if (file.attachment && (file.attachment.state !== 'ready' || classify(writeName) !== 'Text')) {
    throw new Error(`"${file.name}" was only read in part or in another encoding, so writing it back would lose content. Nothing was changed.`);
  }
  return { file, writeName };
}

/**
 * For the chat loop: the stored path an edit tool call would change, resolved against the
 * project as it is now. `{ path }` or `{ error }`.
 */
function resolveEditTarget(project, rawArgs) {
  if (!project) return { error: 'this chat is not in a project, so there are no project files to edit.' };
  let args;
  try { args = JSON.parse(rawArgs || '{}'); } catch { return { error: 'the tool arguments were not valid JSON.' }; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'the tool arguments must be a JSON object.' };
  try { return { path: planEdit(project, args.name).file.name }; }
  catch (err) { return { error: String((err && err.message) || err) }; }
}

/** What the capability token carries for an approved edit: a fixed-size digest of the path. */
function targetDigest(storedPath) {
  return crypto.createHash('sha256').update(`noevia-edit-target\0${String(storedPath)}`).digest('hex');
}

module.exports = { EDIT_TOOLS, uploadPathFor, isProjectUpload, planEdit, resolveEditTarget, targetDigest };
