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
// PROJECT_FILE_NAMES_IMPL=js|wasm (default js; any other value means js, with one warning), read from
// the `env` option (process.env) on every call of resolveProjectFile. wasm also asks noevia-rs's
// project-file-names crate (dav-parse.wasm project_file_names) with the project's file names and the
// raw argument. The JS answer is computed first; a name resolves only when the port resolves it to
// the same file. A JS refusal (invalid, missing, ambiguous) is returned as is, without asking. When
// the port refuses, faults, replies badly or names another file, nothing resolves: code
// 'unverified' with a model-readable error (logged once per reason, name-free). The port reads no
// normalization tables: a name, or a file name it is compared with, outside its NFC-inert set
// (see the crate docs) is refused, so such names do not resolve under wasm. The flag is in
// dav-parse-wasm.cjs IMPL_FLAGS (a missing or tampered module stops startup).

const MAX_NAME = 1024;

/** Why `raw` is not an acceptable file name, or '' when it is. */
function invalidReason(raw) {
  if (typeof raw !== 'string') return 'a file name is required';
  const name = raw.trim();
  if (!name) return 'a file name is required';
  if (name.length > MAX_NAME) return 'that file name is too long';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return 'a file name cannot contain control characters';
  if (name.includes('\\')) return 'a file name cannot contain backslashes';
  if (/%(?:2e|2f|5c|00)/i.test(name)) return 'a file name cannot contain encoded dots or separators';
  if (name.startsWith('/') || /^[A-Za-z]:\//.test(name)) return 'a file name cannot be an absolute path';
  if (name.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return 'a file name cannot contain empty, "." or ".." parts';
  return '';
}

const norm = (s) => String(s).normalize('NFC');

/**
 * Resolves a model-supplied file name against one project's files.
 * @param {{files?: object[]}|null} project  the requesting account's project, as already loaded
 * @param {unknown} raw  the name argument, untrusted
 * @returns {{file?: any, error?: string, code?: 'invalid'|'missing'|'ambiguous', candidates?: string[]}}
 *   `file` on success; otherwise `error` (model-readable), `code`, and `candidates` when ambiguous.
 */
function resolveProjectFileJs(project, raw) {
  const files = project && Array.isArray(project.files) ? project.files.filter((f) => f && typeof f.name === 'string') : [];
  const reason = invalidReason(raw);
  const shown = JSON.stringify(typeof raw === 'string' ? raw.slice(0, 200) : String(raw ?? ''));
  if (reason) return { code: 'invalid', error: `${shown} is not a usable project file name: ${reason}. Use a name exactly as listed.` };
  const wanted = norm(/** @type {string} */ (raw).trim());
  const exact = files.find((f) => norm(f.name) === wanted);
  if (exact) return { file: exact };
  const matches = files.filter((f) => norm(f.name).endsWith('/' + wanted));
  if (matches.length === 1) return { file: matches[0] };
  if (matches.length > 1) {
    const candidates = matches.map((f) => f.name);
    return { code: 'ambiguous', candidates, error: `${shown} matches more than one project file: ${candidates.join(', ')}. Pass the full name exactly as listed.` };
  }
  const names = files.map((f) => f.name).join(', ') || '(none attached)';
  return { code: 'missing', error: `no project file named ${shown}. Available: ${names}` };
}

// ── PROJECT_FILE_NAMES_IMPL ─────────────────────────────────────────────────

const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';
/** PROJECT_FILE_NAMES_IMPL: 'js' (default) or 'wasm'. */
function projectFileNamesImpl(env = process.env) {
  const raw = env?.PROJECT_FILE_NAMES_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const value = String(raw).trim().toLowerCase();
  if (IMPLS.has(value)) return value;
  if (warnedImpl !== value) {
    warnedImpl = value;
    console.warn(`[project-file-names] PROJECT_FILE_NAMES_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}
const defaultLoader = () => require('./dav-parse-wasm.cjs');
const implOf = ({ env = process.env, impl = projectFileNamesImpl(env) } = {}) => impl;

const warnedPort = new Set();
function portWarn(event, reason) {
  const key = `${event}:${reason}`;
  if (warnedPort.has(key)) return;
  warnedPort.add(key);
  console.warn(`[project-file-names] ${event} (${reason}); the name was not resolved`);
}

/**
 * resolveProjectFileJs (above), confirmed by the Rust port under PROJECT_FILE_NAMES_IMPL=wasm: a
 * name resolves only when both resolve it to the same file. Options: `env`, `impl`, `wasmLoader`.
 * @returns {{file?: any, error?: string, code?: 'invalid'|'missing'|'ambiguous'|'unverified', candidates?: string[]}}
 */
function resolveProjectFile(project, raw, { wasmLoader = defaultLoader, ...opts } = {}) {
  const js = resolveProjectFileJs(project, raw);
  if (!js.file || implOf(opts) !== 'wasm') return js;
  const files = project.files.filter((f) => f && typeof f.name === 'string');
  let port = null;
  try {
    port = wasmLoader().projectFileNames(files.map((f) => f.name), raw);
  } catch (err) {
    portWarn('project_file_names.wasm_fault', String(err?.reason || 'unexpected').slice(0, 40));
  }
  if (port && port.file === files.indexOf(js.file)) return js;
  if (port) portWarn('project_file_names.impl_mismatch', port.code || 'file');
  const shown = JSON.stringify(/** @type {string} */ (raw).slice(0, 200));
  return { code: 'unverified', error: `${shown} could not be confirmed as exactly one project file, so nothing was read or changed. Use a name exactly as listed.` };
}

module.exports = { resolveProjectFile, resolveProjectFileJs, invalidReason, projectFileNamesImpl, MAX_NAME };
