'use strict';
// #659: a project that holds uploaded files gets its Project documents toolbox, once.
//
// New projects start with `core` only (least privilege). Without the Project documents box, an
// edit request about an uploaded file had no project tool to go to, so an account with Google
// Drive connected got drive_update_file instead: a whole-file overwrite with no path on its
// card. The box is what edits a project's uploads in place, conditionally, and names the file on
// the approval card (#648), so a project that has uploads should have it.
//
// Why here, and stored, rather than computed at chat time or folded into Core:
//  - The project's `toolboxes` list is what the composer and the model popup show as ticked. A
//    box added only inside the chat loop would be sent while showing unticked.
//  - It is added only at the moment uploads FIRST appear in the project (the caller passes
//    whether it had any before the change), and a marker records that. So a project that already
//    had uploads before this existed (possibly with the box deliberately unticked) is never
//    changed by a later upload or sync, and unticking it afterwards is never overridden.
//  - noevia's internal projects are left alone: the Diary's extras project (its tools are chosen
//    per Diary session) and the hidden per-chat attachments project of a free chat
//    (`cowork-chat-context-*`). Files attached to a free chat are reference material for that
//    one conversation; its edit tools stay opt-in there ("Tools for this chat").
//  - A project without uploads (only attached folders, or nothing) keeps exactly what it had.
//    An empty toolbox list is a deliberate "no tools" and is left alone. Core stays the same
//    for every chat, and the box is only added where the server offers it (the internal MCP
//    server is configured), so nothing appears that could not run.
//  - Every write in the box still stops at the approval card, with all three actions.
const BOX = 'project-docs';

/** An upload: a file the project owns itself (a local upload, or one in its own upload folder),
 *  not one read from a folder the user attached. The same files the box can edit (#648). */
function hasUploads(project) {
  return (Array.isArray(project && project.files) ? project.files : [])
    .some((f) => f && (!f.source || (project.projectFolder && f.source === project.projectFolder)));
}

/** noevia's own hidden projects: the Diary extras project and a free chat's attachments. */
function internalProject(project) {
  const id = String((project && project.id) || '');
  return id === 'cowork-diary-extras' || id.startsWith('cowork-chat-context-');
}

/**
 * Adds the Project documents box to `project.toolboxes` when uploads first appear in it.
 * Mutates the project; the caller saves it. Returns true when the project changed.
 * @param {object} project                 the project AFTER the change
 * @param {{ offered: (id: string) => boolean, defaults: string[], hadUploads: boolean }} options
 *   `hadUploads`: hasUploads(project) BEFORE the change. Required: when it is true (or missing),
 *   nothing is added.
 */
function applyProjectDocsDefault(project, { offered, defaults, hadUploads }) {
  if (hadUploads !== false) return false; // only the transition from no uploads to some
  if (!project || internalProject(project) || project.docsToolboxDefaulted === true || !hasUploads(project)) return false;
  if (!offered(BOX)) return false; // not offered on this server: decide again once it is
  const current = Array.isArray(project.toolboxes) ? project.toolboxes : [...defaults];
  if (!current.length) return false; // "no tools" was chosen on purpose
  project.docsToolboxDefaulted = true;
  if (!current.includes(BOX)) project.toolboxes = [...current, BOX];
  return true;
}

module.exports = { applyProjectDocsDefault, hasUploads, internalProject, BOX };
