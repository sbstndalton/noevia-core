'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const documents = require('./documents.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

// No shared cache: all bytes and derived versions live under the caller's
// authenticated workspace and hashed project ID. Filenames never become paths.
function directory(workspace, projectId) {
  return path.join(workspace.dir, 'project-documents', hash(String(projectId)));
}
function versionPath(workspace, projectId, version, ext) {
  if (!/^[a-f0-9]{64}$/.test(version || '')) throw new Error('invalid document version');
  return path.join(directory(workspace, projectId), version + ext);
}
function writeOnce(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, bytes, { mode: 0o600 });
  // Content-addressed files are immutable. Atomic rename avoids partially
  // written cache entries when another exchange reads the same version.
  fs.renameSync(temp, file);
}
async function ingest(workspace, projectId, name, bytes, previous) {
  const byteHash = hash(bytes);
  const version = hash(byteHash + ':' + documents.EXTRACTOR_VERSION);
  const original = versionPath(workspace, projectId, byteHash, '.pdf');
  if (!fs.existsSync(original)) writeOnce(original, bytes);
  const resultFile = versionPath(workspace, projectId, version, '.json');
  let out;
  try { out = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {
    try { out = await documents.extractDocumentText(name, bytes); }
    catch (err) { out = { text: '', pages: 0, pageTexts: [], state: 'failed', truncated: false, error: err.message }; }
    writeOnce(resultFile, JSON.stringify(out));
  }
  const stale = out.state === 'failed' && !!previous?.content;
  const availableVersion = stale ? previous.document?.availableVersion : out.state !== 'failed' ? version : undefined;
  return { name, content: stale ? previous.content : out.text,
    document: { version, byteHash, bytes: bytes.length, extractor: documents.EXTRACTOR_VERSION,
      state: out.state, stale, availableVersion, availableByteHash: stale ? previous.document?.availableByteHash : byteHash, pages: out.pages, truncated: out.truncated,
      pageStatus: out.pageTexts.map(p => ({ number: p.number, status: p.status })),
      error: out.error, indexing: stale || previous?.document?.availableVersion === availableVersion ? previous?.document?.indexing || 'unavailable' : 'pending' } };
}
function failed(previous, name, reason) {
  return { ...previous, name, content: previous?.content || '', document: {
    ...previous?.document, state: 'failed', stale: !!previous?.content, error: reason,
    indexing: previous?.document?.indexing || 'unavailable',
  } };
}
function problem(file) {
  const d = file.document;
  if (!d) return '';
  const issues = (d.pageStatus || []).filter(p => !['native', 'blank'].includes(p.status));
  return `${d.state}${d.stale ? '; using STALE text from the last readable version' : ''}` +
    `${d.pages ? '; ' + d.pages + ' pages' : ''}${d.truncated ? '; summary/page extraction limits reached' : ''}` +
    `${issues.length ? '; incomplete pages ' + issues.slice(0, 20).map(p => p.number + ' (' + p.status + ')').join(', ') + (issues.length > 20 ? '…' : '') : ''}` +
    `${d.error ? '; ' + d.error : ''}.`;
}
function notice(file) {
  const d = file.document;
  if (!d) return '';
  return `${file.name}: ${problem(file)}` +
    `${d.version ? ' Source version ' + d.version : ''}${d.availableVersion ? '; text version ' + d.availableVersion : ''}` +
    `; index: ${d.indexing || 'unavailable'}.`;
}

function readPages(workspace, projectId, file, start = 1, end = start, offset = 0, cap = 8000) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start >= 5 || !Number.isInteger(offset) || offset < 0) {
    throw Object.assign(new Error('Choose 1–5 pages (startPage/endPage) and a non-negative character offset.'), { status: 400 });
  }
  const version = file.document?.availableVersion;
  if (!version) throw Object.assign(new Error('No saved readable pages; re-upload or refresh this PDF.'), { status: 422 });
  const out = JSON.parse(fs.readFileSync(versionPath(workspace, projectId, version, '.json'), 'utf8'));
  if (end > out.pages) throw Object.assign(new Error('Page range exceeds the document.'), { status: 400 });
  const selected = out.pageTexts.filter(p => p.number >= start && p.number <= end);
  if (selected.length !== end - start + 1) throw Object.assign(new Error('Requested pages were not extracted because of a processing limit.'), { status: 422 });
  const text = selected.map(p => `[Page ${p.number}; ${p.status}]\n${p.text || '(no native text)'}`).join('\n\n');
  return { text: text.slice(offset, offset + cap), nextOffset: offset + cap < text.length ? offset + cap : null, notice: notice(file), startPage: start, endPage: end };
}
function readOriginal(workspace, projectId, file) {
  return fs.readFileSync(versionPath(workspace, projectId, file.document?.byteHash, '.pdf'));
}
// Called only when this project's source operations are idle. Retain current
// bytes plus the last readable version for stale fallbacks, not unlimited history.
function prune(workspace, project) {
  const dir = directory(workspace, project.id);
  if (!fs.existsSync(dir)) return;
  const keep = new Set();
  for (const file of project.files || []) {
    const d = file.document;
    if (!d) continue;
    for (const key of [d.version, d.availableVersion]) if (key) keep.add(key + '.json');
    for (const key of [d.byteHash, d.availableByteHash]) if (key) keep.add(key + '.pdf');
  }
  for (const name of fs.readdirSync(dir)) if (!keep.has(name)) fs.rmSync(path.join(dir, name), { force: true });
}
module.exports = { ingest, failed, notice, readPages, readOriginal, directory, prune, problem };
