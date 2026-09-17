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

/**
 * @param {{ enabled: () => boolean, boxes: () => object[], embed: (texts: string[]) => Promise<number[][]>,
 *           topK?: number, threshold?: number, cacheMax?: number }} deps
 */
function createChatToolRouter({ enabled, boxes, embed, topK = 3, threshold = 0.35, cacheMax = 200 }) {
  const cache = new Map(); // sha256(box text) -> embedding

  async function boxEmbeddings(rows) {
    const keyed = rows.map((box) => ({ box, key: crypto.createHash('sha256').update(boxText(box)).digest('hex') }));
    const missing = keyed.filter((row) => !cache.has(row.key));
    if (missing.length) {
      const vectors = await embed(missing.map((row) => boxText(row.box)));
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
      [taskEmbedding] = await embed([String(message || '').slice(0, MESSAGE_CHARS)]);
    } catch (error) {
      return keep(`embeddings unavailable: ${error.message}`);
    }
    const inSelection = new Set(rows.map((box) => box.id));
    const result = route({ boxes: ranked, taskEmbedding, offered: (id) => inSelection.has(id), userSelection: [], fallback: [...inSelection], maxTools: Infinity, topK, threshold });
    if (!result.routed || !result.boxes.length) return keep('no toolbox matched');
    const chosen = new Set(result.boxes);
    return { ids: rows.map((box) => box.id).filter((id) => chosen.has(id)), routed: true, reasons: result.reasons };
  }

  return { select };
}

module.exports = { createChatToolRouter, boxText };
