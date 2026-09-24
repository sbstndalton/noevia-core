'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const documents = require('./documents.cjs');
const docx = require('./docx.cjs');
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
// A text file is not always UTF-8, and a `.txt` exported from an older editor
// very often is not. This used to be one fatal UTF-8 decode inside a bare
// `catch { state = 'stored' }`: a Latin-1 or UTF-16 file was silently reduced
// to empty content, indistinguishable from an opaque binary, with nothing told
// to the user and nothing logged. That is data loss, not a limitation.
//
// So: honour a BOM, then try UTF-8 strictly, then fall back to windows-1252 —
// which is the usual answer for legacy Western European text and, being a
// total mapping, cannot itself fail. Because it cannot fail, it would happily
// turn a JPEG into mojibake, so binary is ruled out first by the one signal
// that is reliable across encodings: a NUL byte, which no text encoding here
// produces for real content.
//
// Returns null only when the bytes are genuinely not text. A non-UTF-8 read is
// reported as such rather than presented as a clean read.
function decodeText(bytes) {
  const decode = (encoding, from = 0) => new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(from));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    try { return { text: decode('utf-8', 3), encoding: 'utf-8' }; } catch { /* a lying BOM; fall through */ }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    try { return { text: decode('utf-16le', 2), encoding: 'utf-16le' }; } catch { /* fall through */ }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try { return { text: decode('utf-16be', 2), encoding: 'utf-16be' }; } catch { /* fall through */ }
  }
  try { return { text: decode('utf-8'), encoding: 'utf-8' }; } catch { /* not UTF-8; keep going */ }
  // No BOM and not UTF-8. Before guessing an 8-bit encoding, rule out binary.
  if (bytes.includes(0)) return null;
  try { return { text: decode('windows-1252'), encoding: 'windows-1252' }; } catch { return null; }
}

function directory(workspace, id) { return path.join(workspace.dir, 'project-uploads', hash(String(id))); }
function original(workspace, id, file) {
  if (!/^[a-f0-9]{64}$/.test(file.attachment?.id || '')) throw new Error('Original not available');
  return path.join(directory(workspace, id), file.attachment.id);
}
async function ingest(workspace, project, name, bytes, { connection, source, remotePath, progress = () => {}, storageImpl = storage, extractDocx = docx.extract } = {}) {
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
  let state = 'stored', reason, readerVersion;
  if (documents.isDocument(name)) {
    progress('Extracting PDF text / OCR');
    file = await sources.ingest(workspace, project.id, fullName, bytes, previous);
    state = file.document.state;
  } else if (/\.docx$/i.test(name)) {
    progress('Reading DOCX body text and tables');
    if (previous?.attachment?.id === id && previous.attachment.readerVersion === docx.VERSION && previous.content) {
      file.content = previous.content; state = previous.attachment.state;
      reason = previous.attachment.reason; readerVersion = docx.VERSION;
    } else try {
      const result = await extractDocx(bytes);
      if (!result.text.trim()) throw Error('No body text was recovered from this DOCX. The original is kept.');
      reason = 'DOCX body text and tables only; layout, images, headers, footers, comments and footnotes are not interpreted.';
      file.content = (`[${reason}]\n\n` + result.text).slice(0,200000);
      state = 'partial'; readerVersion = docx.VERSION;
      if (result.truncated || result.text.length + reason.length + 4 > 200000) reason += ' Text extraction limit reached.';
    } catch (err) { reason = String(err.message || 'DOCX reader unavailable').slice(0,300); }
  } else if (group === 'Text') {
    const decoded = decodeText(bytes);
    if (decoded) {
      file.content = decoded.text.slice(0, 200000);
      state = bytes.length > 200000 ? 'partial' : decoded.encoding === 'utf-8' ? 'ready' : 'partial';
      if (decoded.encoding !== 'utf-8') reason = `Not valid UTF-8; read as ${decoded.encoding}. Characters outside that encoding may be wrong — re-save the file as UTF-8 if anything looks mangled.`;
    } else {
      state = 'stored';
      reason = 'This file is not readable as text — it looks like binary data despite its extension. The original is kept.';
    }
  } else if (mime) state = 'vision';
  file.attachment = { id, bytes: bytes.length, group, state, ...(reason ? {reason} : {}), ...(readerVersion ? {readerVersion} : {}), ...(group === 'Images' && bytes.length > 8 * 1024 * 1024 ? { reason: 'Original stored; resize below 8 MB for model image input.' } : {}) };
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
module.exports = { CAP, GROUPS, directory, classify, validate, ingest, original, prune };
