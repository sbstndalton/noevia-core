'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const documents = require('./documents.cjs');
const { quoteName } = require('./quoted-name.cjs');
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
function writeOnce(workspace, file, bytes) {
  workspace.assertActive?.();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, bytes, { mode: 0o600 });
  // Content-addressed files are immutable. Atomic rename avoids partially
  // written cache entries when another exchange reads the same version.
  fs.renameSync(temp, file);
}
async function ingest(workspace, projectId, name, bytes, previous) {
  workspace.assertActive?.();
  const byteHash = hash(bytes);
  const version = hash(byteHash + ':' + documents.EXTRACTOR_VERSION);
  const original = versionPath(workspace, projectId, byteHash, '.pdf');
  if (!fs.existsSync(original)) writeOnce(workspace, original, bytes);
  const resultFile = versionPath(workspace, projectId, version, '.json');
  let out;
  try { out = JSON.parse(fs.readFileSync(resultFile, 'utf8')); if (out.retryable) throw new Error('retry OCR'); } catch {
    try { out = await documents.extractDocumentText(name, bytes); }
    catch (err) { out = { text: '', pages: 0, pageTexts: [], state: 'failed', truncated: false, retryable: !!err.retryable, error: err.message }; }
    // #1726: figures (multimodal RAG on, Docling) are stored as their own content-addressed files beside
    // this version's record, which keeps only where they are: <version>.fig<index>.<ext>.
    if (Array.isArray(out.figures)) {
      out = { ...out, figures: out.figures.map((f) => {
        const file = `${version}.fig${f.index}.${f.ext}`;
        const full = versionPath(workspace, projectId, version, `.fig${f.index}.${f.ext}`);
        if (!fs.existsSync(full)) writeOnce(workspace, full, f.bytes);
        return { page: f.page, index: f.index, file, hash: hash(f.bytes), ...(f.caption ? { caption: f.caption } : {}), ...(f.text ? { text: f.text } : {}) };
      }) };
    }
    writeOnce(workspace, resultFile, JSON.stringify(out));
  }
  workspace.assertActive?.();
  const stale = out.state === 'failed' && !!previous?.content;
  const availableVersion = stale ? previous.document?.availableVersion : out.state !== 'failed' ? version : undefined;
  return { name, content: stale ? previous.content : out.text,
    document: { version, byteHash, bytes: bytes.length, extractor: documents.EXTRACTOR_VERSION,
      state: out.state, stale, availableVersion, availableByteHash: stale ? previous.document?.availableByteHash : byteHash, pages: out.pages, truncated: out.truncated,
      pageStatus: out.pageTexts.map(p => ({ number: p.number, status: p.status, ...(p.reason ? { reason: p.reason } : {}) })),
      error: out.error, ...(out.errorId ? { errorId: out.errorId } : {}), indexing: stale || previous?.document?.availableVersion === availableVersion ? previous?.document?.indexing || 'unavailable' : 'pending' } };
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
  const issues = (d.pageStatus || []).filter(p => !['native', 'blank', 'ocr'].includes(p.status));
  return `${d.state}${d.stale ? '; using STALE text from the last readable version' : ''}` +
    `${d.pages ? '; ' + d.pages + ' pages' : ''}${d.truncated ? '; summary/page extraction limits reached' : ''}` +
    `${issues.length ? '; incomplete pages ' + issues.slice(0, 20).map(p => p.number + ' (' + p.status + (p.reason ? ': ' + p.reason : '') + ')').join(', ') + (issues.length > 20 ? '…' : '') : ''}` +
    `${d.error ? '; ' + d.error : ''}.`;
}
function notice(file) {
  const d = file.document;
  if (!d) return '';
  return `${quoteName(file.name)}: ${problem(file)}` +
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
  const text = selected.map(p => `[Page ${p.number}; ${p.status}${p.reason ? ': ' + p.reason : ''}]\n${p.text || '(no native text)'}`).join('\n\n');
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
  // #1726: a kept version's figure files (<version>.fig<n>.<ext>) are kept with it.
  const keptFigure = (name) => /^[a-f0-9]{64}\.fig\d{1,3}\.(png|jpg|webp)$/.test(name) && keep.has(name.slice(0, 64) + '.json');
  for (const name of fs.readdirSync(dir)) if (!keep.has(name) && !keptFigure(name)) fs.rmSync(path.join(dir, name), { force: true });
}
// #1770: whether the stored result for `version` is a transient failure (it is read again next time).
function retryable(workspace, projectId, version) {
  try { return !!JSON.parse(fs.readFileSync(versionPath(workspace, projectId, version, '.json'), 'utf8')).retryable; } catch { return false; }
}
// #1770: a transient failure that says the extraction service itself is down or busy (not this document).
function serviceDown(error) {
  return /busy|unavailable|not configured|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|timed? ?out|timeout|aborted/i.test(String(error || ''));
}
// #1770 review: whether a new extraction is at least as good as the current one.
const STATE_RANK = { failed: 0, partial: 1, ready: 2 };
const readablePages = (d) => (Array.isArray(d?.pageStatus) ? d.pageStatus : []).filter((p) => ['native', 'ocr', 'degraded'].includes(p?.status)).length;
function noWorse(current, next, nextText) {
  if (!String(nextText || '').trim()) return false;
  if ((STATE_RANK[next?.state] ?? 0) < (STATE_RANK[current?.state] ?? 0)) return false;
  return readablePages(next) >= readablePages(current);
}
module.exports = { retryable, serviceDown, noWorse, ingest, failed, notice, readPages, readOriginal, directory, prune, problem };
