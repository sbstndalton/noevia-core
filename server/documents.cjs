'use strict';

// Turning a document into text for a project source.
//
// A project source is text: that is what a chat can read, and what RAG can
// chunk and retrieve. A PDF is not text, so it is converted at ingest rather
// than being stored as bytes nobody can use — which also means it works
// identically whether it arrived by upload or through a folder sync.
//
// Extraction is not OCR. A scanned page carries no text layer, so it yields
// nothing; that is reported rather than stored as an empty source that looks
// like a file which failed to attach.

const EXTRACT_CAP = 200_000; // matches the stored-source cap

const DOCUMENT_EXTENSIONS = new Set(['.pdf']);

function isDocument(name) {
  const dot = String(name || '').lastIndexOf('.');
  return dot !== -1 && DOCUMENT_EXTENSIONS.has(String(name).slice(dot).toLowerCase());
}

/** Extract a PDF's text layer. Returns { text, pages, truncated }. */
async function extractPdfText(bytes) {
  // Required lazily: unpdf pulls in pdf.js, which is large and is not needed
  // by a deployment that never attaches a document.
  const { extractText, getDocumentProxy } = require('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  const joined = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!joined) {
    throw Object.assign(
      new Error('no text layer — a scanned PDF needs OCR, which noevia does not do'),
      { status: 422 },
    );
  }
  return {
    text: joined.slice(0, EXTRACT_CAP),
    pages: totalPages,
    truncated: joined.length > EXTRACT_CAP,
  };
}

/** Extract whatever this document type yields, by name. */
async function extractDocumentText(name, bytes) {
  const dot = String(name || '').lastIndexOf('.');
  const ext = dot === -1 ? '' : String(name).slice(dot).toLowerCase();
  if (ext === '.pdf') return extractPdfText(bytes);
  throw Object.assign(new Error(`${ext || 'that file'} is not a supported document`), { status: 400 });
}

module.exports = { isDocument, extractDocumentText, DOCUMENT_EXTENSIONS, EXTRACT_CAP };
