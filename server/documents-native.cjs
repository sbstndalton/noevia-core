'use strict';
// The pdf.js walk behind the default extraction backend (documents.cjs), run in a worker thread.
//
// pdf.js parses untrusted bytes, and before this it did so on the web server's own thread with no
// bound but the output caps: a pathological PDF — a content stream that never ends, a font
// program that allocates without limit — held every user's requests while it ran, and could
// take the process down with it. In a worker it has a wall-clock limit and its own heap limit;
// hitting either stops that document, not the server.
//
// Worker side: `readNativePages` does the walk and posts page records back. Main side:
// `readInWorker` starts one worker per document, enforces the limits and turns a limit into an
// error saying which one was hit. The worker never touches storage, the network or the OCR
// service; bytes in, page records out.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const TIME_LIMIT_MS = 120_000;
const HEAP_LIMIT_MB = 512;

/** The walk itself: native text per page, image-bearing pages flagged for OCR. */
async function readNativePages(bytes, { pageCap, pageTextCap, totalTextCap }) {
  const { getDocumentProxy, getResolvedPDFJS } = require('unpdf');
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { OPS } = await getResolvedPDFJS();
    const imageOps = new Set(Object.entries(OPS).filter(([name]) => /paint.*Image|paintImageMask/.test(name)).map(([, value]) => value));
    const markOps = new Set(Object.entries(OPS).filter(([name]) => /^(stroke|fill|eoFill|shadingFill|paint)/.test(name)).map(([, value]) => value));
    const pageTexts = [];
    let remaining = totalTextCap;
    for (let number = 1; number <= Math.min(pdf.numPages, pageCap); number++) {
      const page = await pdf.getPage(number);
      try {
        const content = await page.getTextContent();
        let text = '', positions = [];
        for (const item of content.items) {
          if (typeof item.str !== 'string') continue;
          // Keep native item order and coordinates for later layout work; do
          // not invent table cells from spacing or reorder financial values.
          const available = Math.min(pageTextCap, remaining) - text.length;
          if (available <= 0) break;
          text += (item.str + (item.hasEOL ? '\n' : ' ')).slice(0, available);
          positions.push({ text: item.str.slice(0, available), x: item.transform?.[4], y: item.transform?.[5] });
        }
        const truncated = content.items.reduce((n, i) => n + (typeof i.str === 'string' ? i.str.length + 1 : 0), 0) > text.length;
        text = text.trim(); remaining -= text.length;
        const ops = await page.getOperatorList();
        const hasImages = ops.fnArray.some(op => imageOps.has(op));
        const status = truncated ? 'truncated' : hasImages ? 'ocr-needed' : text ? 'native' : ops.fnArray.some(op => markOps.has(op)) ? 'unreadable' : 'blank';
        pageTexts.push({ number, text, positions, status, hasImages, method: 'native', truncated });
      } catch (err) {
        pageTexts.push({ number, text: '', status: 'failed', method: 'native', error: String(err.message || err).slice(0, 300) });
      } finally { page.cleanup(); }
    }
    return { numPages: pdf.numPages, pageTexts };
  } finally { if (pdf) await pdf.loadingTask.destroy(); }
}

/**
 * Read a PDF's pages in a worker, within a time and a heap limit. A limit rejects with
 * `err.limit` = 'time' | 'memory'; a parse failure rejects with the parser's own message.
 * @param {Buffer|Uint8Array} bytes
 * @param {{pageCap: number, pageTextCap: number, totalTextCap: number, timeLimitMs?: number,
 *          heapLimitMb?: number, script?: string}} options  `script` replaces the worker (tests).
 */
function readInWorker(bytes, { timeLimitMs = TIME_LIMIT_MS, heapLimitMb = HEAP_LIMIT_MB, script = __filename, ...caps }) {
  // A copy, transferred: the caller's buffer may be a slice of a shared pool.
  const copy = new Uint8Array(bytes);
  return new Promise((resolve, reject) => {
    const worker = new Worker(script, {
      workerData: { noeviaPdfWorker: true, bytes: copy, caps },
      transferList: [copy.buffer],
      resourceLimits: { maxOldGenerationSizeMb: heapLimitMb, maxYoungGenerationSizeMb: Math.min(64, heapLimitMb) },
      // Nothing from the server's environment is the parser's business.
      env: {}, stdout: true, stderr: true,
    });
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); worker.terminate().catch(() => {}); };
    const timer = setTimeout(() => finish(reject, Object.assign(Error('time limit'), { limit: 'time' })), timeLimitMs);
    worker.on('message', (m) => (m && m.ok ? finish(resolve, m.result) : finish(reject, Error(String(m?.message || 'The PDF reader failed.')))));
    worker.on('error', (err) => finish(reject, err && err.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? Object.assign(Error('memory limit'), { limit: 'memory' }) : err));
    worker.on('exit', (code) => finish(reject, Error(`The PDF reader stopped (exit ${code}).`)));
  });
}

if (!isMainThread && workerData && workerData.noeviaPdfWorker) {
  readNativePages(workerData.bytes, workerData.caps)
    .then((result) => parentPort.postMessage({ ok: true, result }))
    .catch((err) => parentPort.postMessage({ ok: false, message: String(err && err.message || err) }));
}

module.exports = { readInWorker, readNativePages, TIME_LIMIT_MS, HEAP_LIMIT_MB };
