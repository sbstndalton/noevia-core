'use strict';
// #1805: the project source limits, in one place. Before this the 60-source cap was a literal in
// uploads.cjs, five places in routes/projects.cjs and folder-import.cjs, and the 12-image cap in two.
//
//   PROJECT_SOURCE_LIMIT    every source a project holds (text, code, documents, images)
//   PROJECT_DOCUMENT_LIMIT  of those, documents (PDF, DOCX and the other document types)
//   PROJECT_IMAGE_LIMIT     of those, images that are model input
//
// Defaults (contracts/folder-import.json `projectLimits`): 1000 / 200 / 12. They were 60 / 60 / 12
// until #1806 moved source text out of projects.json (source-text.cjs): with the text inline, 1000
// sources of the 200k-character per-source maximum made the file ~180 MB and each save ~480 ms
// (measured for #1805). Read per call so a test, or an owner's env change plus restart, takes effect.

const contract = require('../contracts/folder-import.json');

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function limits(env = process.env) {
  const d = contract.projectLimits;
  const sources = positiveInt(env.PROJECT_SOURCE_LIMIT, d.sources);
  return {
    sources,
    documents: Math.min(sources, positiveInt(env.PROJECT_DOCUMENT_LIMIT, d.documents)),
    images: positiveInt(env.PROJECT_IMAGE_LIMIT, d.images),
  };
}

// #1864: how much of ONE document is read. File size no longer decides whether a PDF is read: it is
// read in page ranges, and the ceilings below bound the work and the result instead.
//
//   PROJECT_DOCUMENT_READ_BYTES   the largest PDF read from storage (default 256 MiB). PDF bytes cannot be
//                                 streamed page by page (the cross-reference table is at the end), so the
//                                 whole file is held while it is read. 256 MiB is ten times the old 25 MiB
//                                 gate, and also the sidecars' ranged-request ceiling (services/docling,
//                                 services/ocr). On DaServer (#697: no swap, the iGPU takes its memory from
//                                 system RAM) the web process then holds at most ~2x this transiently (the
//                                 buffer plus the reader's private copy), never a multiple per page.
//   PROJECT_DOCUMENT_PAGE_LIMIT   pages read per document (default 1000). Docling's measured worst case is
//                                 10.9 s per table-heavy page and 3.4 s per scanned page on DaServer's 2
//                                 CPUs, so 1000 pages is ~1 to 3 hours of one slot; past that the document
//                                 is partial, "stopped at page 1000 (page limit)".
//   PROJECT_DOCUMENT_TEXT_LIMIT   characters kept in the page store (default 8,000,000, four times the old
//                                 2,000,000). The page store is one JSON file read whole by the page reader;
//                                 8 M characters keep it ~16 MB at worst.
//   PROJECT_DOCUMENT_RANGE_PAGES  pages per extraction request past the first window (default 25): the unit
//                                 that bounds time (25 x 10.9 s ~ 4.5 min) and peak memory per request.
// Read per call (an env change plus restart, or a test, takes effect). A non-positive value is ignored.
const DOCUMENT_DEFAULTS = Object.freeze({ readBytes: 256 * 1024 * 1024, pages: 1000, text: 8_000_000, rangePages: 25 });
function documentLimits(env = process.env) {
  const d = DOCUMENT_DEFAULTS;
  return {
    readBytes: positiveInt(env.PROJECT_DOCUMENT_READ_BYTES, d.readBytes),
    pages: positiveInt(env.PROJECT_DOCUMENT_PAGE_LIMIT, d.pages),
    text: positiveInt(env.PROJECT_DOCUMENT_TEXT_LIMIT, d.text),
    // More than 200 pages per request would undo the point of ranges (and the sidecars refuse it).
    rangePages: Math.min(200, positiveInt(env.PROJECT_DOCUMENT_RANGE_PAGES, d.rangePages)),
  };
}

const DOCUMENT = /\.(pdf|docx?|odt|rtf|pptx?|xlsx?|ods|odp|epub)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

/** 'image' | 'document' | 'text' for a source record or a bare name. */
function kindOf(fileOrName) {
  const f = typeof fileOrName === 'string' ? { name: fileOrName } : (fileOrName || {});
  const group = f.attachment?.group;
  if (group === 'Images' || f.attachment?.assetId || (!group && IMAGE.test(f.name || ''))) return 'image';
  if (group === 'Documents' || f.document || (!group && DOCUMENT.test(f.name || ''))) return 'document';
  return 'text';
}

/** How many of each kind a list of sources holds. */
function counts(files) {
  const c = { sources: 0, documents: 0, images: 0 };
  for (const f of files || []) {
    c.sources += 1;
    const k = kindOf(f);
    if (k === 'document') c.documents += 1;
    else if (k === 'image') c.images += 1;
  }
  return c;
}

const message = {
  sources: (n) => `A project holds at most ${n} sources.`,
  documents: (n) => `A project holds at most ${n} documents (PDF, DOCX and similar).`,
  images: (n) => `A project holds at most ${n} vision images.`,
};
const CODE = { sources: 'projectLimit', documents: 'documentLimit', images: 'imageLimit' };

/** Whether one more source of `name` fits next to `files`: null, or { code, message, max } naming
 *  the first cap it would pass. `imagesHeld` counts model-input images (project.assets) when given. */
function refusal(files, name, { imagesHeld, env } = {}) {
  const l = limits(env), c = counts(files), k = kindOf(name);
  if (c.sources >= l.sources) return { code: CODE.sources, message: message.sources(l.sources), max: l.sources };
  if (k === 'document' && c.documents >= l.documents) return { code: CODE.documents, message: message.documents(l.documents), max: l.documents };
  if (k === 'image' && (imagesHeld ?? c.images) >= l.images) return { code: CODE.images, message: message.images(l.images), max: l.images };
  return null;
}

module.exports = { limits, documentLimits, DOCUMENT_DEFAULTS, kindOf, counts, refusal, message, CODE };
