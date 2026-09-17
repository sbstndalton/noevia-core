'use strict';
// Task-conditional toolbox selection, decided BEFORE the first model call with no
// extra model round. Pure: the caller supplies embeddings. Not wired into chat
// until the router variant in experiments/tool-routing passes its measurement gate.

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Transitive `requires`, or null when a dependency is missing or not loadable.
function closure(id, byId, eligible, seen = new Set()) {
  if (seen.has(id)) return seen;
  const box = byId.get(id);
  if (!box || !eligible(box)) return null;
  seen.add(id);
  for (const dep of box.requires || []) if (!closure(dep, byId, eligible, seen)) return null;
  return seen;
}

/**
 * @param {object} input
 * @param {{id:string,tools:string[],autoLoad?:'allowed'|'never',requires?:string[],embedding?:number[]}[]} input.boxes manifest rows with precomputed embeddings of description + examples
 * @param {number[]|null} input.taskEmbedding null when embeddings are unavailable
 * @param {(id:string)=>boolean} input.offered deployment ceiling (toolboxOffered)
 * @param {string[]} input.userSelection boxes the user chose; always kept, never removed by routing
 * @param {string[]} input.fallback today's project selection, used when routing cannot run
 * @param {number} input.maxTools tool cap for the model (toolCapFor)
 * @param {number} [input.topK=3] @param {number} [input.threshold=0.35]
 */
function route({ boxes, taskEmbedding, offered, userSelection = [], fallback = [], maxTools, topK = 3, threshold = 0.35 }) {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const toolsOf = (ids) => [...ids].flatMap((id) => byId.get(id)?.tools || []);
  const chosen = new Set(userSelection.filter((id) => byId.has(id) && offered(id)));
  const reasons = Object.fromEntries([...chosen].map((id) => [id, 'selected by you']));
  const skipped = [];
  if (!Array.isArray(taskEmbedding) || !taskEmbedding.length) {
    for (const id of fallback) if (byId.has(id) && offered(id) && !chosen.has(id)) { chosen.add(id); reasons[id] = 'project selection (router unavailable)'; }
    return { boxes: [...chosen], reasons, skipped, routed: false };
  }
  const eligible = (box) => offered(box.id) && box.autoLoad !== 'never';
  const ranked = boxes
    .filter((box) => eligible(box) && !chosen.has(box.id) && Array.isArray(box.embedding))
    .map((box) => ({ id: box.id, score: cosine(taskEmbedding, box.embedding) }))
    .filter((row) => row.score >= threshold)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, topK);
  for (const { id, score } of ranked) {
    const group = closure(id, byId, eligible);
    if (!group) { skipped.push({ id, reason: 'a required toolbox is unavailable' }); continue; }
    const adding = [...group].filter((x) => !chosen.has(x));
    const current = new Set(toolsOf(chosen));
    // Never load two boxes exposing the same tool name; the higher-scoring one is already in.
    if (toolsOf(adding).some((name) => current.has(name))) { skipped.push({ id, reason: 'duplicates a loaded tool name' }); continue; }
    // Whole boxes only: if the closure would break the cap, load nothing extra.
    if (current.size + toolsOf(adding).length > maxTools) { skipped.push({ id, reason: 'would exceed the tool cap' }); continue; }
    for (const x of adding) { chosen.add(x); reasons[x] = x === id ? `matched this task (${score.toFixed(2)})` : `required by ${id}`; }
  }
  return { boxes: [...chosen], reasons, skipped, routed: true };
}

module.exports = { route, cosine };
