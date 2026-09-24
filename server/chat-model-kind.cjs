'use strict';
// Which served models can answer a chat-generation prompt. Embedding and reranking models
// return vectors or scores, and Laya is the internal routing model: a prompt suite of coding,
// writing and reasoning prompts sent to any of them measures nothing (#206).
// Mirrors src/model-kind.ts, which filters the same models out of the picker.
const { isSystemModel } = require('./model-system.cjs');

const NON_CHAT_LABEL = /^(embedding|embeddings|rerank|reranking|reranker)$/i;
// Labels come from engine flags (--embedding/--rerank); a models.ini section without those
// flags still names itself, so the name is checked too.
const NON_CHAT_NAME = /embed|rerank/i;

function isChatGenerationModel(name, labels = []) {
  const n = String(name || '');
  if (!n || isSystemModel(n)) return false;
  if (NON_CHAT_NAME.test(n)) return false;
  return !(Array.isArray(labels) ? labels : []).some((l) => NON_CHAT_LABEL.test(String(l)));
}

/** The requested aliases that are not chat-generation models. `catalogue` is the served list
 *  ({name, labels}) or null when unreadable; an alias missing from it is judged by name alone. */
function nonChatAliases(aliases, catalogue) {
  const rows = Array.isArray(catalogue) ? catalogue : [];
  return (Array.isArray(aliases) ? aliases : []).filter((alias) => {
    const entry = rows.find((m) => m && m.name === alias);
    return !isChatGenerationModel(alias, entry?.labels);
  });
}

module.exports = { isChatGenerationModel, nonChatAliases };
