// Project-scoped RAG index (feature doc Item 8 / master step 10).
//
// Technique mirrors diary-companion/agent/retrieval.py (sqlite-vec + an
// OpenAI-compatible /embeddings call), but is deliberately a separate store:
// one sqlite file per project under <DATA_DIR>/rag/<projectId>.db. No shared
// index, no dependency on the diary sidecar being alive, and its index.db is
// never touched.
//
// Native deps load lazily and optionally: if either is missing, indexing and
// search no-op and chat falls back to small-file direct injection — the server
// must never fail to boot because of RAG.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { notice: documentNotice } = require('./document-sources.cjs');

// Injected by init() from index.cjs (keeps this module testable standalone).
let RAG_DIR = null;
let EMBED_MODEL = 'default';
let inferenceBase = null;
let inferenceHeaders = () => ({ 'Content-Type': 'application/json' });
let dataDirForUser = null;

function init({ dataDir, embedModel, inferenceUrl, headersFn, userDataDirFn }) {
  RAG_DIR = process.env.RAG_DIR || path.join(dataDir, 'rag');
  dataDirForUser = userDataDirFn || null;
  EMBED_MODEL = process.env.EMBEDDING_MODEL || process.env.EMBED_MODEL || embedModel || EMBED_MODEL;
  inferenceBase = inferenceUrl;
  if (headersFn) inferenceHeaders = headersFn;
}
// Chunk sizing starts from diary-companion's shape (subsection-scale bodies).
// ~1200 chars with a 150-char overlap keeps chunks coherent.
const CHUNK_SIZE = 1200;
const CHUNK_STRIDE = 150;
// Files at or under this size skip embedding entirely and inject verbatim —
// a two-sentence file must not round-trip an embedding call.
const DIRECT_INJECT_MAX = 2400;
const TOP_K = 6;
const MIN_SCORE = 0.3;

let depsCache = null;
function loadDeps() {
  if (depsCache) return depsCache;
  try {
    const Database = require('better-sqlite3');
    const sqliteVec = require('sqlite-vec');
    depsCache = { Database, sqliteVec };
  } catch (err) {
    console.warn(`[rag] deps unavailable (${err.message}) — project RAG disabled, chat unaffected`);
    depsCache = { broken: true };
  }
  return depsCache;
}

function ragAvailable() {
  return !loadDeps().broken;
}

function chunkText(text, pagePart = false) {
  if (!pagePart && /^\[Page \d+\]/.test(String(text))) {
    return String(text).split(/(?=\[Page \d+\]\n)/).filter(Boolean).flatMap(part => {
      const marker = part.match(/^\[Page \d+\]/)?.[0] || '';
      return chunkText(part.slice(marker.length), true).map(chunk => marker + '\n' + chunk);
    });
  }
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_SIZE) return [clean];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);
    if (end < clean.length) {
      // Prefer a paragraph break, then a sentence/line end, in the back half.
      const window = clean.slice(start, end);
      const para = window.lastIndexOf('\n\n');
      if (para > CHUNK_SIZE * 0.5) {
        end = start + para + 1;
      } else {
        let best = -1;
        for (let i = window.length - 1; i >= CHUNK_SIZE * 0.5; i--) {
          if ('.!?\n'.includes(window[i])) { best = i; break; }
        }
        if (best > 0) end = start + best + 1;
      }
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_STRIDE, start + 1);
  }
  return chunks;
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function serializeF32(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

async function embedOnce(texts) {
  const res = await fetch(`${inferenceBase.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/embeddings`, {
    method: 'POST',
    headers: inferenceHeaders(),
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const body = await res.json();
  return Array.isArray(body?.data) ? body.data : [];
}

async function embed(texts) {
  if (!texts.length) return [];
  if (texts.length === 1) {
    const items = await embedOnce(texts);
    if (items.length !== 1 || !items[0]?.embedding) throw new Error('embeddings returned no vector');
    return [items[0].embedding];
  }
  // Some OpenAI-compatible providers answer a multi-input batch with an empty data array —
  // fall back to one call per text (cheap on local hardware).
  const items = await embedOnce(texts);
  if (items.length === texts.length && items.every((it) => it?.embedding)) {
    return items.map((it) => it.embedding);
  }
  const out = [];
  for (const t of texts) out.push(...(await embed([t])));
  return out;
}

function openIndex(projectId, userId) {
  const { Database, sqliteVec } = loadDeps();
  if (!Database || !sqliteVec) return null;
  try {
    const ragDir = userId && dataDirForUser ? path.join(dataDirForUser(userId), 'rag') : RAG_DIR;
    fs.mkdirSync(ragDir, { recursive: true });
    const db = new Database(path.join(ragDir, `${projectId}.db`));
    db.pragma('journal_mode = WAL');
    sqliteVec.load(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        file TEXT NOT NULL,
        chunk_no INTEGER NOT NULL,
        body TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_file_hash ON chunks(file, content_hash);
      CREATE TABLE IF NOT EXISTS vec_meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    let dim = null;
    const row = db.prepare("SELECT value FROM vec_meta WHERE key='dim'").get();
    if (row) dim = Number(row.value);
    return { db, dim };
  } catch (err) {
    console.warn(`[rag] index unavailable for ${projectId} (${err.message}) — falling back to direct injection`);
    return null;
  }
}

function ensureVecTable(index, dim) {
  index.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${dim}])`);
  index.db.prepare("INSERT OR REPLACE INTO vec_meta (key, value) VALUES ('dim', ?)").run(String(dim));
  index.dim = dim;
}

async function embedBatchAndStore(index, rows) {
  let dim = index.dim;
  let embedded = 0;
  // NOTE: prepare the vec_items statements only AFTER ensureVecTable() has run
  // — better-sqlite3 validates at prepare time and would throw
  // "no such table: vec_items" otherwise. Also, vec0 rejects a *bound*
  // parameter as the primary key, so chunk_id is inlined into the SQL (it is
  // always an integer from our own chunks table — no injection surface).
  let del = index.dim ? index.db.prepare('DELETE FROM vec_items WHERE chunk_id = ?') : null;
  for (let i = 0; i < rows.length; i += 8) {
    const batch = rows.slice(i, i + 8);
    const vectors = await embed(batch.map((r) => r.body));
    if (!dim) {
      dim = vectors[0].length;
      ensureVecTable(index, dim);
      del = index.db.prepare('DELETE FROM vec_items WHERE chunk_id = ?');
    }
    const tx = index.db.transaction((items) => {
      for (const r of items) {
        del.run(r.id);
        index.db
          .prepare(`INSERT INTO vec_items (chunk_id, embedding) VALUES (${Number(r.id)}, ?)`)
          .run(serializeF32(r.vector));
      }
    });
    tx(batch.map((r, j) => ({ id: r.id, vector: vectors[j] })));
    embedded += batch.length;
  }
  return embedded;
}

// Index (or re-index) one project file. Returns counts for logging; throws on
// hard failures is deliberately avoided — callers log the result.
async function indexProjectFile(projectId, fileName, text, userId) {
  const index = openIndex(projectId, userId);
  if (!index) return { ok: false, reason: 'rag-unavailable' };
  try {
    index.db.prepare('DELETE FROM chunks WHERE file = ?').run(fileName);
    if (text.length <= DIRECT_INJECT_MAX) {
      // Small file: stored for the record, injected directly by handleChat.
      index.db
        .prepare('INSERT INTO chunks (file, chunk_no, body, content_hash) VALUES (?, 0, ?, ?)')
        .run(fileName, text, hash(text));
      return { ok: true, stored: 1, embedded: 0, direct: true };
    }
    const pieces = chunkText(text);
    // Overlapping windows can yield byte-identical chunks (repeated padding /
    // template text), which would violate the (file, content_hash) unique
    // index — dedupe, keeping the first occurrence.
    const seen = new Set();
    const unique = [];
    for (const body of pieces) {
      const h = hash(body);
      if (seen.has(h)) continue;
      seen.add(h);
      unique.push(body);
    }
    const ins = index.db.prepare('INSERT INTO chunks (file, chunk_no, body, content_hash) VALUES (?, ?, ?, ?)');
    const rows = unique.map((body, i) => ({ id: Number(ins.run(fileName, i, body, hash(body)).lastInsertRowid), body }));
    let embedded = 0;
    try {
      embedded = await embedBatchAndStore(index, rows);
    } catch (err) {
      console.warn(`[rag] embedding failed for ${projectId}/${fileName} (${err.message}) — text stored, vectors pending`);
    }
    return { ok: true, stored: rows.length, embedded };
  } finally {
    index.db.close();
  }
}

// Drop one file's chunks (called when a file is removed from a project).
function deleteProjectFile(projectId, fileName, userId) {
  const index = openIndex(projectId, userId);
  if (!index) return;
  try {
    index.db.prepare('DELETE FROM chunks WHERE file = ?').run(fileName);
  } finally {
    index.db.close();
  }
}

// Top-K chunks for a query, this project's index only. Empty array on any
// failure — chat falls back to direct injection of small files.
async function searchProject(projectId, query, userId) {
  const index = openIndex(projectId, userId);
  if (!index || !index.dim) return [];
  try {
    const [qvec] = await embed([query]);
    if (!qvec || qvec.length !== index.dim) return [];
    const qbuf = serializeF32(qvec);
    const rows = index.db
      .prepare(
        `SELECT c.file, c.chunk_no, c.body, 1.0 - vec_distance_cosine(v.embedding, ?) AS score
         FROM vec_items v JOIN chunks c ON c.id = v.chunk_id
         WHERE 1.0 - vec_distance_cosine(v.embedding, ?) >= ?
         ORDER BY score DESC
         LIMIT ?`
      )
      .all(qbuf, qbuf, MIN_SCORE, TOP_K);
    return rows.map((r) => ({ file: r.file, body: r.body, score: Math.round(r.score * 1000) / 1000 }));
  } catch (err) {
    console.warn(`[rag] search failed for ${projectId}: ${err.message}`);
    return [];
  } finally {
    index.db.close();
  }
}

// The files-context for one chat message: retrieved chunks when the index has
// vectors, otherwise the verbatim small files (old behavior, still the path
// for anything <= DIRECT_INJECT_MAX). Never throws.
async function filesContext(projectId, files, query, userId) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const small = files.filter((f) => String(f.content || '').length <= DIRECT_INJECT_MAX);
  const large = files.filter((f) => String(f.content || '').length > DIRECT_INJECT_MAX);

  // Name every source, always. Retrieval injects excerpts of the large files
  // chosen for THIS question, so a question about the sources themselves —
  // "what have you got?", "is my file attached?" — was answered from whatever
  // happened to be retrieved, and looked exactly like a file that had not
  // attached. The manifest costs a few tokens and settles it.
  const manifest = `Sources attached to this project (${files.length}): ${files
    .map((f) => `"${f.name}"`)
    .join(', ')}. Excerpts of the relevant ones follow; ask to read a file in full if you need more of it.`;

  const notices = files.map(documentNotice).filter(Boolean);
  const parts = [];
  if (ragAvailable() && large.length > 0) {
    const hits = await searchProject(projectId, query, userId);
    if (hits.length > 0) {
      for (const h of hits) parts.push(`[from ${h.file}] ${h.body}`);
    }
  }
  if (parts.length === 0) {
    // Fallback: inject small files whole; for big files without vectors, take
    // the head of each so context still carries something useful.
    for (const f of small) parts.push(`File "${f.name}":\n${f.content}`);
    for (const f of large) parts.push(`File "${f.name}" (excerpts):\n${String(f.content).slice(0, 24000)}`);
  } else {
    // Always keep small files present — they are cheap and usually key context.
    for (const f of small) parts.push(`File "${f.name}":\n${f.content}`);
  }
  const coverage = 'Source completeness: ' + (notices.join('\n') || 'Legacy text sources have no page completeness metadata.') + '\nContext may contain excerpts only. Use read_project_file with PDF startPage/endPage and offset for pages beyond the summary. Do not treat missing excerpts or failed/partial sources as evidence of absence.';
  return parts.length ? [manifest, coverage, ...parts].join('\n\n') : [manifest, coverage].join("\n");
}

module.exports = { init, indexProjectFile, deleteProjectFile, searchProject, filesContext, chunkText, ragAvailable };
