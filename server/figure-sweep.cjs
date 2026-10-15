'use strict';
// #1770: a one-time, paced sweep that reads existing documents again so they gain figures.
//
// Turning NOEVIA_MULTIMODAL_RAG on (with Docling) only changes the extractor version
// (documents.cjs EXTRACTOR_VERSION gains ':figures-v1'). A document read before that keeps its old
// record, without figures, until it is uploaded, replaced or synced again. This sweep re-extracts
// those documents from the original bytes already stored beside them (document-sources.cjs
// readOriginal), so the media pass (multimodal-rag.cjs) can embed their figures.
//
//   only while the flag is on        checked before every document; off, it never runs at all
//   at most once per document version  a document is a candidate while its record's `extractor` lacks
//                                    ':figures-v1' and it has not been tried at this version
//                                    (`document.figureSweep` = the version it was tried at, saved with
//                                    the project). A re-read writes the new extractor, so it is not a
//                                    candidate again; a re-read that fails for good is marked tried.
//                                    Only a transient failure (Docling unreachable, retryable) is left
//                                    unmarked, and it ends the pass until the next one.
//   paced                            one document at a time, then a pause so the sweep is busy at most
//                                    EMBEDDING_REINDEX_DUTY of the wall time (the re-index duty, default
//                                    0.5), never shorter than NOEVIA_MULTIMODAL_RAG_INTERVAL_MS (the media
//                                    pass's pause, default 2 s); it holds while a re-index is under way.
//                                    The duty is the ONLY pacing: the sweep does not watch chat traffic and
//                                    does not yield to a chat beyond it (a document's extraction, once
//                                    started, runs to the end). Docling runs on CPU beside the chat engine.
//   one media job at a time          the sweep and the image pass share multimodal-rag.cjs exclusive(): a
//                                    pass of either waits for the other, so Docling and the `.vision`
//                                    preset are never loaded for noevia at the same time. An image pass
//                                    scheduled by a re-read (sourceChanged) starts after the sweep ends.
//   bounded                          at most NOEVIA_MULTIMODAL_FIGURE_SWEEP_MAX documents per pass (10).
//   never Diary projects (#1736)     the Diary extras project and Diary chat contexts are skipped.
//   never scanned documents          a document whose readable pages all came from OCR has no figure
//                                    that would be embedded (multimodal-rag.cjs skips scanned pages),
//                                    so it is not read again.
//
// Each account's documents are read in that account's own scope (`runAs`), from its own directory.

const fs = require('node:fs');
const path = require('node:path');
const multimodal = require('./multimodal-rag.cjs');

const FIGURES_MARK = ':figures-v1';
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;

/**
 * Whether `file` (a project source) should be read again for figures. `record` is its stored
 * extraction record (<availableVersion>.json) or null when it could not be read.
 */
function needsFigures(file, record) {
  const d = file && file.document;
  if (!d || typeof d !== 'object') return false;
  if (typeof file.name !== 'string' || IMAGE_FILE.test(file.name)) return false;
  if (typeof d.extractor !== 'string' || d.extractor.includes(FIGURES_MARK)) return false;
  if (!/^[0-9a-f]{64}$/.test(String(d.version || '')) || !/^[0-9a-f]{64}$/.test(String(d.byteHash || ''))) return false;
  if (d.figureSweep === d.version) return false; // tried at this version already
  if (!d.availableVersion || d.state === 'failed') return false; // nothing readable to improve on
  if (record && scannedOnly(record)) return false;
  return true;
}

/** True when every page with text came from OCR (a scanned document): it would gain no embedded figure. */
function scannedOnly(record) {
  const pages = (Array.isArray(record?.pageTexts) ? record.pageTexts : []).filter((p) => p && p.status !== 'blank');
  return pages.length > 0 && pages.every((p) => multimodal.scannedPage(p));
}

/**
 * deps:
 *   enabled()                      the flag (multimodal-rag.cjs enabled)
 *   extractorVersion()             documents.cjs EXTRACTOR_VERSION; the sweep runs only when it has figures
 *   userIds()                      active account ids
 *   workspaceFor(userId)           that account's workspace ({ projects, revoked, ... }) or null
 *   documentDir(workspace, id)     document-sources.cjs directory()
 *   runAs(userId, fn)              runs fn in that account's request scope
 *   refresh(project, file)         projects.cjs refreshDocumentFigures, in scope:
 *                                  { status: 'refreshed' | 'failed' | 'missing' | 'changed' | 'retry' }
 *   paused()                       reason | null (a re-index is under way)
 */
function createFigureSweep({ enabled = () => multimodal.enabled(), extractorVersion, userIds, workspaceFor, documentDir, runAs, refresh,
  paused = () => null, gate = multimodal.exclusive, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = (line) => console.info(line), env = process.env, fsImpl = fs } = {}) {
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const duty = num(env.EMBEDDING_REINDEX_DUTY, 0.5, 0.05, 1);
  const minPauseMs = Math.round(num(env.NOEVIA_MULTIMODAL_RAG_INTERVAL_MS, 2000, 0, 600000));
  const maxPerPass = Math.round(num(env.NOEVIA_MULTIMODAL_FIGURE_SWEEP_MAX, 10, 1, 100));
  const on = () => { try { return !!enabled() && String(extractorVersion() || '').includes(FIGURES_MARK); } catch { return false; } };
  const hold = () => { try { return paused() || null; } catch { return null; } };
  let running = null;
  let stopped = false;
  let last = null;

  function readRecord(workspace, project, file) {
    try { return JSON.parse(fsImpl.readFileSync(path.join(documentDir(workspace, project.id), `${file.document.availableVersion}.json`), 'utf8')); } catch { return null; }
  }

  async function pass() {
    const totals = { refreshed: 0, failed: 0, deferred: 0, skipped: 0, remaining: 0, reason: null };
    if (!on()) return totals;
    let ids = [];
    try { ids = userIds() || []; } catch { ids = []; }
    let done = 0;
    let gap = false;
    let timeouts = 0;
    walk: for (const userId of ids) {
      let workspace = null;
      try { workspace = workspaceFor(userId); } catch { workspace = null; }
      if (!workspace || workspace.revoked) continue;
      for (const project of Array.isArray(workspace.projects) ? [...workspace.projects] : []) {
        if (!project || typeof project.id !== 'string' || multimodal.diaryProject(project.id)) continue;
        for (const file of Array.isArray(project.files) ? [...project.files] : []) {
          if (!needsFigures(file, null)) continue;
          if (!needsFigures(file, readRecord(workspace, project, file))) { totals.skipped += 1; continue; }
          if (stopped || !on()) break walk;
          if (done >= maxPerPass) { totals.remaining += 1; continue; }
          const why = hold();
          if (why) { totals.reason = String(why); break walk; }
          const started = now();
          let r;
          try { r = await runAs(userId, () => refresh(project, file)); } catch (err) { r = { status: 'failed', error: String(err?.message || err).slice(0, 200) }; }
          const status = r?.status;
          // A transient failure of this one document is skipped (not marked: the next pass tries it again);
          // only the extraction service itself being down or busy ends the pass.
          if (status === 'retry' && r.unreachable) { totals.reason = `document extraction is unavailable${r.error ? `: ${r.error}` : ''}`; break walk; }
          if (status === 'retry') {
            totals.deferred += 1; done += 1; gap = true;
            // Two timeouts in a row look like a struggling service rather than one large document: end the pass.
            timeouts = /timed? ?out|timeout|aborted|AbortError/i.test(String(r.error || '')) ? timeouts + 1 : 0;
            if (timeouts >= 2) { totals.reason = `document extraction timed out twice in a row${r.error ? `: ${r.error}` : ''}`; break walk; }
          } else if (status === 'refreshed') { totals.refreshed += 1; done += 1; gap = true; }
          else if (status === 'failed' || status === 'missing' || status === 'worse') { totals.failed += 1; done += 1; gap = true; }
          if (status !== 'retry') timeouts = 0;
          if (gap) {
            gap = false;
            const busy = Math.max(0, now() - started);
            await sleep(Math.max(minPauseMs, Math.round(busy * (1 - duty) / duty)));
          }
        }
      }
    }
    return totals;
  }

  function kick() {
    if (stopped || !on()) return null;
    if (running) return running;
    running = (async () => {
      try {
        const totals = await gate('figure sweep', pass);
        last = { at: Date.now(), ...totals };
        if (totals.refreshed || totals.failed || totals.reason) {
          log(`[media] figure sweep: ${totals.refreshed} document(s) read again for figures, ${totals.failed} could not be${totals.deferred ? `, ${totals.deferred} deferred` : ''}${totals.remaining ? `, ${totals.remaining} wait for the next pass` : ''}${totals.reason ? ` (held: ${totals.reason})` : ''}`);
        }
        return totals;
      } catch (err) {
        log(`[media] figure sweep failed: ${String(err?.message || err).slice(0, 200)}`);
        return null;
      } finally { running = null; }
    })();
    return running;
  }

  return {
    kick,
    status: () => ({ enabled: on(), running: !!running, last }),
    idle: () => running || Promise.resolve(),
    stop() { stopped = true; },
  };
}

module.exports = { FIGURES_MARK, needsFigures, scannedOnly, createFigureSweep };
