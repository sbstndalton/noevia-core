'use strict';
// Chat framing, phase 3 (#739): a confirmed frame steers the answer. Pure functions only; chat.cjs
// wires them. Three parts:
//
//   storedFrame   the frame of a chat as stored in the signed-in user's OWN lists (the free list or
//                 the chat's project). A frame sent in the chat request body is never read: the
//                 caller passes the lists, not the body.
//   frameBlock    a short "Chat frame" system-prompt block: a kind-specific answer shape and the
//                 scope to stay within. Tags are user text, so they go in as framed, sanitized data
//                 (prompt-framing.cjs), never as instructions.
//   gateBias      what the kind asks of the tool gate (tool-gate.cjs). Bias only narrows or
//                 prefers among the tools this request already offers; it never adds a tool, never
//                 picks a write and never bypasses an approval. Unknown kinds give no bias.
//
// RAG scope: knowledge-file retrieval is rag.filesContext(project.id, ..., userId), keyed by the
// chat's own project and the signed-in user's index; a free chat has no project and no retrieval.
// The frame's projectId only adds the "this project" scope line when it equals the chat's project;
// it never selects an index, so a frame cannot widen retrieval to another project.
//
// Flag off, no frame, or an unconfirmed frame: every function returns null and chat.cjs sends
// exactly what it sent before (chat-frame-steering.test.cjs pins this byte for byte).
const { normalizeFrame } = require('./chat-framing.cjs');
const { frameUntrusted } = require('./prompt-framing.cjs');

const MAX_BLOCK_CHARS = 400;
const MAX_TAGS = 6, MAX_TAG_CHARS = 32;

const SHAPES = Object.freeze({
  search: 'a lookup. Lead with the direct answer, then name the sources you used. Say so if nothing reliable was found.',
  action: 'a request to get something done. Use the offered tools for it; every change still waits for approval. Report what was done.',
  idea: 'brainstorming. Offer a few distinct options with brief trade-offs; do not run tools unless asked.',
  question: 'a question. Explain clearly and concisely, starting with the answer.',
  code: 'programming. Answer with working code in fenced blocks and a short explanation.',
});

/**
 * The stored, confirmed frame of chat `chatId`, looked up only in the user's own lists, or null.
 * @param {{ enabled: boolean, chatId: string|null, projectId: string|null, project: object|null, freeChats: object[] }} input
 *   `project` is the chat's project as the server loaded it; `freeChats` the user's free list.
 */
function storedFrame({ enabled, chatId, projectId = null, project = null, freeChats = [] }) {
  if (!enabled || typeof chatId !== 'string' || !chatId) return null;
  const find = (list) => (Array.isArray(list) ? list : []).find((c) => c && c.id === chatId);
  const inList = project ? find(project.chats) : null;
  const meta = inList || find(freeChats);
  const frame = normalizeFrame(meta?.frame);
  if (!frame || !frame.confirmed) return null;
  // The scope line names the chat's project only when the chat lives in that project and the
  // frame agrees with it.
  return { ...frame, inProject: !!inList && !!projectId && project.id === projectId && frame.projectId === projectId };
}

const safeTag = (t) => String(t || '').normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '').slice(0, MAX_TAG_CHARS);

/** The "Chat frame" system-prompt block for a stored, confirmed frame, or '' (no block). */
function frameBlock(frame) {
  if (!frame || !frame.confirmed || !SHAPES[frame.kind]) return '';
  const head = `Chat frame (set by the user): this chat is ${SHAPES[frame.kind]}`;
  const scope = frame.inProject ? ' Stay within this project and its sources.' : '';
  let tags = [...new Set((frame.tags || []).map(safeTag).filter(Boolean))].slice(0, MAX_TAGS);
  const build = () => {
    if (!tags.length) return `${head}${scope}`;
    return `${head}${scope} Stay within the topics tagged below.\n${frameUntrusted('chat tags', '', tags.join(', '))}`;
  };
  let block = build();
  while (block.length > MAX_BLOCK_CHARS && tags.length) { tags = tags.slice(0, -1); block = build(); }
  return block.slice(0, MAX_BLOCK_CHARS);
}

/**
 * What a frame kind asks of the tool gate, or null for no bias.
 *   prefer      gate rule kinds whose tools go first among the Stage 2 options (web search, then
 *               project/RAG search), when offered
 *   hint        appended to the Stage 2 question (action: a tool is expected; still read-only, still
 *               confidence-bound)
 *   noForce     the gate forces nothing for this message
 */
function gateBias(frame) {
  switch (frame?.confirmed ? frame.kind : null) {
    case 'search': return { prefer: ['search', 'drive'], hint: 'The user framed this chat as a lookup.' };
    case 'action': return { hint: 'The user framed this chat as a request to get something done, so a tool is expected.' };
    case 'idea': return { noForce: true };
    default: return null; // question, code: nothing beyond the prompt block; never a mode switch
  }
}

module.exports = { storedFrame, frameBlock, gateBias, SHAPES, MAX_BLOCK_CHARS };
