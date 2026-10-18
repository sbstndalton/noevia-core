'use strict';
// How a model names a project file (#642). One resolver for every tool that reads or edits a
// project file by name: the built-in read_project_file, the Project documents box's
// project_read_file / project_append_file / project_replace_text, and the Skill tracking that
// records which instruction skill a read loaded.
//
// The canonical identifier is the file's stored `name`, which is what every listing shows the
// model: the prompt's file excerpts, the Skills index, project_list_files, the "Available:" list
// in an error. For an upload into connected storage that is its storage path
// (`noevia projects/<project>/Text/notes.md`), for a local upload the bare name. The model may
// pass that verbatim, or any trailing part of it that ends on a folder boundary (usually just
// `notes.md`) as long as exactly one file in THIS project matches. Two or more matches is an
// error that lists them, never a guess.
//
// Security: resolution is a lookup in `project.files`, the requesting account's own project as
// the caller already loaded it (attached folders plus the upload folder). It never touches the
// filesystem or storage, so there is nothing to traverse and no symlink to follow, and it cannot
// name a file of another project or tenant because those are not in the list. Names that look
// like an escape attempt (`..` or `.` segments, an absolute or drive path, backslashes, control
// characters, percent-encoded dots/separators) are refused outright rather than matched, so a
// traversal-shaped argument can never succeed by accident of a suffix match either.
//
// The resolver itself is noevia-rs's project-file-names crate (dav-parse.wasm project_file_names),
// always: PROJECT_FILE_NAMES_IMPL was retired in #1071 and the JS resolver deleted. The port is
// sent the project's file names (strings, in order) and the raw argument and answers with an index
// into those names, or a refusal code: invalid (with one of a fixed set of reasons), missing, or
// ambiguous (with the indexes of the matching names, at least two). This module only turns that
// answer into the model-readable message and the original file object; it decides nothing.
// When the port cannot answer (it refuses an input outside its NFC-inert set after the one small
// composition table, noevia#1211, so an NFC-unstable name or file name is not compared; it
// faults; it replies badly; or the input is larger than 8 MiB) nothing resolves: code
// 'unverified' with a model-readable error (logged once per reason, name-free). Before #1071 such
// a case was answered "missing" or "ambiguous" by the JS when the JS found no single file; it is
// now 'unverified' too, never a guess. A missing or tampered module stops startup.

const defaultLoader = () => require('./dav-parse-wasm.cjs');

const warnedPort = new Set();
function portWarn(event, reason) {
  const key = `${event}:${reason}`;
  if (warnedPort.has(key)) return;
  warnedPort.add(key);
  console.warn(`[project-file-names] ${event} (${reason}); the name was not resolved`);
}

/**
 * Resolves a model-supplied file name against one project's files, by the Rust port.
 * Option: `wasmLoader` (tests).
 * @param {{files?: object[]}|null} project  the requesting account's project, as already loaded
 * @param {unknown} raw  the name argument, untrusted
 * @returns {{file?: any, error?: string, code?: 'invalid'|'missing'|'ambiguous'|'unverified', candidates?: string[]}}
 *   `file` (the project's own file object) on success; otherwise `error` (model-readable), `code`,
 *   and `candidates` when ambiguous.
 */
function resolveProjectFile(project, raw, { wasmLoader = defaultLoader } = {}) {
  const files = project && Array.isArray(project.files) ? project.files.filter((f) => f && typeof f.name === 'string') : [];
  const shown = JSON.stringify(typeof raw === 'string' ? raw.slice(0, 200) : String(raw ?? ''));
  let port = null;
  try {
    port = wasmLoader().projectFileNames(files.map((f) => f.name), raw);
  } catch (err) {
    portWarn('project_file_names.wasm_fault', String(err?.reason || 'unexpected').slice(0, 40));
  }
  if (!port) return { code: 'unverified', error: `${shown} could not be confirmed as exactly one project file, so nothing was read or changed. Use a name exactly as listed.` };
  if (port.file !== undefined) return { file: files[port.file] };
  if (port.code === 'invalid') return { code: 'invalid', error: `${shown} is not a usable project file name: ${port.reason}. Use a name exactly as listed.` };
  if (port.code === 'ambiguous') {
    const candidates = port.candidates.map((i) => files[i].name);
    return { code: 'ambiguous', candidates, error: `${shown} matches more than one project file: ${candidates.join(', ')}. Pass the full name exactly as listed.` };
  }
  const names = files.map((f) => f.name).join(', ') || '(none attached)';
  return { code: 'missing', error: `no project file named ${shown}. Available: ${names}` };
}

module.exports = { resolveProjectFile };
