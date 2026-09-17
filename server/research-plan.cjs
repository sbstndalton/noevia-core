'use strict';
// Deep research plan step (docs/spec-deep-research.md §3.2, build order §9.4). A model proposes
// 3–7 sub-questions as JSON; the user may edit, delete, add or skip them. The plan is task
// context only: it never adds tools, raises budgets or names other projects.
const { tokens } = require('./chat-context.cjs');

const PLAN_SYSTEM = 'You plan a research investigation. Reply with JSON only: {"subQuestions": ["...", ...]} holding 3 to 7 short, self-contained questions that together answer the user question. No commentary, no tools, no URLs.';
const MAX_ITEMS = 7, MAX_CHARS = 200;

function readable(message, status = 400) { return Object.assign(Error(message), { publicMessage: message, status }); }

/** Normalise a user- or model-supplied list: trimmed, single-line, bounded, de-duplicated. */
function sanitizePlan(list, { min = 1 } = {}) {
  if (!Array.isArray(list)) throw readable('The plan must be a list of questions.');
  const seen = new Set(), out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') throw readable('Each plan item must be text.');
    const q = raw.replace(/\s+/g, ' ').trim();
    if (!q) continue;
    if (q.length > MAX_CHARS) throw readable(`Keep each question under ${MAX_CHARS} characters.`);
    const key = q.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(q); }
  }
  if (out.length < min) throw readable(min === 1 ? 'Add at least one question, or skip planning.' : `The plan needs at least ${min} questions.`);
  if (out.length > MAX_ITEMS) throw readable(`A plan holds at most ${MAX_ITEMS} questions.`);
  return out;
}

function parsePlan(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  let parsed;
  try { parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw); }
  catch { throw readable('The model did not return a usable plan. Try again or skip planning.', 502); }
  return sanitizePlan(parsed?.subQuestions, { min: 3 });
}

function createPlanner({ complete, windowTokens = 16384, replyTokens = 600 }) {
  return {
    async plan(question, { signal } = {}) {
      const q = String(question || '').trim();
      if (!q) throw readable('Write a research question first.');
      if (q.length > 2000) throw readable('Keep the research question under 2000 characters.');
      const messages = [{ role: 'system', content: PLAN_SYSTEM }, { role: 'user', content: q }];
      const need = tokens(messages) + replyTokens;
      if (need > windowTokens) throw readable(`Planning needs about ${need} tokens but the model window is ${windowTokens}.`);
      return parsePlan(await complete(messages, { signal, maxTokens: replyTokens }));
    },
  };
}

module.exports = { createPlanner, sanitizePlan, parsePlan, PLAN_SYSTEM, MAX_ITEMS };
