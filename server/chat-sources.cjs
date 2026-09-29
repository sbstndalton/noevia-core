'use strict';
// The sources a project reply was grounded in (#552): what retrieval actually placed in the prompt,
// shaped for the browser. Only names of files the caller passes in (the tenant-scoped project's own
// sources) can appear, snippets are short, and nothing here carries a whole document.

const MAX_SOURCES = 12;
const SNIPPET_MAX = 200;
const NAME_MAX = 300;

function snippetOf(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_MAX ? flat.slice(0, SNIPPET_MAX - 1).trimEnd() + '…' : flat;
}

function shape(id, file, body, kind, score) {
  const item = { id: String(id || file).slice(0, NAME_MAX), file: String(file).slice(0, NAME_MAX), snippet: snippetOf(body), kind: kind === 'excerpt' ? 'excerpt' : 'file' };
  if (typeof score === 'number' && Number.isFinite(score)) item.score = Math.round(score * 1000) / 1000;
  return item;
}

// entries: [{ file, body, score?, kind: 'excerpt' | 'file' }] in prompt order.
// files: the project files this chat may read (already tenant-scoped and skill-filtered).
function buildSources(entries, files) {
  const byName = new Map((Array.isArray(files) ? files : []).filter((f) => f && typeof f.name === 'string').map((f) => [f.name, f]));
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (out.length >= MAX_SOURCES) break;
    const f = e && byName.get(e.file);
    if (!f) continue;
    out.push(shape(f.attachment && f.attachment.id, f.name, e.body, e.kind, e.score));
  }
  return out;
}

// A transcript save may carry `sources` on an assistant turn. It is client-supplied, so it is
// re-bounded here; anything that is not the exact shape is dropped rather than stored.
function sanitizeStored(list) {
  if (!Array.isArray(list)) return undefined;
  const out = [];
  for (const s of list) {
    if (out.length >= MAX_SOURCES) break;
    if (!s || typeof s.file !== 'string' || !s.file) continue;
    out.push(shape(typeof s.id === 'string' ? s.id : '', s.file, s.snippet, s.kind, s.score));
  }
  return out.length ? out : undefined;
}

function sanitizeHistory(history) {
  return history.map((m) => {
    if (!m || typeof m !== 'object' || !('sources' in m)) return m;
    const { sources, ...rest } = m;
    const clean = m.role === 'assistant' ? sanitizeStored(sources) : undefined;
    return clean ? { ...rest, sources: clean } : rest;
  });
}

module.exports = { MAX_SOURCES, SNIPPET_MAX, buildSources, sanitizeStored, sanitizeHistory };
