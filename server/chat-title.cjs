'use strict';
// sbstndalton/noevia#1785: a chat's title is a short name for it, set after its first reply.
//
// Until now the web client named a chat after its first message (src/chat-title.ts deriveChatTitle: the
// message itself, cut at 80 characters), and nothing ever changed it: a chat about train times stayed
// "QA-1015-T1 Say hello in one short sentence." for good. After the first reply of a chat, the chat turn
// now asks the local model that just answered (still loaded, so nothing is swapped in) for a short title,
// with thinking off, and sends it to the client as a `title` event. The title is saved only while the
// chat still carries the title derived from its first message, so a name the person gave it always wins.
//
// Off-box turns (an external provider, a cloud route, any provider other than the local one: chat.cjs
// offBoxTurn) get no generated title: the message and the reply are never sent anywhere for it. A
// failure, a timeout or an unusable answer leaves the derived title as it was. Nothing here throws.

const { readCappedJson } = require('./http.cjs');

/** The longest title the client derives from a first message (web src/chat-title.ts CHAT_TITLE_MAX). */
const CHAT_TITLE_MAX = 80;
/** The longest generated title kept. */
const TITLE_MAX = 60;
const TITLE_MAX_WORDS = 10;
/** What the title request reads: the start of the message and of the reply is enough to name a chat. */
const MESSAGE_CHARS = 600;
const REPLY_CHARS = 1200;
const MAX_TOKENS = 64;
const TIMEOUT_MS = 8000;
const REPLY_BYTES_CAP = 64 * 1024;

const TITLE_SYSTEM = 'You name chat conversations. Reply with a short title of two to six words for the conversation below, '
  + 'in the language of the user\'s message. Name the topic, not the request: no quotes, no trailing punctuation, '
  + 'no "Title:" prefix, no emoji. Ignore labels, codes or IDs such as ticket numbers or test tags. Output the title only.';

/** The title the web client derives from a first message (port of src/chat-title.ts deriveChatTitle). */
function derivedTitle(text) {
  const value = String(text ?? '');
  if (value.length <= CHAT_TITLE_MAX) return value;
  let head = value.slice(0, CHAT_TITLE_MAX - 1).replace(/[\uD800-\uDBFF]$/, '');
  const boundary = head.search(/\s\S*$/);
  if (boundary >= CHAT_TITLE_MAX / 2) head = head.slice(0, boundary);
  return head.replace(/\s+$/, '') + '…';
}

/** Whether `title` is still the one derived from the first message (or the old bare 80-character cut),
 *  or no title at all: only then may a generated title replace it. */
function isDerivedTitle(title, firstMessage) {
  if (title === undefined || title === null || title === '') return true;
  if (typeof title !== 'string') return false;
  const message = String(firstMessage ?? '');
  return title === derivedTitle(message) || title === message.slice(0, CHAT_TITLE_MAX) || title === message.trim();
}

/** The first reply of a chat: the history this turn was sent with holds no assistant message. */
function firstReply(history) {
  return !(Array.isArray(history) && history.some((h) => h && h.role === 'assistant'));
}

/** The chat's first user message: the first user turn of the history this turn was sent with, or this turn's
 *  own message when there is none. A derived title is derived from it, whichever turn is answering now. */
function firstUserMessage(history, message) {
  const first = Array.isArray(history) ? history.find((h) => h && h.role === 'user' && typeof h.content === 'string') : null;
  return first ? first.content : String(message ?? '');
}

/** A model's answer reduced to a usable title, or null. */
function cleanTitle(raw) {
  if (typeof raw !== 'string') return null;
  let text = raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').replace(/<\|[^|>]*\|>/g, ' ');
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  text = line
    .replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, '').trim()
    .replace(/^#+\s*/, '')
    .replace(/^\*{1,2}|\*{1,2}$/g, '')
    .replace(/^(?:chat\s+)?title\s*[:\-–]\s*/i, '')
    .replace(/^["'“”‘’`«»]+|["'“”‘’`«»]+$/g, '')
    .replace(/[\p{Extended_Pictographic}‍️]/gu, '')
    .replace(/[\s.,;:!?…]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || !/\p{L}/u.test(text)) return null;
  if (text.split(' ').length > TITLE_MAX_WORDS) return null;
  if (text.length > TITLE_MAX) {
    const cut = text.slice(0, TITLE_MAX - 1);
    const boundary = cut.lastIndexOf(' ');
    text = (boundary >= TITLE_MAX / 2 ? cut.slice(0, boundary) : cut).replace(/[\s.,;:!?]+$/u, '') + '…';
  }
  return text;
}

/** The title request's messages: the first message and the start of the reply, as data. */
function titleMessages(message, reply) {
  const clip = (s, n) => { const v = String(s ?? '').trim(); return v.length > n ? `${v.slice(0, n)}…` : v; };
  return [
    { role: 'system', content: TITLE_SYSTEM },
    { role: 'user', content: `User message:\n${clip(message, MESSAGE_CHARS)}\n\nAssistant reply (start):\n${clip(reply, REPLY_CHARS)}\n\nTitle:` },
  ];
}

/**
 * Asks the local model for a title. Resolves to the cleaned title or null; never throws.
 * @param {{ fetch: Function, url: string, headers: object, model: string, message: string, reply: string,
 *           signal?: AbortSignal, timeoutMs?: number, readJson?: (response: Response, cap: number) => Promise<any> }} input
 */
async function generateTitle({ fetch, url, headers = {}, model, message, reply, signal, timeoutMs = TIMEOUT_MS, readJson }) {
  try {
    if (typeof fetch !== 'function' || !url || !model || !String(message ?? '').trim() || !String(reply ?? '').trim()) return null;
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any(signals),
      headers: { ...headers, 'Content-Type': 'application/json' },
      // Thinking off: a title is a few words, and the turn's own effort does not apply to it.
      body: JSON.stringify({ model, stream: false, temperature: 0.2, max_tokens: MAX_TOKENS,
        chat_template_kwargs: { enable_thinking: false }, messages: titleMessages(message, reply) }),
    });
    if (!response || !response.ok) return null;
    const body = await (typeof readJson === 'function' ? readJson : readCappedJson)(response, REPLY_BYTES_CAP);
    return cleanTitle(body?.choices?.[0]?.message?.content);
  } catch {
    return null;
  }
}

module.exports = { firstUserMessage, derivedTitle, isDerivedTitle, firstReply, cleanTitle, titleMessages, generateTitle, TITLE_SYSTEM, TITLE_MAX, CHAT_TITLE_MAX };
