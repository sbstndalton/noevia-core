'use strict';
// #1726: multimodal RAG. Every image a project holds is embedded once, into the same vector space as
// its text (the active embedding model with its image projector), so a text question finds an image by
// what it shows. What the chat model then gets for a retrieved image is decided per answer:
//
//   cloud route (an external provider)  nothing derived from the image: its name only. Rule 3 of
//                                        provider-egress.cjs (project images are never sent to an
//                                        external provider automatically), extended to the text read
//                                        from an image, which the route check never read.
//   local model that can see            the image itself (size-capped), as an image_url part.
//   local model that cannot see         the image's own extracted text (Docling/OCR) when it has some,
//                                        else a caption made ONCE by the Vision role model and cached
//                                        with the image (rag.cjs media_captions), else its file name,
//                                        saying that no Vision model is configured.
//
// Off unless NOEVIA_MULTIMODAL_RAG is on. Off means today's behaviour exactly: no image is embedded,
// image vectors already stored are ignored (never deleted), and every project image rides along with
// the turn as before. Turning it on backfills image vectors for existing sources (createMediaBackfill),
// one image at a time with a pause between, so it never starves search of the embeddings server.
//
// What counts as an image here:
//   - an image source (png, jpg, webp, gif; uploads.cjs keeps it as a project asset), always;
//   - a figure Docling returned from a document (documents.cjs, document-sources.cjs), EXCEPT on a
//     scanned page: a page whose text came from OCR is embedded as text only. The marker is the page's
//     own extraction record: `ocr: true` (Docling: the page had no text layer, so its words are OCR) or
//     status 'ocr' / method 'native+ocr' (the native PDF reader's OCR pass).
//
// Later modalities (audio, video) go into MODALITIES: the content part llama.cpp takes for them, and the
// source types they come from. Every row already carries `kind`, so nothing else changes shape.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FLAG = 'NOEVIA_MULTIMODAL_RAG';

/** Whether multimodal RAG is on. Read on every call, so a test (or a restart with the env) flips it. */
function enabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env[FLAG] ?? '').trim());
}

// The one modality switch. `part(mime, bytes)` is the content part the embeddings server and the chat
// model take for that medium (llama.cpp /v1/embeddings and /v1/chat/completions share them).
const MODALITIES = Object.freeze({
  image: Object.freeze({
    kind: 'image',
    mimes: Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }),
    // An image above this is stored but never embedded or sent (uploads.cjs keeps the same 8 MB limit).
    maxBytes: 8 * 1024 * 1024,
    part: (mime, bytes) => ({ type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } }),
  }),
  // audio: { kind: 'audio', part: (mime, bytes) => ({ type: 'input_audio', input_audio: { data, format } }) }  (not yet)
  // video: { kind: 'video', part: ... input_video ... }                                                     (not yet)
});

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const FIGURE_FILE = /^[0-9a-f]{64}\.fig\d{1,3}\.(png|jpg|webp)$/;
const FIGURE_MIMES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' });

/** True for a page whose text came from OCR (a scanned page): its figures are never embedded as images. */
function scannedPage(page) {
  if (!page || typeof page !== 'object') return false;
  return page.ocr === true || page.status === 'ocr' || /\bocr\b/.test(String(page.method || ''));
}

function baseName(name) { return String(name || '').split('/').pop(); }

/**
 * Every image of `project` that should have an image vector, for rag.syncProjectMedia:
 *   [{ file, hash, label, meta, part() }]
 * `file` is the project source it belongs to (so deleting the source deletes its rows), `hash` is
 * 'img:' + sha256 of the bytes. `part()` reads the bytes only when the image is actually embedded.
 * `documentDir(projectId)` is document-sources.cjs directory() for this workspace.
 */
function mediaItems(workspace, project, { documentDir, fsImpl = fs } = {}) {
  const out = [];
  const files = new Map((project?.files || []).filter((f) => f && typeof f.name === 'string').map((f) => [f.name, f]));
  // Image sources.
  for (const asset of Array.isArray(project?.assets) ? project.assets : []) {
    if (!asset || typeof asset.id !== 'string' || !/^img-[0-9a-f]{1,64}$/.test(asset.id)) continue;
    const file = typeof asset.sourceName === 'string' ? asset.sourceName : asset.name;
    if (!files.has(file)) continue;
    const mime = Object.values(MODALITIES.image.mimes).includes(asset.mime) ? asset.mime : null;
    if (!mime) continue;
    const byteHash = files.get(file).attachment?.id;
    if (!/^[0-9a-f]{64}$/.test(String(byteHash || ''))) continue;
    if (Number(asset.bytes) > MODALITIES.image.maxBytes) continue;
    const full = path.join(workspace.assetDir(project.id), asset.id);
    out.push({ file, hash: `img:${byteHash}`, label: `Image ${baseName(asset.name)}`, meta: { source: file, assetId: asset.id, name: asset.name, mime },
      part: () => { const bytes = fsImpl.readFileSync(full); return bytes.length <= MODALITIES.image.maxBytes ? MODALITIES.image.part(mime, bytes) : null; } });
  }
  // Figures Docling returned from documents, never from a scanned page.
  if (typeof documentDir === 'function') {
    for (const f of files.values()) {
      const version = f.document?.availableVersion;
      if (!/^[0-9a-f]{64}$/.test(String(version || ''))) continue;
      if (Object.keys(MODALITIES.image.mimes).some((ext) => f.name.toLowerCase().endsWith(ext))) continue; // an image file is its own asset
      let record;
      try { record = JSON.parse(fsImpl.readFileSync(path.join(documentDir(project.id), `${version}.json`), 'utf8')); } catch { continue; }
      const figures = Array.isArray(record?.figures) ? record.figures : [];
      if (!figures.length) continue;
      const pages = new Map((Array.isArray(record.pageTexts) ? record.pageTexts : []).map((p) => [Number(p?.number), p]));
      for (const fig of figures) {
        if (!fig || !FIGURE_FILE.test(String(fig.file || '')) || !/^[0-9a-f]{64}$/.test(String(fig.hash || ''))) continue;
        if (!String(fig.file).startsWith(`${version}.`)) continue;
        if (scannedPage(pages.get(Number(fig.page)))) continue;
        const mime = FIGURE_MIMES[String(fig.file).split('.').pop()];
        const caption = typeof fig.caption === 'string' ? fig.caption.slice(0, 300) : '';
        const full = path.join(documentDir(project.id), fig.file);
        out.push({ file: f.name, hash: `img:${fig.hash}`,
          label: `Figure ${Number(fig.index) + 1} on page ${Number(fig.page)} of ${baseName(f.name)}${caption ? `: ${caption}` : ''}`,
          meta: { source: f.name, page: Number(fig.page), figure: Number(fig.index) + 1, version, figureFile: fig.file, mime, ...(caption ? { caption } : {}),
            ...(typeof fig.text === 'string' && fig.text.trim() ? { text: fig.text.slice(0, 4000) } : {}) },
          part: () => { const bytes = fsImpl.readFileSync(full); return bytes.length <= MODALITIES.image.maxBytes ? MODALITIES.image.part(mime, bytes) : null; } });
      }
    }
  }
  return out;
}

/**
 * A retrieved image hit (rag.searchProjectWithImages) resolved against the project as it is NOW:
 * { name, mime, hash, assetId?, bytes(), text } or null when its source is gone or has changed.
 * `text` is what was read from the image itself (Docling/OCR), when anything was.
 */
function resolveHit(workspace, project, hit, { documentDir, fsImpl = fs } = {}) {
  const meta = hit?.meta || {};
  const file = (project?.files || []).find((f) => f && f.name === hit?.file);
  if (!file) return null;
  if (meta.assetId) {
    const asset = (project.assets || []).find((a) => a && a.id === meta.assetId);
    if (!asset || `img:${file.attachment?.id}` !== hit.hash) return null;
    const full = path.join(workspace.assetDir(project.id), asset.id);
    return { name: asset.name || baseName(file.name), file: file.name, mime: asset.mime, hash: hit.hash, assetId: asset.id, score: hit.score,
      bytes: () => fsImpl.readFileSync(full), text: String(file.content || '').trim() };
  }
  if (meta.figureFile && typeof documentDir === 'function') {
    if (!FIGURE_FILE.test(meta.figureFile) || file.document?.availableVersion !== meta.version) return null;
    const full = path.join(documentDir(project.id), meta.figureFile);
    return { name: `${baseName(file.name)} page ${meta.page} figure ${meta.figure}`, file: file.name, mime: meta.mime, hash: hit.hash, score: hit.score,
      bytes: () => fsImpl.readFileSync(full), text: [meta.caption, meta.text].filter((t) => typeof t === 'string' && t.trim()).join('\n').trim() };
  }
  return null;
}

/**
 * Which project images ride along with this turn the pre-#1726 way, given what retrieval saw.
 * An image retrieval can see (it has a vector) is sent only when retrieved; one it cannot see yet (no
 * vector: the backfill has not reached it, or embedding is off) keeps today's behaviour and rides along.
 *   returns { rideAlong: Set(asset ids), retrieved: Set(asset ids), indexed: Set(asset ids) }
 */
function assetPlan(assets, { hits = [], indexed = [] } = {}) {
  const seen = new Set(indexed.map((h) => h?.meta?.assetId).filter(Boolean));
  const retrieved = new Set(hits.map((h) => h?.meta?.assetId).filter(Boolean));
  const rideAlong = new Set((assets || []).filter((a) => a && !seen.has(a.id)).map((a) => a.id));
  return { rideAlong, retrieved, indexed: seen };
}

// One caption per image, generated at most once at a time per (tenant, project, image): a second
// request for the same image while the first runs waits for it.
const captionsInFlight = new Map();
/**
 * The cached caption for an image, or a new one made by `generate()` and stored with `write`.
 * read() -> { caption, model } | null; generate() -> { caption, model } | null; write(caption, model).
 */
async function captionOnce(key, { read, generate, write }) {
  const cached = read();
  if (cached && cached.caption) return cached;
  if (captionsInFlight.has(key)) return captionsInFlight.get(key);
  const p = (async () => {
    const made = await generate();
    if (made && typeof made.caption === 'string' && made.caption.trim()) {
      try { write(made.caption.trim(), made.model || null); } catch { /* an unstored caption is still used for this answer */ }
      return { caption: made.caption.trim(), model: made.model || null };
    }
    return null;
  })().finally(() => captionsInFlight.delete(key));
  captionsInFlight.set(key, p);
  return p;
}

/**
 * What the chat model gets for the retrieved images of this turn.
 *   images      resolved hits (resolveHit), best first
 *   external    the answer goes to an external (cloud) provider: decided by core from the provider
 *               the route resolved to, never by anything the client sent
 *   canSee()    async: whether the answering model reads images (vision probe); called only when needed
 *   caption(i)  async: { caption, model } | null for an image with no text of its own (captionOnce)
 *   hasVisionRole  whether a Vision role model is configured (only changes the wording)
 *   frame(kind, label, text)  prompt-framing.cjs frameUntrusted
 * Returns { parts, notes, warning, sent: names }: `parts` are image_url parts for the last user message,
 * `notes` are system-prompt blocks, `warning` is what the user is told (empty when nothing to say).
 */
async function answerImages({ images, external, providerLabel = 'an external provider', canSee, caption, hasVisionRole, frame,
  maxImages = 3, maxTotalBytes = 16 * 1024 * 1024 }) {
  const list = (images || []).filter(Boolean);
  const out = { parts: [], notes: [], warning: '', sent: [] };
  if (!list.length) return out;
  const names = list.map((i) => i.name);
  if (external) {
    out.notes.push(`Images in this project look relevant to this message (${names.map((n) => JSON.stringify(n)).join(', ')}) but were not sent: images, and text read from them, are never sent to ${providerLabel} automatically. Say so if asked about them; do not guess at their contents.`);
    out.warning = `Relevant project images were not sent: images are never sent to ${providerLabel} automatically.`;
    return out;
  }
  let seeing = false;
  try { seeing = !!(await canSee()); } catch { seeing = false; }
  const asText = [];
  let budget = maxTotalBytes;
  for (const image of list) {
    if (seeing && out.parts.length < maxImages) {
      let bytes = null;
      try { bytes = image.bytes(); } catch { bytes = null; }
      if (bytes && bytes.length <= MODALITIES.image.maxBytes && bytes.length <= budget && MODALITIES.image.mimes && Object.values(MODALITIES.image.mimes).includes(image.mime)) {
        budget -= bytes.length;
        out.parts.push(MODALITIES.image.part(image.mime, bytes));
        out.sent.push(image.name);
        continue;
      }
    }
    asText.push(image);
  }
  const nameOnly = [];
  for (const image of asText) {
    if (image.text) { out.notes.push(frame('image text', image.name, image.text.slice(0, 8000))); continue; }
    let made = null;
    try { made = await caption(image); } catch { made = null; }
    if (made && made.caption) { out.notes.push(frame('image caption', made.model ? `${image.name} (caption by ${made.model})` : image.name, made.caption)); continue; }
    nameOnly.push(image.name);
  }
  if (nameOnly.length) {
    const why = hasVisionRole ? 'the Vision model could not caption them' : 'no Vision model is configured to caption them';
    out.notes.push(`Images in this project look relevant to this message (${nameOnly.map((n) => JSON.stringify(n)).join(', ')}), but only their file names are known: the answering model cannot see images and ${why}. Say so if asked about them; do not guess at their contents.`);
    out.warning = `Only the file names of ${nameOnly.length === 1 ? 'a relevant image' : 'relevant images'} were used: ${why}.`;
  }
  return out;
}

/**
 * The rate-limited backfill and upkeep of image vectors (#1726 item 6). One worker per process; each
 * pass walks every active account's projects (each project's index stays in that account's own data
 * directory: nothing crosses tenants) and, per project, reconciles its image rows and embeds the missing
 * ones ONE image per request, sleeping `intervalMs` between requests. A failure (no projector, server
 * down) ends the pass and retries after `retryMs`. Off (the flag), it does nothing at all, and image
 * vectors already stored stay where they are.
 *
 * deps: enabled(), userIds(), workspaceFor(userId) -> { projects, assetDir, ... } | null,
 *       documentDir(workspace, projectId), rag ({ syncProjectMedia }), sleep(ms), log(line), env,
 *       paused() -> reason | null (a re-index is under way: the embeddings router already serves two
 *       models, its limit, so no image preset is loaded beside them), release() after a pass that
 *       embedded images (unloads the image preset, so the projector is held only while it is used).
 */
function createMediaBackfill({ enabled: on = () => enabled(), userIds, workspaceFor, documentDir, rag, paused = () => null, release = async () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (line) => console.info(line), env = process.env, setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimer = clearTimeout } = {}) {
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
  const intervalMs = num(env.NOEVIA_MULTIMODAL_RAG_INTERVAL_MS, 2000, 0, 600000);
  const retryMs = num(env.NOEVIA_MULTIMODAL_RAG_RETRY_MS, 300000, 1000, 86400000);
  let running = null;
  let again = false;
  let retry = null;
  let stopped = false;
  let last = null; // { at, embedded, pending, reason }
  const priority = []; // [userId, projectId] scheduled ahead of the full walk

  async function syncProject(userId, workspace, project, totals) {
    const items = mediaItems(workspace, project, { documentDir: (id) => documentDir(workspace, id) });
    for (;;) {
      if (stopped || !on()) return false;
      const r = await rag.syncProjectMedia(project.id, userId, items, { limit: 1 });
      totals.embedded += r.embedded || 0;
      if (!r.ok) {
        if (r.reason === 'embed-failed' || r.reason === 'no-image-projector' || r.reason === 'embedding-off') { totals.reason = r.reason; totals.error = r.error; totals.pending += r.pending || 0; return 'stop'; }
        return true; // index unavailable or a profile without images: nothing to do here
      }
      if (!r.pending || !r.embedded) { totals.pending += r.pending || 0; return true; }
      // Rate limit: one image per request, then a pause before the next request.
      await sleep(intervalMs);
    }
  }

  async function pass() {
    const totals = { embedded: 0, pending: 0, reason: null, error: null };
    let hold = null;
    try { hold = paused(); } catch { hold = null; }
    if (hold) { totals.reason = String(hold); last = { at: Date.now(), ...totals }; return totals; }
    const visited = new Set();
    const order = [];
    while (priority.length) order.push(priority.shift());
    let ids = [];
    try { ids = userIds() || []; } catch { ids = []; }
    for (const userId of ids) order.push([userId, null]);
    for (const [userId, onlyProject] of order) {
      if (stopped || !on()) break;
      let workspace = null;
      try { workspace = workspaceFor(userId); } catch { workspace = null; }
      if (!workspace || workspace.revoked) continue;
      for (const project of Array.isArray(workspace.projects) ? workspace.projects : []) {
        if (!project || typeof project.id !== 'string') continue;
        if (onlyProject && project.id !== onlyProject) continue;
        const key = JSON.stringify([userId, project.id]);
        if (visited.has(key)) continue;
        visited.add(key);
        const r = await syncProject(userId, workspace, project, totals);
        if (r === 'stop') { last = { at: Date.now(), ...totals }; return totals; }
        if (r === false) break;
      }
    }
    last = { at: Date.now(), ...totals };
    if (totals.embedded) { try { await release(); } catch { /* the router unloads it on its own later */ } }
    return totals;
  }

  function kick() {
    if (stopped || !on()) return null;
    if (running) { again = true; return running; }
    if (retry) { clearTimer(retry); retry = null; }
    running = (async () => {
      try {
        const totals = await pass();
        if (totals.reason) {
          log(`[media] image backfill paused (${totals.reason}${totals.error ? `: ${totals.error}` : ''}); ${totals.pending} image(s) wait, retrying in ${Math.round(retryMs / 1000)} s`);
          retry = setTimer(() => { retry = null; kick(); }, retryMs);
        } else if (totals.embedded) log(`[media] embedded ${totals.embedded} image(s)`);
      } catch (err) {
        log(`[media] image backfill failed: ${String(err?.message || err).slice(0, 200)}`);
      } finally {
        running = null;
        if (again && !stopped) { again = false; kick(); }
      }
    })();
    return running;
  }

  return {
    kick,
    /** A project's sources changed: put it first in the next pass. */
    schedule(userId, projectId) {
      if (stopped || !on()) return null;
      priority.push([userId, projectId]);
      return kick();
    },
    status: () => ({ enabled: on(), running: !!running, last }),
    idle: () => running || Promise.resolve(),
    stop() { stopped = true; if (retry) clearTimer(retry); retry = null; },
  };
}

let installed = null;
function install(backfill) { installed = backfill; return backfill; }
function current() { return installed; }
/** projects.cjs calls this after a source is (re)indexed or removed. No-op with the flag off. */
function sourceChanged(userId, projectId) {
  if (!enabled() || !installed || !userId) return;
  try { installed.schedule(userId, projectId); } catch { /* never breaks the caller */ }
}

module.exports = { FLAG, MODALITIES, enabled, scannedPage, mediaItems, resolveHit, assetPlan, captionOnce, answerImages, createMediaBackfill, install, current, sourceChanged, sha256 };
