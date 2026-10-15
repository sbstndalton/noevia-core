'use strict';
// #1805: the project source limits, in one place. Before this the 60-source cap was a literal in
// uploads.cjs, five places in routes/projects.cjs and folder-import.cjs, and the 12-image cap in two.
//
//   PROJECT_SOURCE_LIMIT    every source a project holds (text, code, documents, images)
//   PROJECT_DOCUMENT_LIMIT  of those, documents (PDF, DOCX and the other document types)
//   PROJECT_IMAGE_LIMIT     of those, images that are model input
//
// Defaults (contracts/folder-import.json `projectLimits`) keep today's behaviour: 60 / 60 / 12.
// Raising the source limit is safe only once source text leaves projects.json: at 1000 sources of
// the 200k-character per-source maximum the file is ~180 MB and each save ~480 ms (measured for
// #1805). Read per call so a test, or an owner's env change plus restart, takes effect.

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

module.exports = { limits, kindOf, counts, refusal, message, CODE };
