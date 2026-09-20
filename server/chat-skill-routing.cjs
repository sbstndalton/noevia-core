'use strict';
// Skill auto-loading (user request, 2026-09-19). Enabled skills already reach every message as
// an index of names and descriptions, and the model is meant to fetch a body with
// read_project_file. Small local models often skip that step, so when one message clearly
// matches one skill's description, its reviewed body is placed in the prompt directly.
// It only ever loads a skill the user enabled (the snapshot pinned for this exchange), never
// more than MAX_SKILLS, and any doubt (flag off, embeddings down, no clear match) loads none,
// which is exactly the old behaviour.
const crypto = require('node:crypto');
const MESSAGE_CHARS = 2000;
const MAX_SKILLS = 1;
const MAX_BODY_CHARS = 12000;

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
const skillText = (s) => `${s.name}: ${s.description}`.slice(0, 1000);

function createChatSkillRouter({ enabled, embed, threshold = 0.5, margin = 0.03, cacheMax = 200 }) {
  const cache = new Map();
  async function select(skills, message) {
    const rows = (Array.isArray(skills) ? skills : []).filter((s) => s && s.valid !== false && s.content && s.description);
    if (!enabled() || !rows.length || !String(message || '').trim()) return { loaded: [], reason: 'off or nothing to load' };
    let taskEmbedding, vectors;
    try {
      const keyed = rows.map((s) => ({ s, key: crypto.createHash('sha256').update(skillText(s)).digest('hex') }));
      const missing = keyed.filter((r) => !cache.has(r.key));
      if (missing.length) {
        const out = await embed(missing.map((r) => skillText(r.s)));
        missing.forEach((r, i) => cache.set(r.key, out[i]));
        while (cache.size > cacheMax) cache.delete(cache.keys().next().value);
      }
      vectors = keyed.map((r) => cache.get(r.key));
      [taskEmbedding] = await embed([String(message).slice(0, MESSAGE_CHARS)]);
    } catch (error) {
      return { loaded: [], reason: `embeddings unavailable: ${error.message}` };
    }
    const ranked = rows.map((s, i) => ({ s, score: Array.isArray(vectors[i]) && Array.isArray(taskEmbedding) ? cosine(vectors[i], taskEmbedding) : 0 }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best || best.score < threshold) return { loaded: [], reason: 'no skill matched' };
    // Two skills nearly tied: the message is ambiguous, so leave the choice to the model.
    if (ranked[1] && best.score - ranked[1].score < margin) return { loaded: [], reason: 'ambiguous match' };
    return { loaded: ranked.slice(0, MAX_SKILLS).filter((r) => r.score >= threshold).map((r) => r.s), reason: 'matched', scores: ranked.map((r) => [r.s.file, Math.round(r.score * 1000) / 1000]) };
  }
  return { select };
}

/** The prompt block for auto-loaded skills: bounded, and labelled as the user's reviewed instructions. */
function skillBlock(skills) {
  return skills.map((s) => {
    const body = String(s.content).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    const cut = body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n\n(Truncated; read ${s.file} with read_project_file for the rest.)` : body;
    return `Skill "${s.name}" (${s.file}) matches this message; follow it:\n${cut}`;
  }).join('\n\n');
}

module.exports = { createChatSkillRouter, skillBlock, cosine };
