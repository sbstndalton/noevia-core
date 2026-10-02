'use strict';
// Chat framing, phase 1 (#737): suggest a frame for a chat from its first message. A frame is
// { projectId, kind, tags[], links[], confirmed, source }. The suggestion only ever picks from what
// the caller offers (the user's own projects, the fixed kind list, the user's existing tags) and
// fails open: no decision service, a missed deadline, a malformed answer or any error gives no frame,
// so the chat behaves exactly as it does without framing. Nothing here touches the prompt yet.
//
// Model roles are settings, not names: framingRouterModel classifies, framingReasonerModel (phase 4)
// structures tool output. Empty means "the configured decision service".
const { cosine } = require('./tool-router.cjs');

const KINDS = Object.freeze(['search', 'action', 'idea', 'question', 'code']);
const KIND_LABELS = Object.freeze({
  search: 'Looking something up or finding information',
  action: 'Asking for something to be done, changed or sent',
  idea: 'Brainstorming, exploring or developing an idea',
  question: 'Asking a question to be explained or answered',
  code: 'Programming, code, errors or software',
});
const NONE = '__none';
const MAX_OPTIONS = 8; // what the decision service accepts per choice (decision-settings SERVICE_LIMITS)
const MAX_TAGS = 20, MAX_LINKS = 20, MAX_TAG_CHARS = 64, MAX_ID_CHARS = 128;
const RELATED_MIN = 0.5, RELATED_MAX = 3, RELATED_POOL = 50;
const DEFAULT_DEADLINE_MS = 1500;
const SOURCES = new Set(['suggested', 'user']);

const cleanTag = (t) => (typeof t === 'string' ? t.trim().replace(/^#+/, '').replace(/\s+/g, '-').slice(0, MAX_TAG_CHARS) : '');
const cleanId = (id) => (typeof id === 'string' && id && id.length <= MAX_ID_CHARS ? id : null);

/** A stored or submitted frame in its canonical shape, or null when it is not a frame at all. */
function normalizeFrame(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || !KINDS.includes(frame.kind)) return null;
  const tags = [...new Set((Array.isArray(frame.tags) ? frame.tags : []).map(cleanTag).filter(Boolean))].slice(0, MAX_TAGS);
  const links = [...new Set((Array.isArray(frame.links) ? frame.links : []).map(cleanId).filter(Boolean))].slice(0, MAX_LINKS);
  return { projectId: cleanId(frame.projectId), kind: frame.kind, tags, links,
    confirmed: frame.confirmed === true, source: SOURCES.has(frame.source) ? frame.source : 'suggested' };
}

/** Every tag already used on the user's chats, most used first. */
function existingTags(chats) {
  const counts = new Map();
  for (const c of chats || []) for (const t of normalizeFrame(c?.frame)?.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

const SETTINGS_KEY = 'framing:roles';
const ROLE_RE = /^[A-Za-z0-9._:/@+-]{0,200}$/;
// #742: how many characters of linked chats' brain summaries one answer may get (features.brainContext).
// The upgrade knob for bigger hardware: raise it, nothing else is hard-wired.
const BRAIN_CONTEXT_CHARS = Object.freeze({ default: 2000, min: 0, max: 200000 });
const brainChars = (v) => (Number.isInteger(v) && v >= BRAIN_CONTEXT_CHARS.min && v <= BRAIN_CONTEXT_CHARS.max ? v : BRAIN_CONTEXT_CHARS.default);
/** framingRouterModel / framingReasonerModel: model ids, any provider, empty = default.
 *  brainContextChars: integer 0..200000, default 2000; omitted on save keeps the current value. */
function createFramingSettings({ store, audit = () => {} }) {
  let saved;
  try { saved = JSON.parse(store.get(SETTINGS_KEY) || 'null'); } catch { saved = null; }
  const get = () => ({ framingRouterModel: saved?.framingRouterModel || '', framingReasonerModel: saved?.framingReasonerModel || '',
    brainContextChars: brainChars(saved?.brainContextChars) });
  return {
    get,
    save(value, actor) {
      const next = {};
      for (const key of ['framingRouterModel', 'framingReasonerModel']) {
        const v = value?.[key] ?? '';
        if (typeof v !== 'string' || !ROLE_RE.test(v.trim())) throw Object.assign(Error('Enter a model id (letters, digits and . _ : / @ + -), or leave it empty for the default.'), { status: 400 });
        next[key] = v.trim();
      }
      if (value && 'brainContextChars' in value) {
        const n = value.brainContextChars;
        if (!Number.isInteger(n) || n < BRAIN_CONTEXT_CHARS.min || n > BRAIN_CONTEXT_CHARS.max) throw Object.assign(Error(`brainContextChars must be a whole number from ${BRAIN_CONTEXT_CHARS.min} to ${BRAIN_CONTEXT_CHARS.max}.`), { status: 400 });
        next.brainContextChars = n;
      } else next.brainContextChars = get().brainContextChars;
      store.set(SETTINGS_KEY, JSON.stringify(next));
      saved = next;
      audit('framing.roles', actor, next);
      return get();
    },
  };
}

function withDeadline(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('deadline'), { deadline: true })), ms); })])
    .finally(() => clearTimeout(timer));
}

/**
 * @param {object} deps
 * @param {() => boolean} deps.enabled                  features.enabled('chatFraming')
 * @param {(request:object) => Promise<object>} deps.decide  decision/index.cjs decide(), router role
 * @param {(texts:string[]) => Promise<number[][]>} [deps.embed]
 * @param {() => {framingRouterModel:string}} [deps.roles]
 * @param {() => number} [deps.deadlineMs]
 */
function createChatFraming({ enabled, decide, embed = null, roles = () => ({}), deadlineMs = () => DEFAULT_DEADLINE_MS, log = () => {}, now = Date.now }) {
  async function choose(purpose, question, options, stateText, budget, routerModel) {
    const result = await decide({ kind: 'choice', purpose, question, options,
      context: { cloud: 'forbidden', stateText, ...(routerModel ? { roleModel: routerModel } : {}) },
      constraints: { deadlineMs: budget }, fallback: { selected: null, scores: {} } });
    // decide() validates against the options; check again so a stub or future backend cannot widen them.
    if (!result || result.source === 'fallback' || !options.some((o) => o.id === result.selected)) return null;
    return result.selected;
  }

  async function embedAll(texts) {
    if (!embed || !texts.length) return null;
    try { const v = await embed(texts); return Array.isArray(v) && v.length === texts.length ? v : null; } catch { return null; }
  }

  async function run({ message, projects, chats, chatId, started, budget }) {
    const text = String(message || '').slice(0, 1000);
    const routerModel = roles()?.framingRouterModel || '';
    const left = () => Math.max(1, budget - (now() - started));
    const pool = (chats || []).filter((c) => c && typeof c.id === 'string' && c.id !== chatId && typeof c.title === 'string' && c.title.trim())
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, RELATED_POOL);
    const tags = existingTags(chats);
    const ownProjects = (projects || []).filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string');
    // One embedding call: the message, the related-chat pool, then project names and tags for pre-ranking.
    const texts = [text, ...pool.map((c) => c.title), ...ownProjects.map((p) => p.name), ...tags];
    const vectors = await embedAll(texts);
    const sim = (i) => (vectors ? cosine(vectors[0], vectors[i]) : 0);
    const links = vectors ? pool.map((c, i) => ({ id: c.id, score: sim(1 + i) })).filter((r) => r.score >= RELATED_MIN)
      .sort((a, b) => b.score - a.score).slice(0, RELATED_MAX).map((r) => r.id) : [];
    const rank = (items, offset) => items.map((item, i) => ({ item, score: sim(offset + i), i }))
      .sort((a, b) => b.score - a.score || a.i - b.i).slice(0, MAX_OPTIONS - 1).map((r) => r.item);
    const projectOptions = rank(ownProjects, 1 + pool.length).map((p) => ({ id: p.id, label: p.name }));
    const tagOptions = rank(tags, 1 + pool.length + ownProjects.length).map((t) => ({ id: t, label: `#${t}` }));
    const none = { id: NONE, label: 'None of these' };

    const [kind, projectId, tag] = await Promise.all([
      choose('chat.frame.kind', 'What kind of chat does this first message start?', KINDS.map((id) => ({ id, label: KIND_LABELS[id] })), text, left(), routerModel),
      projectOptions.length ? choose('chat.frame.project', 'Which of the user\'s projects does this chat belong to?', [...projectOptions, none], text, left(), routerModel) : null,
      tagOptions.length ? choose('chat.frame.tag', 'Which existing tag fits this chat best?', [...tagOptions, none], text, left(), routerModel) : null,
    ]);
    if (!kind) return { frame: null, reason: 'no-kind' };
    return { frame: normalizeFrame({ kind, projectId: projectId && projectId !== NONE ? projectId : null,
      tags: tag && tag !== NONE ? [tag] : [], links, confirmed: false, source: 'suggested' }), reason: null };
  }

  /** The suggested frame for a chat's first message: { frame, reason }; frame is null on any failure. */
  async function suggest({ message, projects = [], chats = [], chatId = null } = {}) {
    if (!enabled()) return { frame: null, reason: 'disabled' };
    if (typeof message !== 'string' || !message.trim()) return { frame: null, reason: 'empty' };
    const started = now();
    const budget = Number(deadlineMs()) > 0 ? Number(deadlineMs()) : DEFAULT_DEADLINE_MS;
    let out;
    try { out = await withDeadline(run({ message, projects, chats, chatId, started, budget }), budget); }
    catch (error) { out = { frame: null, reason: error?.deadline ? 'deadline' : 'error' }; }
    log({ purpose: 'chat.frame', framed: !!out.frame, kind: out.frame?.kind || null, fellBack: out.reason, ms: now() - started });
    return out;
  }

  return { suggest };
}

// Per-user framing preferences (#738), one small file in the user's own workspace directory so
// they follow the account and never another tenant. autoAccept: a suggested frame is applied
// without the confirm step. Off unless the user turns it on.
const PREFERENCES_FILE = 'chat-framing.json';
// The person's own framing choices, both off by default: autoAccept (#738) and keepReasoningTraces
// (#740, append the reasoner's task packets to a local JSONL file in their workspace).
const PREFERENCE_KEYS = Object.freeze(['autoAccept', 'keepReasoningTraces']);
function readPreferences(dir) {
  let data = null;
  try { data = JSON.parse(require('node:fs').readFileSync(require('node:path').join(dir, PREFERENCES_FILE), 'utf8')); } catch { data = null; }
  return Object.fromEntries(PREFERENCE_KEYS.map((k) => [k, data?.[k] === true]));
}
/** A partial update: each key given must be a boolean; keys not given keep their saved value. */
function writePreferences(dir, value) {
  const given = value && typeof value === 'object' && !Array.isArray(value) ? PREFERENCE_KEYS.filter((k) => k in value) : [];
  if (!given.length || given.some((k) => typeof value[k] !== 'boolean')) throw Object.assign(Error('autoAccept and keepReasoningTraces must be true or false'), { status: 400 });
  const fs = require('node:fs'), path = require('node:path');
  const record = { ...readPreferences(dir), ...Object.fromEntries(given.map((k) => [k, value[k]])) };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, PREFERENCES_FILE), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return record;
}

module.exports = { createChatFraming, createFramingSettings, BRAIN_CONTEXT_CHARS, normalizeFrame, existingTags, readPreferences, writePreferences, KINDS, NONE };
