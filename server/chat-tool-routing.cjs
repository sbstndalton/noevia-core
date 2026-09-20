'use strict';
// Task-conditional tool loading for chat (roadmap E). Before the first model call, one embedding
// of the message ranks the project's OWN selected toolboxes and only the matching ones are sent.
// It only narrows: a box the project did not select is never added, so routing can never offer a
// write the user did not already allow. Any doubt (flag off, one box, embeddings down, nothing
// clears the threshold) keeps the whole selection. Gate evidence:
// experiments/tool-routing/README.md § Router variant, measured 2026-09-17.
const crypto = require('node:crypto');
const { route } = require('./tool-router.cjs');

const MESSAGE_CHARS = 2000;

function boxText(box) {
  const tools = (box.tools || []).map((t) => `${t.function?.name}: ${t.function?.description || ''}`).join('\n');
  return `${box.label || box.id}: ${box.description || ''}\n${tools}`.slice(0, 4000);
}

// The embedder sits on the chat's critical path: both calls below are awaited
// BEFORE the first model call, so a wedged embedder is a wedged chat. The
// fail-open contract above only covers a throw, never a hang — so give the
// hang a deadline and let it take the same path as any other failure.
//
// It belongs here rather than in rag.embed, whose other caller is indexing:
// a long embed is correct there and fatal here.
const EMBED_TIMEOUT_MS = 5000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * @param {{ enabled: () => boolean, boxes: () => object[], embed: (texts: string[]) => Promise<number[][]>,
 *           embedModel?: () => string, topK?: number, threshold?: number, cacheMax?: number,
 *           timeoutMs?: number }} deps
 */
function createChatToolRouter({ enabled, boxes, embed, embedModel = () => '', topK = 3, threshold = 0.35, cacheMax = 200, timeoutMs = EMBED_TIMEOUT_MS }) {
  const cache = new Map(); // sha256(model + box text) -> embedding

  async function boxEmbeddings(rows) {
    // The model is part of the key. Without it, changing EMBEDDING_MODEL keeps
    // serving vectors of the old dimensionality, and cosine() silently
    // truncates to the shorter of the two and returns a meaningless score
    // instead of failing.
    const keyed = rows.map((box) => ({ box, key: crypto.createHash('sha256').update(`${embedModel()}\u0000${boxText(box)}`).digest('hex') }));
    const missing = keyed.filter((row) => !cache.has(row.key));
    if (missing.length) {
      const vectors = await withTimeout(embed(missing.map((row) => boxText(row.box))), timeoutMs, 'toolbox embedding');
      missing.forEach((row, i) => cache.set(row.key, vectors[i]));
      while (cache.size > cacheMax) cache.delete(cache.keys().next().value);
    }
    return keyed.map(({ box, key }) => ({ id: box.id, tools: (box.tools || []).map((t) => t.function?.name), embedding: cache.get(key) }));
  }

  async function select(selectedIds, message) {
    const selected = Array.isArray(selectedIds) ? selectedIds : [];
    const keep = (reason) => ({ ids: selected, routed: false, reason });
    if (!enabled()) return keep('off');
    const available = new Map(boxes().map((box) => [box.id, box]));
    const rows = selected.filter((id) => available.has(id)).map((id) => available.get(id));
    if (rows.length <= 1) return keep('nothing to narrow');
    let ranked, taskEmbedding;
    try {
      ranked = await boxEmbeddings(rows);
      [taskEmbedding] = await withTimeout(embed([String(message || '').slice(0, MESSAGE_CHARS)]), timeoutMs, 'message embedding');
    } catch (error) {
      return keep(`embeddings unavailable: ${error.message}`);
    }
    const inSelection = new Set(rows.map((box) => box.id));
    const result = route({ boxes: ranked, taskEmbedding, offered: (id) => inSelection.has(id), userSelection: [], fallback: [...inSelection], maxTools: Infinity, topK, threshold });
    if (!result.routed || !result.boxes.length) return keep('no toolbox matched');
    // Best match first: resolveTools spends the tool budget in this order, so a large box the user
    // happened to select earlier must not crowd out the box that matched the message.
    return { ids: result.boxes.filter((id) => inSelection.has(id)), routed: true, reasons: result.reasons };
  }

  return { select };
}

module.exports = { createChatToolRouter, boxText };
