'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const documents = require('./documents.cjs');
const sources = require('./document-sources.cjs');
const storage = require('./storage-client.cjs');
const CAP = 25 * 1024 * 1024;
const GROUPS = ['Documents', 'Images', 'Text', 'Other'];
const images = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif' };
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
function classify(name) {
  const ext = path.extname(name).toLowerCase();
  if (/^\.(pdf|docx?|odt|rtf|pptx?|xlsx?|ods|odp|epub)$/.test(ext)) return 'Documents';
  if (/^\.(png|jpe?g|webp|gif|heic|heif|tiff?|bmp|svg|avif)$/.test(ext)) return 'Images';
  return storage.TEXT_EXTENSIONS.has(ext) ? 'Text' : 'Other';
}
function validate(name, bytes) {
  if (!name || name.length > 200 || /[\/\\\x00-\x1f]/.test(name) || name === '.' || name === '..') throw Object.assign(new Error('Use a plain filename of at most 200 characters.'), { status: 400 });
  if (!bytes.length || bytes.length > CAP) throw Object.assign(new Error('Files must be non-empty and no larger than 25 MB.'), { status: bytes.length ? 413 : 400 });
  const ext = path.extname(name).toLowerCase();
  // Office/OpenDocument files are containers internally, but are documents, not archive bundles.
  const packagedDocument = /^\.(docx|xlsx|pptx|odt|ods|odp|epub)$/.test(ext);
  const archiveMagic = bytes.subarray(0, 4).equals(Buffer.from([0x50,0x4b,3,4])) || bytes.subarray(0,2).equals(Buffer.from([0x1f,0x8b])) || /^(Rar!|7z\xbc\xaf|BZh)/.test(bytes.subarray(0,6).toString('latin1')) || bytes.subarray(257,262).toString() === 'ustar';
  if (/\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|cab|iso)$/i.test(name) || (archiveMagic && !packagedDocument)) throw Object.assign(new Error('Archive bundles are not supported. Upload their individual files instead.'), { status: 400 });
}
function directory(workspace, id) { return path.join(workspace.dir, 'project-uploads', hash(String(id))); }
function original(workspace, id, file) {
  if (!/^[a-f0-9]{64}$/.test(file.attachment?.id || '')) throw new Error('Original not available');
  return path.join(directory(workspace, id), file.attachment.id);
}
async function ingest(workspace, project, name, bytes, { connection, source, remotePath, progress = () => {}, storageImpl = storage } = {}) {
  validate(name, bytes);
  const group = classify(name), mime = bytes.length <= 8 * 1024 * 1024 ? images[path.extname(name).toLowerCase()] : undefined;
  const fullName = remotePath || (connection ? `${project.projectFolder}/${group}/${name}` : name);
  const previous = (project.files || []).find(f => f.name === fullName);
  if (!previous && (project.files || []).length >= 60) throw Object.assign(new Error('A project holds at most 60 sources.'), { status: 400 });
  if (mime && !previous && (project.assets || []).length >= 12) throw Object.assign(new Error('A project holds at most 12 vision images.'), { status: 400 });
  if (connection && !remotePath) {
    progress('Saving to Nextcloud / storage');
    await storageImpl.createFolder(connection, `${project.projectFolder}/${group}`);
    await storageImpl.writeFile(connection, fullName, bytes);
  }
  progress('Saving original');
  const id = hash(bytes), dir = directory(workspace, project.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, id + '.' + crypto.randomUUID());
  fs.writeFileSync(temp, bytes, { mode: 0o600 }); fs.renameSync(temp, path.join(dir, id));
  let file = { name: fullName, content: '' };
  let state = 'stored';
  if (documents.isDocument(name)) {
    progress('Extracting PDF text / OCR');
    file = await sources.ingest(workspace, project.id, fullName, bytes, previous);
    state = file.document.state;
  } else if (group === 'Text') {
    const text = new TextDecoder('utf-8', { fatal: true });
    try { file.content = text.decode(bytes).slice(0, 200000); state = bytes.length > 200000 ? 'partial' : 'ready'; } catch { state = 'stored'; }
  } else if (mime) state = 'vision';
  file.attachment = { id, bytes: bytes.length, group, state, ...(group === 'Images' && bytes.length > 8 * 1024 * 1024 ? { reason: 'Original stored; resize below 8 MB for model image input.' } : {}) };
  if (source || connection) file.source = source || project.projectFolder;
  if (mime) {
    const assetId = 'img-' + hash(fullName + ':' + id).slice(0,40);
    fs.mkdirSync(workspace.assetDir(project.id), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(workspace.assetDir(project.id), assetId), bytes, { mode: 0o600 });
    file.attachment.assetId = assetId;
    project.assets = [...(project.assets || []).filter(a => a.sourceName !== fullName), { id: assetId, name, mime, bytes: bytes.length, sourceName: fullName, storagePath: file.source ? fullName : undefined }];
  }
  return file;
}
function prune(workspace, project) {
  const dir = directory(workspace, project.id);
  if (fs.existsSync(dir)) {
    const keep = new Set((project.files || []).map(f => f.attachment?.id).filter(Boolean));
    for (const name of fs.readdirSync(dir)) if (!keep.has(name)) fs.rmSync(path.join(dir, name), { force: true });
  }
  const live = new Set((project.files || []).map(f => f.name));
  project.assets = (project.assets || []).filter(a => !a.sourceName || live.has(a.sourceName));
  if (workspace.assetDir) {
    const assetDir = workspace.assetDir(project.id);
    const keep = new Set(project.assets.map(a => a.id));
    if (fs.existsSync(assetDir)) for (const name of fs.readdirSync(assetDir)) if (!keep.has(name)) fs.rmSync(path.join(assetDir, name), { force: true });
  }
}
module.exports = { CAP, GROUPS, classify, validate, ingest, original, prune };
