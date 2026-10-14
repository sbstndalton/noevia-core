// A project's storage folder is keyed by its id, not its name (#1458). The folder is allocated once,
// at the first upload, and its path is then stored on the project (projectFolder) and in every
// source name; renaming the project can therefore never leave a folder that claims a name the
// project no longer has, and nothing in storage has to move. MKCOL still claims each WebDAV
// directory atomically, so a folder left behind by an earlier project is never reused.
// Folders allocated before this change keep their stored, name-based path (no migration; their
// files are never moved).
function projectFolderName(name) {
  return String(name || '').replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ').trim().replace(/^\.+|[.\s]+$/g, '').slice(0, 80).replace(/[.\s]+$/g, '') || 'Untitled project';
}
const crypto = require('node:crypto');
const KEY_MAX = 80, KEY_HASH = 12;
/** The folder key of a project: its id (the name only when there is no id, which a stored project never lacks).
 *  An id that fits in 80 characters keeps exactly the key it always had, so nothing already allocated moves.
 *  A longer one used to be cut at 80, which made two long ids with a common start share one folder (#1653);
 *  it now ends in a hash of the whole id, so the key stays 80 characters and stays unique to it. */
function projectFolderKey(project) {
  const raw = String(project.id || project.name || '');
  const key = projectFolderName(raw);
  const whole = raw.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+|[.\s]+$/g, '');
  if (whole.length <= KEY_MAX) return key;
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, KEY_HASH);
  return `${whole.slice(0, KEY_MAX - KEY_HASH - 1).replace(/[.\s]+$/g, '')}-${digest}`;
}
const allocations = new WeakMap();
function createProjectFolder(storage, connection, root, project) {
  // The workspace holds one project object. Concurrent first uploads must share
  // its allocation instead of creating two folders and losing one attachment.
  if (allocations.has(project)) return allocations.get(project);
  const pending = allocateFolder(storage, connection, root, project).catch(error => {
    allocations.delete(project);
    throw error;
  });
  allocations.set(project, pending);
  return pending;
}
async function allocateFolder(storage, connection, root, project) {
  const name = projectFolderKey(project);
  // S3 has no atomic directory creation. The id is unique, so the prefix is too;
  // adopting a pre-existing prefix could mix unrelated projects' documents.
  // A reservation made before #1653 used the old (truncated) key; a stored path is never recomputed.
  if (connection.kind === 's3') return project.reservedFolder || `${root}/${name}`;
  await storage.createFolder(connection, root);
  // The path reserved when the project was created (reserveProjectFolder). MKCOL still decides:
  // if something else took it meanwhile, fall through to the next free name.
  if (project.reservedFolder) {
    const result = await storage.createFolder(connection, project.reservedFolder);
    if (!result.existed) return project.reservedFolder;
  }
  for (let n = 1; n <= 1000; n++) {
    const folder = `${root}/${name}${n === 1 ? '' : ` (${n})`}`;
    const result = await storage.createFolder(connection, folder);
    if (!result.existed) return folder;
  }
  throw new Error('Too many folders with this project name');
}
// Names the folder a new project will use on its first upload, without creating it (#589): the first
// free "<project id>", "<project id> (2)", ... among the folders this tenant's other projects already hold
// or reserved. The id is unique, so the number is only a guard against a stored path that collides.
function reserveProjectFolder(connection, root, project, others) {
  const name = projectFolderKey(project);
  if (connection.kind === 's3') return `${root}/${name}`;
  const taken = new Set();
  for (const o of others || []) { if (o && o !== project) { if (o.projectFolder) taken.add(o.projectFolder); if (o.reservedFolder) taken.add(o.reservedFolder); } }
  for (let n = 1; n <= 1000; n++) {
    const folder = `${root}/${name}${n === 1 ? '' : ` (${n})`}`;
    if (!taken.has(folder)) return folder;
  }
  return undefined;
}
module.exports = { projectFolderName, projectFolderKey, createProjectFolder, reserveProjectFolder };
