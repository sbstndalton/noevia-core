'use strict';
// #1868 / #1869: the paced background work that finishes long and uploaded documents.
//
// #1868, the tail of a long document. Retrieval indexes a source's text, which for a document is its first
// EXTRACT_CAP (200,000) characters; the page store keeps up to PROJECT_DOCUMENT_TEXT_LIMIT (8,000,000). This
// appends the rest to the same index (rag.cjs appendFileTail): the page-store text from the page the head ends
// on, cut by the unchanged chunker (rag.chunkText), minus the chunks the head already has. Nothing that is
// indexed is re-cut or re-embedded, so there is no re-index: existing documents only gain their missing tail.
//
//   budget       at most PROJECT_TAIL_EMBED_PER_PASS chunks per pass (default 96) and
//                PROJECT_TAIL_EMBED_PER_HOUR in any rolling hour (default 960), all accounts together, and at
//                most PROJECT_TAIL_EMBED_PER_DOCUMENT per document per pass (default 48), so one huge document
//                never holds the single embed service: the rest of it continues on later passes. At ~1,050
//                new characters per chunk an 8M-character document is ~7,600 chunks, about 8 hours of passes.
//   paced        chunks go in calls of PROJECT_TAIL_EMBED_BATCH (default 16; the embed requests themselves are
//                rag.cjs's batches of 8, through the inference guard), with a pause after each call so the pass
//                is busy at most EMBEDDING_REINDEX_DUTY of the wall time (default 0.5), as the #1636 re-index.
//   held         while a re-index is under way (#1636: its own paced pass fills every slot, tail rows included)
//                and while the embedding service is off. An embedding failure ends the pass; the chunks
//                appended without a vector are embedded first on the next one.
//   status       document.searchable = { version, page, complete }: "searchable up to page N" while the tail
//                is still being embedded (document-sources.cjs notes 'searchableToPage').
//
// #1869, the completion pass for uploads. The #1864/#1865 completion (pages past the first window, OCR retry
// of incomplete pages) runs when a source is read again; a document uploaded with no storage connection is
// never read again. This runs it once for such documents (no `source`, a PDF, read by the current extractor,
// whose stored record has no completion marker) from the stored original: at most
// PROJECT_UPLOAD_COMPLETION_PER_PASS documents per pass (default 2) and the sync path's OCR budget per pass
// (documents.ocrBudget, PROJECT_SYNC_OCR_PAGES, default 40 pages), paced by the same duty. A document the budget
// left unfinished keeps no marker and resumes on the next pass; `document.completionSweep` records the version
// that needs nothing more, so a finished document is never looked at again.
//
// Passes start PROJECT_BACKFILL_DELAY_MS after boot (default 90 s) and run every PROJECT_BACKFILL_INTERVAL_MS
// (default 5 min); one at a time. Each account's projects are handled in its own scope (runAs), from its own
// directory and index. Diary projects are skipped.

const fs = require('node:fs');
const path = require('node:path');

const MARKER = /(?:^|\n\n)\[Page (\d+)\]\n/g;

/** The page-store text exactly as documents.cjs assemble() writes a source's text, uncapped. */
function fullText(record) {
  const pages = (Array.isArray(record?.pageTexts) ? record.pageTexts : []).filter((p) => p && Number.isInteger(Number(p.number)))
    .slice().sort((a, b) => a.number - b.number);
  return pages.map((p) => `[Page ${p.number}]\n${p.text || '(' + p.status + ')'}`).join('\n\n');
}

/**
 * The chunks of a document past its head, in order: [{ body, page }], or null when the stored record does not
 * begin with `content` (another version, or a format this does not know: nothing is appended then).
 * `textLimit` caps the whole text (the per-document ceiling). The page the head ends on is chunked again in
 * full: its chunks that equal the head's are skipped by appendFileTail, so only its cut-off end is added.
 */
function tailChunks(content, record, { textLimit, chunkText }) {
  const head = String(content || '');
  if (!head) return null;
  let full = fullText(record);
  if (!full.startsWith(head)) return null;
  const limited = Number.isSafeInteger(textLimit) && textLimit > 0 && full.length > textLimit;
  if (limited) full = full.slice(0, textLimit);
  if (full.length <= head.length) return { chunks: [], limited };
  let from = 0;
  for (const m of head.matchAll(MARKER)) from = m.index + (m[0].startsWith('\n\n') ? 2 : 0);
  const chunks = chunkText(full.slice(from)).map((body) => ({ body, page: Number((/^\[Page (\d+)\]/.exec(body) || [])[1]) || 0 }));
  return { chunks, limited };
}

const num = (v, d, lo, hi) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

function settings(env = process.env) {
  return {
    perPass: Math.round(num(env.PROJECT_TAIL_EMBED_PER_PASS, 96, 1, 10000)),
    perHour: Math.round(num(env.PROJECT_TAIL_EMBED_PER_HOUR, 960, 1, 100000)),
    perDocument: Math.round(num(env.PROJECT_TAIL_EMBED_PER_DOCUMENT, 48, 1, 10000)),
    batch: Math.round(num(env.PROJECT_TAIL_EMBED_BATCH, 16, 1, 64)),
    uploads: Math.round(num(env.PROJECT_UPLOAD_COMPLETION_PER_PASS, 2, 0, 50)),
    duty: num(env.EMBEDDING_REINDEX_DUTY, 0.5, 0.05, 1),
    minPauseMs: Math.round(num(env.PROJECT_BACKFILL_MIN_PAUSE_MS, 250, 0, 600000)),
    delayMs: Math.round(num(env.PROJECT_BACKFILL_DELAY_MS, 90000, 0, 3600000)),
    intervalMs: Math.round(num(env.PROJECT_BACKFILL_INTERVAL_MS, 300000, 10000, 86400000)),
  };
}

const HEX = /^[0-9a-f]{64}$/;

/** #1869: whether `file` is an upload that may still need the completion pass (cheap: no file is read). */
function uploadCandidate(file, extractorVersion) {
  const d = file && file.document;
  if (!d || typeof d !== 'object' || file.source) return false;
  if (typeof file.name !== 'string' || !/\.pdf$/i.test(file.name)) return false;
  if (!HEX.test(String(d.version || '')) || !HEX.test(String(d.byteHash || ''))) return false;
  if (d.extractor !== extractorVersion) return false; // another extractor: a re-read, not a completion
  return d.completionSweep !== d.version;
}

/** #1868: whether `file` may have text past its head that is not searchable yet (cheap: no file is read). */
function tailCandidate(file, headCap, textLength) {
  const d = file && file.document;
  if (!d || typeof d !== 'object' || !HEX.test(String(d.availableVersion || ''))) return false;
  if (!['ready', 'partial'].includes(d.indexing)) return false; // the head is not indexed (yet)
  if (textLength(file) < headCap) return false;
  return !(d.searchable && d.searchable.version === d.availableVersion && d.searchable.complete === true);
}

/**
 * deps:
 *   rag                   rag.cjs (appendFileTail, chunkText)
 *   userIds()             active account ids
 *   workspaceFor(userId)  that account's workspace
 *   runAs(userId, fn)     fn in that account's request scope
 *   completeUpload(project, file, { ocrBudget })  projects.cjs completeUploadedDocument, in scope:
 *                         { status: 'complete' | 'completed' | 'deferred' | 'retry' | 'failed' | 'missing' | 'changed', unreachable? }
 *   documentDir(workspace, projectId)  document-sources.cjs directory()
 *   paused()              reason | null (a re-index is under way)
 */
function createDocumentBackfill({ rag, userIds, workspaceFor, runAs, completeUpload, documentDir, paused = () => null,
  documents = require('./documents.cjs'), limits = () => require('./source-limits.cjs').documentLimits(), textLength = require('./source-text.cjs').textLength,
  diaryProject = require('./multimodal-rag.cjs').diaryProject, env = process.env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now, log = (line) => console.info(line), fsImpl = fs } = {}) {
  const cfg = settings(env);
  const spent = []; // [{ at, n }] tail chunks embedded in the last hour
  let running = null, stopped = false, last = null;
  const hold = () => { try { return paused() || null; } catch { return null; } };
  const hourLeft = () => {
    const cutoff = now() - 3600000;
    while (spent.length && spent[0].at <= cutoff) spent.shift();
    return Math.max(0, cfg.perHour - spent.reduce((n, s) => n + s.n, 0));
  };
  const pause = async (started) => { const busy = Math.max(0, now() - started); await sleep(Math.max(cfg.minPauseMs, Math.round(busy * (1 - cfg.duty) / cfg.duty))); };
  const readRecord = (workspace, projectId, version) => {
    try { return JSON.parse(fsImpl.readFileSync(path.join(documentDir(workspace, projectId), `${version}.json`), 'utf8')); } catch { return null; }
  };

  // One document's tail, within `allowance` chunks. Returns how many were embedded and whether to go on.
  async function extend(workspace, project, file, allowance, totals) {
    const d = file.document;
    const version = d.availableVersion;
    const record = readRecord(workspace, project.id, version);
    const content = String(file.content || '');
    const plan = record ? tailChunks(content, record, { textLimit: limits().text, chunkText: rag.chunkText }) : null;
    const save = (searchable) => {
      if (!workspace.projects.includes(project) || !(project.files || []).includes(file) || file.document !== d || d.availableVersion !== version) return;
      const prev = d.searchable;
      if (prev && prev.version === searchable.version && prev.page === searchable.page && prev.complete === searchable.complete && !!prev.limited === !!searchable.limited) return;
      d.searchable = searchable;
      try { workspace.saveProjects(); } catch (err) { log(`[documents] could not save search coverage: ${String(err?.message || err).slice(0, 120)}`); }
    };
    // Nothing past the head, or a record that does not match the text: nothing to append, ever, for this version.
    if (!plan || !plan.chunks.length) { save({ version, page: null, complete: true }); return { embedded: 0, go: true }; }
    let embedded = 0;
    while (allowance > 0) {
      if (stopped) return { embedded, go: false };
      const why = hold();
      if (why) { totals.reason = String(why); return { embedded, go: false }; }
      const started = now();
      const limit = Math.min(cfg.batch, allowance);
      let r;
      try { r = await rag.appendFileTail(project.id, file.name, content, plan.chunks, workspace.userId, { limit }); }
      catch (err) { r = { ok: false, reason: 'error', error: String(err?.message || err).slice(0, 200) }; }
      embedded += r.embedded || 0;
      allowance -= Math.max(r.attempted || 0, r.embedded || 0);
      if (r.embedded) spent.push({ at: now(), n: r.embedded });
      if (r.searchableTo !== undefined && r.pending !== null && r.pending !== undefined) {
        save({ version, page: r.complete ? null : r.searchableTo, complete: !!r.complete, ...(plan.limited ? { limited: true } : {}) });
      }
      if (!r.ok) {
        // The embeddings service failing (or off) ends the pass; a document that is not ready is skipped.
        if (['embed-failed', 'embedding-off', 'error', 'rag-unavailable'].includes(r.reason)) {
          totals.reason = `embedding unavailable${r.error ? `: ${r.error}` : ''}`;
          return { embedded, go: false };
        }
        return { embedded, go: true };
      }
      if (r.complete || !r.attempted) return { embedded, go: true };
      if (!r.embedded) return { embedded, go: true }; // nothing stored (e.g. a vector width mismatch): never spin
      await pause(started);
    }
    totals.remaining += 1;
    return { embedded, go: true };
  }

  async function pass() {
    const totals = { completed: 0, deferred: 0, failed: 0, embedded: 0, documents: 0, remaining: 0, reason: null };
    let ids = [];
    try { ids = userIds() || []; } catch { ids = []; }
    const ocrBudget = documents.ocrBudget(env);
    let uploads = 0, uploadsHeld = false;
    let passLeft = Math.min(cfg.perPass, hourLeft());
    const headCap = documents.EXTRACT_CAP;
    let extractor = '';
    try { extractor = documents.EXTRACTOR_VERSION; } catch { extractor = ''; }
    walk: for (const userId of ids) {
      let workspace = null;
      try { workspace = workspaceFor(userId); } catch { workspace = null; }
      if (!workspace || workspace.revoked) continue;
      for (const project of Array.isArray(workspace.projects) ? [...workspace.projects] : []) {
        if (!project || typeof project.id !== 'string' || diaryProject(project.id)) continue;
        for (const listed of Array.isArray(project.files) ? [...project.files] : []) {
          if (stopped) break walk;
          // #1869 first: completing a record can add pages the tail then picks up.
          if (uploadCandidate(listed, extractor)) {
            if (uploadsHeld || uploads >= cfg.uploads) totals.remaining += 1;
            else {
              const why = hold();
              if (why) { totals.reason = String(why); break walk; }
              const started = now();
              let r;
              try { r = await runAs(userId, () => completeUpload(project, listed, { ocrBudget })); } catch (err) { r = { status: 'failed', error: String(err?.message || err).slice(0, 200) }; }
              const status = r?.status;
              if (status !== 'complete' && status !== 'changed') {
                uploads += 1;
                if (status === 'completed') totals.completed += 1;
                else if (status === 'deferred' || status === 'retry') totals.deferred += 1;
                else totals.failed += 1;
                if (status === 'retry' && r.unreachable) uploadsHeld = true;
                await pause(started);
              }
            }
          }
          const file = (project.files || []).find((f) => f && f.name === listed.name);
          if (!file || !tailCandidate(file, headCap, textLength)) continue;
          if (passLeft <= 0) { totals.remaining += 1; continue; }
          totals.documents += 1;
          let r;
          try { r = await runAs(userId, () => extend(workspace, project, file, Math.min(cfg.perDocument, passLeft), totals)); }
          catch (err) { r = { embedded: 0, go: false }; totals.reason = String(err?.message || err).slice(0, 200); }
          passLeft -= r.embedded;
          totals.embedded += r.embedded;
          if (!r.go) break walk;
        }
      }
    }
    return totals;
  }

  function kick() {
    if (stopped) return null;
    if (running) return running;
    running = (async () => {
      try {
        const totals = await pass();
        last = { at: now(), ...totals };
        if (totals.embedded || totals.completed || totals.deferred || totals.failed || totals.reason) {
          log(`[documents] backfill: ${totals.embedded} tail chunk(s) embedded over ${totals.documents} document(s), ${totals.completed} upload(s) completed, ${totals.deferred} deferred, ${totals.failed} failed${totals.remaining ? `, ${totals.remaining} wait for a later pass` : ''}${totals.reason ? ` (held: ${totals.reason})` : ''}`);
        }
        return totals;
      } catch (err) {
        log(`[documents] backfill failed: ${String(err?.message || err).slice(0, 200)}`);
        return null;
      } finally { running = null; }
    })();
    return running;
  }

  let timers = [];
  function start({ setTimeoutImpl = setTimeout, setIntervalImpl = setInterval } = {}) {
    const a = setTimeoutImpl(() => kick(), cfg.delayMs); a?.unref?.();
    const b = setIntervalImpl(() => kick(), cfg.intervalMs); b?.unref?.();
    timers = [a, b];
  }

  return {
    kick, start, settings: cfg,
    status: () => ({ running: !!running, last, hourLeft: hourLeft() }),
    idle: () => running || Promise.resolve(),
    stop() { stopped = true; for (const t of timers) { try { clearTimeout(t); clearInterval(t); } catch { /* gone */ } } },
  };
}

module.exports = { fullText, tailChunks, settings, uploadCandidate, tailCandidate, createDocumentBackfill };
