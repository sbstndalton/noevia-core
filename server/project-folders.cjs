// Human-readable names; MKCOL claims each WebDAV directory atomically, so
// concurrent creations and folders left by deleted projects cannot be reused.
function projectFolderName(name) {
  return String(name || '').replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ').trim().replace(/^\.+|[.\s]+$/g, '').slice(0, 80).replace(/[.\s]+$/g, '') || 'Untitled project';
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
  const name = projectFolderName(project.name);
  // S3 has no atomic directory creation. Keep its unique prefix convention;
  // adopting a pre-existing prefix could mix unrelated projects' documents.
  if (connection.kind === 's3') return `${root}/${name}--${project.id}`;
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
// free "Name", "Name (2)", ... among the folders this tenant's other projects already hold or
// reserved. Two same-named projects created before any upload therefore still get distinct paths.
function reserveProjectFolder(connection, root, project, others) {
  const name = projectFolderName(project.name);
  if (connection.kind === 's3') return `${root}/${name}--${project.id}`;
  const taken = new Set();
  for (const o of others || []) { if (o && o !== project) { if (o.projectFolder) taken.add(o.projectFolder); if (o.reservedFolder) taken.add(o.reservedFolder); } }
  for (let n = 1; n <= 1000; n++) {
    const folder = `${root}/${name}${n === 1 ? '' : ` (${n})`}`;
    if (!taken.has(folder)) return folder;
  }
  return undefined;
}
module.exports = { projectFolderName, createProjectFolder, reserveProjectFolder };
