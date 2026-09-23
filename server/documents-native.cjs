'use strict';
// The pdf.js walk behind the default extraction backend (documents.cjs), run in a worker thread.
//
// pdf.js parses untrusted bytes, and before this it did so on the web server's own thread with no
// bound but the output caps: a pathological PDF — a content stream that never ends, a font
// program that allocates without limit — held every user's requests while it ran, and could
// take the process down with it. In a worker it has a wall-clock limit, its own heap limit and a
// watched memory-growth limit; hitting any stops that document, not the server.
//
// Worker side: `readNativePages` does the walk and posts page records back. Main side:
// `readInWorker` starts one worker per document, enforces the limits and turns a limit into an
// error saying which one was hit. The worker never touches storage, the network or the OCR
// service; bytes in, page records out.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const TIME_LIMIT_MS = 120_000;
const HEAP_LIMIT_MB = 512;
// V8's heap limit does not count ArrayBuffer memory, which is where pdf.js puts decoded streams
// and images (measured: a worker held 1.5 GB of Uint8Arrays under a 64 MB heap limit). So the
// process's resident memory is watched while a reader runs, and one reader runs at a time so
// that growth is attributable to it.
const GROWTH_LIMIT_MB = 1024;
const WATCH_MS = 100;
const MAX_PENDING = 4;
const MAX_PENDING_BYTES = 100 * 1024 * 1024;
const QUEUE_WAIT_MS = 30_000;
// pdf.js's own cap on a decoded image, in pixels (default: unlimited).
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;

/** The walk itself: native text per page, image-bearing pages flagged for OCR. */
async function readNativePages(bytes, { pageCap, pageTextCap, totalTextCap }) {
  const { getDocumentProxy, getResolvedPDFJS } = require('unpdf');
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes), { maxImageSize: MAX_IMAGE_PIXELS, isEvalSupported: false });
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
 * Make a one-worker PDF reader with bounded pending work. Active reads retain their time, heap,
 * and memory-growth limits; pending reads have separate count, byte, and wait limits.
 * `script` and `rss` remain replaceable per read; copyBytes and makeWorker are replaceable
 * per queue for deterministic tests.
 */
function createReader({ maxPending = MAX_PENDING, maxPendingBytes = MAX_PENDING_BYTES, queueWaitMs = QUEUE_WAIT_MS,
  copyBytes = bytes => new Uint8Array(bytes), makeWorker = (script, options) => new Worker(script, options) } = {}) {
  // Only pending calls consume reservations. The active worker keeps the existing RSS-growth
  // attribution; its transfer copy is made after it owns that slot, never while queued.
  const pending = [];
  let pendingBytes = 0, active = false;
  const busy = reason => Object.assign(new Error(reason === 'wait'
    ? 'The PDF reader stayed busy too long; refresh or re-upload to retry.'
    : 'The PDF reader is busy; wait for current processing, then retry.'), { limit: 'queue', reason });

  function runWorker(bytes, { timeLimitMs = TIME_LIMIT_MS, heapLimitMb = HEAP_LIMIT_MB, growthLimitMb = GROWTH_LIMIT_MB,
    script = __filename, rss = () => process.memoryUsage.rss(), ...caps }) {
    return new Promise((resolve, reject) => {
      // The caller's Buffer may be a slice of a shared pool. Transfer only this private copy.
      const copy = copyBytes(bytes);
      const baseline = rss();
      const worker = makeWorker(script, {
        workerData: { noeviaPdfWorker: true, bytes: copy, caps },
        transferList: [copy.buffer],
        resourceLimits: { maxOldGenerationSizeMb: heapLimitMb, maxYoungGenerationSizeMb: Math.min(64, heapLimitMb) },
        // Nothing from the server's environment is the parser's business. pdf.js's own warnings
        // still reach the server log through the inherited stdout/stderr.
        env: {},
      });
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return; settled = true; clearTimeout(timer); clearInterval(watch);
        worker.terminate().catch(() => {}).finally(() => fn(value));
      };
      const timer = setTimeout(() => finish(reject, Object.assign(Error('time limit'), { limit: 'time' })), timeLimitMs);
      const watch = setInterval(() => {
        if (rss() - baseline > growthLimitMb * 1024 * 1024) finish(reject, Object.assign(Error('memory limit'), { limit: 'memory' }));
      }, WATCH_MS);
      worker.on('message', (m) => (m && m.ok ? finish(resolve, m.result) : finish(reject, Error(String(m?.message || 'The PDF reader failed.')))));
      worker.on('error', (err) => finish(reject, err && err.code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? Object.assign(Error('memory limit'), { limit: 'memory' }) : err));
      worker.on('exit', (code) => finish(reject, Error(`The PDF reader stopped (exit ${code}).`)));
    });
  }

  function start(entry) {
    active = true;
    Promise.resolve().then(() => runWorker(entry.bytes, entry.options))
      .then(entry.resolve, entry.reject)
      .finally(() => { active = false; drain(); });
  }

  function drain() {
    while (!active && pending.length) {
      const entry = pending.shift();
      pendingBytes -= entry.size;
      clearTimeout(entry.waitTimer);
      if (Date.now() >= entry.deadline) { entry.reject(busy('wait')); continue; }
      start(entry);
    }
  }

  return function readInWorker(bytes, options = {}) {
    return new Promise((resolve, reject) => {
      const entry = { bytes, options, resolve, reject, size: bytes.byteLength };
      if (!active && !pending.length) return start(entry);
      if (pending.length >= maxPending || pendingBytes + entry.size > maxPendingBytes) return reject(busy('full'));
      entry.deadline = Date.now() + queueWaitMs;
      entry.waitTimer = setTimeout(() => {
        const index = pending.indexOf(entry);
        if (index < 0) return;
        pending.splice(index, 1);
        pendingBytes -= entry.size;
        reject(busy('wait'));
      }, queueWaitMs);
      pending.push(entry);
      pendingBytes += entry.size;
    });
  };
}

const readInWorker = createReader();

if (!isMainThread && workerData && workerData.noeviaPdfWorker) {
  readNativePages(workerData.bytes, workerData.caps)
    .then((result) => parentPort.postMessage({ ok: true, result }))
    .catch((err) => parentPort.postMessage({ ok: false, message: String(err && err.message || err) }));
}

module.exports = { readInWorker, readNativePages, createReader, TIME_LIMIT_MS, HEAP_LIMIT_MB, GROWTH_LIMIT_MB, MAX_PENDING, MAX_PENDING_BYTES, QUEUE_WAIT_MS };
