'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const documents = require('./documents.cjs');
const largeDocuments = require('./large-document-lock.cjs');
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
  // Atomic rename avoids partially written cache entries when another exchange reads the same version.
  // #1871: a result record is also rewritten in place now (the completion pass), so it is made durable
  // before it replaces the old one: the temp file is fsynced, renamed over, and the directory fsynced. A
  // crash leaves the old record or the new one, never a torn one. Writers of one project's records are
  // already serialised by the project's source lock (projects.cjs withSourceLock).
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  try { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch { /* a platform without directory fsync */ }
}
// #1871: `ocrBudget` (documents.ocrBudget) is the OCR retry allowance of the sync this read belongs to.
// #1885 follow-up: `onOutcome(kind)` (optional) is told what this read came to, content-free, for the
// sync's log line: 'extracted' (a new extraction), 'reopened' (a stored result completed or reopened),
// or 'unchanged' (the stored result reused as it was).
async function ingest(workspace, projectId, name, bytes, previous, { ocrBudget, onOutcome } = {}) {
  const outcome = (kind) => { try { onOutcome?.(kind); } catch { /* a log counter never fails a read */ } };
  workspace.assertActive?.();
  const byteHash = hash(bytes);
  const version = hash(byteHash + ':' + documents.EXTRACTOR_VERSION);
  const original = versionPath(workspace, projectId, byteHash, '.pdf');
  if (!fs.existsSync(original)) writeOnce(workspace, original, bytes);
  const resultFile = versionPath(workspace, projectId, version, '.json');
  let out, cached = null;
  try { cached = JSON.parse(fs.readFileSync(resultFile, 'utf8')); if (cached.retryable) cached = null; } catch { cached = null; }
  // #1726: figures (multimodal RAG on, Docling) are stored as their own content-addressed files beside
  // this version's record, which keeps only where they are: <version>.fig<index>.<ext>. A figure that is
  // already stored (a record being completed, below) is kept as it is.
  const storeFigures = (result) => (!Array.isArray(result.figures) ? result : { ...result, figures: result.figures.map((f) => {
    if (!f.bytes) return f;
    const file = `${version}.fig${f.index}.${f.ext}`;
    const full = versionPath(workspace, projectId, version, `.fig${f.index}.${f.ext}`);
    if (!fs.existsSync(full)) writeOnce(workspace, full, f.bytes);
    return { page: f.page, index: f.index, file, hash: hash(f.bytes), ...(f.caption ? { caption: f.caption } : {}), ...(f.text ? { text: f.text } : {}) };
  }) });
  if (cached) {
    out = cached;
    // #1864/#1865: a record stored before the completion pass existed (or one that stopped for a passing
    // reason) gets it now, once: the pages past the old 300-page window and an OCR retry of its incomplete
    // pages. Only such records do anything here; the rest come back with the marker and nothing else.
    // #1867: and a completed record whose OCR was refused only for the file's size, when the worker may
    // now take it (completeDocument asks the worker and returns the record unchanged when it still cannot).
    if (out.completion !== documents.COMPLETION || documents.reopenable(out)) {
      try {
        const completed = await documents.completeDocument(name, bytes, out, ocrBudget ? { ocrBudget } : undefined);
        if (completed !== out) { out = storeFigures(completed); writeOnce(workspace, resultFile, JSON.stringify(out)); outcome('reopened'); }
        else outcome('unchanged');
      } catch (err) { outcome('unchanged'); console.warn('[documents] completing a stored result failed:', String(err?.message || err).slice(0, 200)); }
    } else outcome('unchanged');
  } else {
    outcome('extracted');
    try { out = ocrBudget ? await documents.extractDocumentText(name, bytes, { ocrBudget }) : await documents.extractDocumentText(name, bytes); }
    catch (err) { out = { text: '', pages: 0, pageTexts: [], state: 'failed', truncated: false, retryable: !!err.retryable, error: err.message }; }
    out = storeFigures(out);
    writeOnce(workspace, resultFile, JSON.stringify(out));
  }
  workspace.assertActive?.();
  const stale = out.state === 'failed' && !!previous?.content;
  const availableVersion = stale ? previous.document?.availableVersion : out.state !== 'failed' ? version : undefined;
  return { name, content: stale ? previous.content : out.text,
    document: { version, byteHash, bytes: bytes.length, extractor: documents.EXTRACTOR_VERSION,
      state: out.state, stale, availableVersion, availableByteHash: stale ? previous.document?.availableByteHash : byteHash, pages: out.pages, truncated: out.truncated,
      pageStatus: out.pageTexts.map(p => ({ number: p.number, status: p.status, ...(p.reason ? { reason: p.reason } : {}), ...(p.retry ? { retry: retryRecord(p.retry) } : {}) })),
      ...(out.stoppedAt ? { stoppedAt: stoppedRecord(out.stoppedAt) } : {}),
      error: out.error, ...(out.errorId ? { errorId: out.errorId } : {}), indexing: stale || previous?.document?.availableVersion === availableVersion ? previous?.document?.indexing || 'unavailable' : 'pending' } };
}
/**
 * #1885 follow-up: a sync whose storage read of a document failed (a large file whose body did not arrive in
 * time, say) never reached ingest, so a stored result that is reopenable (documents.reopenable: OCR refused
 * for size, or the #1885 shared-memory upload failure) was never reopened, and every later sync failed the
 * same way. When the previous version's own original and result are stored here, that result is reopened
 * from the stored original instead: once (a reopened result is marked complete and no longer matches),
 * under the large-document lock (completeDocument takes it for a large file) and within the sync's OCR
 * budget. Returns ingest's record for that version, or null when there is nothing to reopen. The storage
 * file itself was not read, so the caller still reports the refresh as failed.
 */
async function reopenStored(workspace, projectId, name, previous, options = {}) {
  const d = previous?.document;
  if (!d || !/^[a-f0-9]{64}$/.test(d.version || '') || !/^[a-f0-9]{64}$/.test(d.byteHash || '')) return null;
  // The version is keyed by the extractor, so a record from an older extractor is re-read in full on a
  // successful read instead; it is not reopened here.
  if (d.version !== hash(d.byteHash + ':' + documents.EXTRACTOR_VERSION)) return null;
  let stored;
  try { stored = JSON.parse(fs.readFileSync(versionPath(workspace, projectId, d.version, '.json'), 'utf8')); } catch { return null; }
  if (!stored || stored.retryable || !documents.reopenable(stored)) return null;
  const original = versionPath(workspace, projectId, d.byteHash, '.pdf');
  if (!fs.existsSync(original)) return null;
  // The original is read from disk under the lock too, so a large file is in memory only while it is held.
  const size = (() => { try { return fs.statSync(original).size; } catch { return undefined; } })();
  return largeDocuments.ifLarge(size, async () => {
    const bytes = fs.readFileSync(original);
    if (hash(bytes) !== d.byteHash) return null;
    return ingest(workspace, projectId, name, bytes, previous, options);
  }, () => d.byteHash);
}
// #1865: what a page's OCR retry came to, as the source record keeps it.
const RETRY_OUTCOMES = new Set(['recovered', 'empty', 'failed', 'unavailable', 'skipped']);
function retryRecord(r) {
  const outcome = RETRY_OUTCOMES.has(r?.outcome) ? r.outcome : 'failed';
  return { outcome, ...(outcome === 'failed' && r.error ? { error: String(r.error).slice(0, 200) } : {}) };
}
// #1864: where reading stopped and why: the page limit, the text limit, or an error while reading a range.
const STOP_LIMITS = new Set(['pages', 'text', 'error']);
function stoppedRecord(s) {
  const limit = STOP_LIMITS.has(s?.limit) ? s.limit : 'error';
  return { page: Math.max(0, Number(s?.page) || 0), limit, ...(limit === 'error' && s.error ? { error: String(s.error).slice(0, 200) } : {}) };
}
const STOP_WORDS = { pages: 'page limit', text: 'text limit', error: 'read error' };
const pageList = (pages) => pages.slice(0, 20).map(p => p.number).join(', ') + (pages.length > 20 ? '…' : '');

/**
 * #1864/#1865: the per-page outcomes of a document as stable ids with parameters, so the browser can word
 * them in the interface language: where reading stopped, and what each page's OCR retry came to (failed
 * pages grouped by reason). [] when there is nothing to say.
 */
function notes(file) {
  const d = file?.document;
  if (!d) return [];
  const out = [];
  if (d.stoppedAt) out.push({ id: 'stoppedAtPage', params: { page: d.stoppedAt.page, limit: d.stoppedAt.limit, ...(d.stoppedAt.error ? { reason: d.stoppedAt.error } : {}) } });
  // #1868: the text past the 200,000-character head is still being added to search (document-backfill.cjs).
  if (d.searchable && d.searchable.version === d.availableVersion && d.searchable.complete === false && Number.isInteger(d.searchable.page)) {
    out.push({ id: 'searchableToPage', params: { page: d.searchable.page } });
  }
  const pages = Array.isArray(d.pageStatus) ? d.pageStatus : [];
  const by = (outcome) => pages.filter(p => p.retry?.outcome === outcome);
  const failedBy = new Map();
  for (const p of by('failed')) { const r = p.retry.error || 'unknown'; failedBy.set(r, [...(failedBy.get(r) || []), p]); }
  for (const [reason, list] of failedBy) out.push({ id: 'ocrRetryFailed', params: { pages: pageList(list), reason } });
  for (const [outcome, id] of [['empty', 'ocrRetryEmpty'], ['unavailable', 'ocrRetryUnavailable'], ['skipped', 'ocrRetryLimit'], ['recovered', 'ocrRetryRecovered']]) {
    const list = by(outcome);
    if (list.length) out.push({ id, params: { pages: pageList(list) } });
  }
  return out;
}
/** The English for one note (the server's own words: logs, the model's notices, older clients). */
function noteText(n) {
  const p = n.params || {};
  switch (n.id) {
    case 'stoppedAtPage': return `stopped at page ${p.page} (${STOP_WORDS[p.limit] || p.limit}${p.reason ? ': ' + p.reason : ''})`;
    case 'ocrRetryFailed': return `pages ${p.pages}: OCR retry failed: ${p.reason}`;
    case 'ocrRetryEmpty': return `pages ${p.pages}: OCR retry found no text`;
    case 'ocrRetryUnavailable': return `pages ${p.pages}: OCR retry unavailable (no OCR service is configured)`;
    case 'ocrRetryLimit': return `pages ${p.pages}: not retried (OCR retry limit of ${documents.RETRY_PAGE_CAP} pages)`;
    case 'searchableToPage': return `searchable up to page ${p.page} so far; later pages are still being indexed`;
    case 'ocrRetryRecovered': return `pages ${p.pages}: recovered by an OCR retry; verify numbers against the original`;
    default: return '';
  }
}
/** The fields a skipped-source entry carries for a document with notes: the problem without them
 *  (`reasonBase`) and the notes themselves, for the browser to word. {} when there are none. */
function problemNotes(file) {
  const list = notes(file);
  return list.length ? { reasonBase: problem(file, { notes: false }), notes: list } : {};
}

function failed(previous, name, reason) {
  return { ...previous, name, content: previous?.content || '', document: {
    ...previous?.document, state: 'failed', stale: !!previous?.content, error: reason,
    indexing: previous?.document?.indexing || 'unavailable',
  } };
}
function problem(file, { notes: withNotes = true } = {}) {
  const d = file.document;
  if (!d) return '';
  // #2237: not a failure and not final: the reading service was away and the file is read when it is back.
  if (d.state === 'queued') return `waiting to be read; document reading is not available yet and the file will be read automatically${d.stale ? '; using STALE text from the last readable version' : ''}.`;
  const issues = (d.pageStatus || []).filter(p => !['native', 'blank', 'ocr'].includes(p.status));
  const extra = withNotes ? notes(file).map(noteText).filter(Boolean) : [];
  return `${d.state}${d.stale ? '; using STALE text from the last readable version' : ''}` +
    `${d.pages ? '; ' + d.pages + ' pages' : ''}${d.truncated ? '; summary/page extraction limits reached' : ''}` +
    `${issues.length ? '; incomplete pages ' + issues.slice(0, 20).map(p => p.number + ' (' + p.status + (p.reason ? ': ' + p.reason : '') + ')').join(', ') + (issues.length > 20 ? '…' : '') : ''}` +
    `${extra.length ? '; ' + extra.join('; ').replace(/\.$/, '') : ''}` +
    `${d.error ? '; ' + d.error : ''}`.replace(/\.$/, '') + '.';
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
// A timeout or abort is NOT an outage: one large document can time out while the service is fine, so the
// sweep defers that document and goes on (figure-sweep.cjs ends a pass only after consecutive timeouts).
function serviceDown(error) {
  const e = String(error || '');
  if (/timed? ?out|timeout|aborted|AbortError/i.test(e)) return false;
  return /busy|unavailable|not configured|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH/i.test(e);
}
// #1770 review: whether a new extraction is at least as good as the current one.
const STATE_RANK = { failed: 0, partial: 1, ready: 2 };
const readablePages = (d) => (Array.isArray(d?.pageStatus) ? d.pageStatus : []).filter((p) => ['native', 'ocr', 'degraded'].includes(p?.status)).length;
function noWorse(current, next, nextText) {
  if (!String(nextText || '').trim()) return false;
  if ((STATE_RANK[next?.state] ?? 0) < (STATE_RANK[current?.state] ?? 0)) return false;
  return readablePages(next) >= readablePages(current);
}
module.exports = { retryable, serviceDown, noWorse, ingest, reopenStored, failed, notice, readPages, readOriginal, directory, prune, problem, notes, noteText, problemNotes };
