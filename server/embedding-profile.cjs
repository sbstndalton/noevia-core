'use strict';
// #1636: how text is framed before it is embedded. An embedding model is trained with a prompt
// format; queries and documents may need different prefixes, and vectors made with one framing
// are not comparable with vectors made with another. The profile is part of an index's identity
// (embedding-config.cjs), next to the model.
//
//   nomic-v1          raw text for every kind. This is exactly what noevia has always sent (no
//                     search_query:/search_document: prefixes), so every existing index was built
//                     this way. It is the default: leaving EMBEDDING_PROFILE unset changes nothing.
//   embeddinggemma-2  the model card's task prefixes (huggingface.co/google/embeddinggemma-2,
//                     "Task Instruction Prefixes"; config_sentence_transformers.json prompts
//                     SearchQuery / Document / SentenceSimilarity):
//                       query       "task: search result | query: {text}"
//                       document    "title: {title or none} | text: {text}"
//                       similarity  "task: sentence similarity | query: {text}"
//
// Kinds: `query` (the question side of a search), `document` (what is stored and searched),
// `similarity` (both sides of a symmetric comparison).

const DEFAULT_PROFILE = 'nomic-v1';
const KINDS = new Set(['query', 'document', 'similarity']);

// A title is one short line: no line breaks or `|` (the prefix's own separator).
function cleanTitle(title) {
  const t = String(title ?? '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  return t || 'none';
}

const PROFILES = Object.freeze({
  'nomic-v1': Object.freeze({
    id: 'nomic-v1',
    format: (text) => String(text),
  }),
  'embeddinggemma-2': Object.freeze({
    id: 'embeddinggemma-2',
    format: (text, kind, title) => {
      if (kind === 'query') return `task: search result | query: ${text}`;
      if (kind === 'similarity') return `task: sentence similarity | query: ${text}`;
      return `title: ${cleanTitle(title)} | text: ${text}`;
    },
  }),
});

function profileNames() { return Object.keys(PROFILES); }

/** The profile called `name`, or null when there is no such profile (never a silent default). */
function profileNamed(name) {
  return Object.prototype.hasOwnProperty.call(PROFILES, name) ? PROFILES[name] : null;
}

/**
 * The texts to send for `texts`, framed for `profile`. `kind` is one kind or one per text;
 * `titles` (documents only) one per text. Throws on an unknown profile or kind: a wrong framing
 * would build vectors that silently disagree with the rest of the index.
 */
function frame(profileName, texts, { kind = 'document', titles = null } = {}) {
  const profile = profileNamed(profileName);
  if (!profile) throw Object.assign(Error(`Unknown embedding profile "${profileName}" (known: ${profileNames().join(', ')})`), { code: 'unknownProfile' });
  const list = Array.isArray(texts) ? texts : [];
  return list.map((text, i) => {
    const k = Array.isArray(kind) ? kind[i] : kind;
    if (!KINDS.has(k)) throw Object.assign(Error(`Unknown embedding kind "${k}"`), { code: 'unknownKind' });
    return profile.format(String(text ?? ''), k, Array.isArray(titles) ? titles[i] : undefined);
  });
}

module.exports = { DEFAULT_PROFILE, PROFILES, profileNames, profileNamed, frame, cleanTitle };
