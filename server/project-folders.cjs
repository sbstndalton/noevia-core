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
  for (let n = 1; n <= 1000; n++) {
    const folder = `${root}/${name}${n === 1 ? '' : ` (${n})`}`;
    const result = await storage.createFolder(connection, folder);
    if (!result.existed) return folder;
  }
  throw new Error('Too many folders with this project name');
}
module.exports = { projectFolderName, createProjectFolder };
