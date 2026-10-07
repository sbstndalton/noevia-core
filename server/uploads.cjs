'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const documents = require('./documents.cjs');
const docx = require('./docx.cjs');
const sources = require('./document-sources.cjs');
const storage = require('./storage-client.cjs');
const uploadSniff = require('./upload-sniff.cjs');
const { CAP, classify, validate, decodeText } = uploadSniff;
const GROUPS = ['Documents', 'Images', 'Text', 'Other'];
const images = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif' };
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
function directory(workspace, id) { return path.join(workspace.dir, 'project-uploads', hash(String(id))); }
function original(workspace, id, file) {
  if (!/^[a-f0-9]{64}$/.test(file.attachment?.id || '')) throw new Error('Original not available');
  return path.join(directory(workspace, id), file.attachment.id);
}
/** The name ingest stores an upload under: its storage path with a connection, else the plain name.
 *  Exported so an in-place edit can check, before writing, that this is the file it means (#648). */
function destinationFor(project, name, { connection, remotePath } = {}) {
  return remotePath || (connection ? `${project.projectFolder}/${classify(name)}/${name}` : name);
}
async function ingest(workspace, project, name, bytes, { connection, source, remotePath, progress = () => {}, storageImpl = storage, extractDocx = docx.extract, ifMatch, ifNoneMatch } = {}) {
  workspace.assertActive?.();
  validate(name, bytes);
  const group = classify(name), mime = bytes.length <= 8 * 1024 * 1024 ? images[path.extname(name).toLowerCase()] : undefined;
  const fullName = destinationFor(project, name, { connection, remotePath });
  const previous = (project.files || []).find(f => f.name === fullName);
  if (!previous && (project.files || []).length >= 60) throw Object.assign(new Error('A project holds at most 60 sources.'), { status: 400 });
  if (mime && !previous && (project.assets || []).length >= 12) throw Object.assign(new Error('A project holds at most 12 vision images.'), { status: 400 });
  if (connection && !remotePath) {
    progress('Saving to Nextcloud / storage');
    await storageImpl.createFolder(connection, `${project.projectFolder}/${group}`);
    workspace.assertActive?.();
    await (ifMatch !== undefined ? storageImpl.writeFile(connection, fullName, bytes, { ifMatch })
      : ifNoneMatch !== undefined ? storageImpl.writeFile(connection, fullName, bytes, { ifNoneMatch })
      : storageImpl.writeFile(connection, fullName, bytes));
  }
  workspace.assertActive?.();
  progress('Saving original');
  const id = hash(bytes), dir = directory(workspace, project.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, id + '.' + crypto.randomUUID());
  fs.writeFileSync(temp, bytes, { mode: 0o600 }); fs.renameSync(temp, path.join(dir, id));
  let file = { name: fullName, content: '' };
  let state = 'stored', reason, reasonId, reasonParams, readerVersion;
  if (documents.isDocument(name)) {
    progress('Extracting PDF text / OCR');
    file = await sources.ingest(workspace, project.id, fullName, bytes, previous);
    state = file.document.state;
  } else if (/\.docx$/i.test(name)) {
    progress('Reading DOCX body text and tables');
    if (previous?.attachment?.id === id && previous.attachment.readerVersion === docx.VERSION && previous.content) {
      file.content = previous.content; state = previous.attachment.state;
      reason = previous.attachment.reason; reasonId = previous.attachment.reasonId; readerVersion = docx.VERSION;
    } else try {
      const result = await extractDocx(bytes);
      if (!result.text.trim()) throw Object.assign(Error('No body text was recovered from this DOCX. The original is kept.'), { reasonId: 'docxEmpty' });
      reasonId = 'docxPartial';
      reason = 'DOCX body text and tables only; layout, images, headers, footers, comments and footnotes are not interpreted.';
      file.content = (`[${reason}]\n\n` + result.text).slice(0,200000);
      state = 'partial'; readerVersion = docx.VERSION;
      if (result.truncated || result.text.length + reason.length + 4 > 200000) { reason += ' Text extraction limit reached.'; reasonId = 'docxPartialLimit'; }
    } catch (err) { reason = String(err.message || 'DOCX reader unavailable').slice(0,300); reasonId = err.reasonId; }
  } else if (group === 'Text') {
    const decoded = decodeText(bytes);
    if (decoded) {
      file.content = decoded.text.slice(0, 200000);
      state = bytes.length > 200000 ? 'partial' : decoded.encoding === 'utf-8' ? 'ready' : 'partial';
      if (decoded.encoding !== 'utf-8') { reasonId = 'encoding'; reasonParams = { encoding: decoded.encoding }; }
      if (decoded.encoding !== 'utf-8') reason = `Not valid UTF-8; read as ${decoded.encoding}. Characters outside that encoding may be wrong — re-save the file as UTF-8 if anything looks mangled.`;
    } else {
      state = 'stored';
      reasonId = 'binaryText';
      reason = 'This file is not readable as text — it looks like binary data despite its extension. The original is kept.';
    }
  } else if (mime) state = 'vision';
  workspace.assertActive?.();
  file.attachment = { id, bytes: bytes.length, group, state, ...(reason ? {reason} : {}), ...(reasonId ? {reasonId} : {}), ...(reasonParams ? {reasonParams} : {}), ...(readerVersion ? {readerVersion} : {}), ...(group === 'Images' && bytes.length > 8 * 1024 * 1024 ? { reason: 'Original stored; resize below 8 MB for model image input.', reasonId: 'imageTooLarge', reasonParams: undefined } : {}) };
  if (source || connection) file.source = source || project.projectFolder;
  // Replacing a vision image with a stored-only original must also retire its
  // old model input. Otherwise chat silently describes the previous bytes.
  // The replaced asset is retired, not forgotten: prune() keeps its bytes while a chat still
  // references its id (#218).
  retire(project, (project.assets || []).filter(a => a.sourceName === fullName));
  project.assets = (project.assets || []).filter(a => a.sourceName !== fullName);
  if (mime) {
    const assetId = 'img-' + hash(fullName + ':' + id).slice(0,40);
    fs.mkdirSync(workspace.assetDir(project.id), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(workspace.assetDir(project.id), assetId), bytes, { mode: 0o600 });
    file.attachment.assetId = assetId;
    project.assets.push({ id: assetId, name, mime, bytes: bytes.length, sourceName: fullName, storagePath: file.source ? fullName : undefined });
  }
  return file;
}
// Image assets that left project.assets (replaced or their source removed). They are no longer
// model input, but a chat transcript may still name one; such an asset keeps its bytes and stays
// readable until no chat of the project mentions it (#218).
function retire(project, assets) {
  if (!assets.length) return;
  const known = new Set((project.retiredAssets || []).map(a => a.id));
  project.retiredAssets = [...(project.retiredAssets || []), ...assets.filter(a => a && a.id && !known.has(a.id)).map(a => ({ ...a, retiredAt: Date.now() }))];
}
// Asset ids named anywhere in this project's chat transcripts. Only called when an image is
// about to be deleted, and reads each transcript once.
function referencedAssets(workspace, project, candidates) {
  const found = new Set();
  if (!candidates.length || typeof workspace.historyPath !== 'function') return found;
  for (const chat of project.chats || []) {
    const chatId = chat && typeof chat === 'object' ? chat.id : chat;
    if (typeof chatId !== 'string' || !chatId) continue;
    let text;
    try { text = fs.readFileSync(workspace.historyPath(chatId), 'utf8'); } catch { continue; }
    for (const id of candidates) if (!found.has(id) && text.includes(id)) found.add(id);
    if (found.size === candidates.length) break;
  }
  return found;
}
function prune(workspace, project) {
  const dir = directory(workspace, project.id);
  if (fs.existsSync(dir)) {
    const keep = new Set((project.files || []).map(f => f.attachment?.id).filter(Boolean));
    for (const name of fs.readdirSync(dir)) if (!keep.has(name)) fs.rmSync(path.join(dir, name), { force: true });
  }
  const live = new Set((project.files || []).map(f => f.name));
  retire(project, (project.assets || []).filter(a => a.sourceName && !live.has(a.sourceName)));
  project.assets = (project.assets || []).filter(a => !a.sourceName || live.has(a.sourceName));
  if (workspace.assetDir) {
    const assetDir = workspace.assetDir(project.id);
    const current = new Set(project.assets.map(a => a.id));
    const names = fs.existsSync(assetDir) ? fs.readdirSync(assetDir).filter(n => !current.has(n)) : [];
    const referenced = referencedAssets(workspace, project, names);
    project.retiredAssets = (project.retiredAssets || []).filter(a => referenced.has(a.id));
    if (!project.retiredAssets.length) delete project.retiredAssets;
    for (const name of names) if (!referenced.has(name)) fs.rmSync(path.join(assetDir, name), { force: true });
  } else delete project.retiredAssets;
}
module.exports = { CAP, GROUPS, directory, classify, validate, destinationFor, ingest, original, prune };
