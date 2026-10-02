'use strict';
// Chat framing, phase 5 (#741): mirror chats into the person's own Diary as Obsidian notes.
//
// One-way and per-user opt-in (off by default): noevia writes `Chats/<Project|Inbox>/<title>.md`
// and never reads a note back. Each note opens with frontmatter (noevia_id, created, updated,
// project, kind, tags, brain_schema: 0), then the same Markdown the conversation export writes
// (chat-export.cjs chatMarkdown, which leaves reasoning out), then the chat's links as [[Title]].
// When the chat has a brain (#742, chat-brain.cjs), its Summary / Decisions / Facts / Open questions /
// Entities sections follow the frontmatter and brain_schema is 1; without one, nothing changes.
//
// Identity is the chat id (noevia_id), kept in a small per-user index, so a rename or a move to
// another project moves the note instead of leaving a copy. A chat that was deleted has its note
// moved to the Diary's Trash (the companion's delete is a Trash capsule, never a hard delete).
// Deleted means positively tombstoned (chat-lists.cjs deleted-chats.json), never merely absent from
// the lists: an empty or partial list (a load hiccup, a swallowed read error, an import mid-write)
// must not trash a vault. Every delete path tombstones: a single delete, project deletion
// (purgeProjectChats) and the retention sweep (chat-retention.cjs, through the normal delete
// path). A chat that leaves the lists without a tombstone (or whose tombstone aged out of the
// capped file) keeps its note and its index entry; that is the safe side. A note
// someone edited in the vault keeps its edited copy in Trash before noevia overwrites it.
//
// Writes go through the Diary files client the DAV listener already uses (read, write, mkdir, ops:
// /api/file, /api/directory, /api/workspace-ops), always as the chat's own user. Saves are
// debounced per user; a failed sync keeps the index as it was and is retried later. Nothing here
// runs on the request path and nothing here can throw into it.
const crypto = require('node:crypto');
const { chatMarkdown } = require('./chat-export.cjs');
const chatBrain = require('./chat-brain.cjs');

const ROOT = 'Chats';
const INBOX = 'Inbox';
const BRAIN_SCHEMA = 0;            // a note without a brain; with one it is chatBrain.BRAIN_SCHEMA (#742)
const MAX_NOTE_BYTES = 500 * 1024;          // the companion's editor limit is 512 KiB
const MAX_NAME = 100;
const DEFAULT_DELAY_MS = 5000, DEFAULT_MAX_WAIT_MS = 30000, DEFAULT_RETRY_MS = 60000;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** A file or folder name that cannot leave its folder, hide itself or break a sync client:
 *  no separators, no characters Windows, macOS or Obsidian links reject, no leading dot,
 *  no control characters, bounded length. Never empty. */
function safeName(text, fallback) {
  let name = String(text ?? '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|#^[\]%{}]/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME).replace(/[.\s]+$/, '');
  if (!name || name === '.' || name === '..') name = fallback;
  if (RESERVED.test(name)) name = `${name} chat`;
  return name;
}

/** The folder a chat's note lives in. A project called "Inbox" would share the free chats' folder,
 *  so it gets its own name. */
function folderFor(projectName) {
  if (projectName == null) return `${ROOT}/${INBOX}`;
  const name = safeName(projectName, 'Project');
  return `${ROOT}/${name.toLowerCase() === INBOX.toLowerCase() ? `${name} (project)` : name}`;
}

/** Whether `path` is a note this mirror may touch: Chats/<one folder>/<one .md file>, no traversal. */
function insideMirror(path) {
  if (typeof path !== 'string') return false;
  const parts = path.split('/');
  return parts.length === 3 && parts[0] === ROOT && parts.slice(1).every((p) => p && p !== '.' && p !== '..' && !p.startsWith('.') && !/[\\\u0000-\u001f]/.test(p))
    && parts[2].endsWith('.md');
}

const yamlString = (value) => JSON.stringify(String(value)); // a JSON string is a valid YAML double-quoted scalar
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

/** The note's YAML frontmatter. Unknown or missing values are written as null, never guessed. */
function frontmatter({ chat, projectName, brain = null }) {
  const frame = chat.frame && typeof chat.frame === 'object' ? chat.frame : null;
  const tags = Array.isArray(frame?.tags) ? frame.tags.filter((t) => typeof t === 'string' && t) : [];
  const lines = ['---',
    `noevia_id: ${yamlString(chat.id)}`,
    `created: ${iso(chat.createdAt) ?? iso(chat.updatedAt) ?? 'null'}`,
    `updated: ${iso(chat.updatedAt) ?? 'null'}`,
    `project: ${projectName == null ? 'null' : yamlString(projectName)}`,
    `kind: ${frame?.kind ? yamlString(frame.kind) : 'null'}`,
    `tags: [${tags.map(yamlString).join(', ')}]`,
    `brain_schema: ${brain ? chatBrain.BRAIN_SCHEMA : BRAIN_SCHEMA}`,
    '---', ''];
  return lines.join('\n');
}

/** The whole note. `linkNames` are the note names of the chats this one links to. With a valid
 *  `brain` (#742) its Markdown sections follow the frontmatter; without one the note is unchanged. */
function renderNote({ chat, projectName, history, linkNames = [], brain = null }) {
  const valid = brain ? chatBrain.validateBrain(brain) : null;
  const usable = valid?.ok ? valid.brain : null;
  const head = frontmatter({ chat, projectName, brain: usable }) + (usable ? chatBrain.renderBrainMarkdown(usable) : '');
  const links = linkNames.length ? `\n## Links\n\n${linkNames.map((n) => `- [[${n}]]`).join('\n')}\n` : '';
  let body = chatMarkdown(chat, Array.isArray(history) ? history : []);
  const budget = MAX_NOTE_BYTES - Buffer.byteLength(head + links) - 200;
  if (Buffer.byteLength(body) > budget) {
    // Keep the start (title and first turns) and say plainly that the rest is in noevia.
    body = Buffer.from(body).subarray(0, Math.max(0, budget)).toString('utf8').replace(/�+$/, '');
    body += '\n\n_(This chat is longer than a note can hold here; the rest is in noevia.)_\n';
  }
  return `${head}${body}${links}`;
}

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const noteName = (path) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');

/** Should a finished request make this user's mirror look again? Writes to chat lists, transcripts,
 *  moves, project changes (a renamed project moves its notes) and imports. */
function mirrorTrigger(method, path) {
  if (!method || ['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
  const history = /^\/api\/chats\/([^/]+)\/(history|move)$/.exec(path || '');
  if (history) { try { return { chatId: decodeURIComponent(history[1]) }; } catch { return { chatId: null }; } }
  return /^\/api\/(freechats(\/|$)|projects(\/|$)|import(\/|$))/.test(path || '') ? { chatId: null } : null;
}

/**
 * @param {object} deps
 * @param {(userId:string) => boolean} deps.enabled      flag on, Diary on and the user opted in
 * @param {(userId:string) => {freeChats:object[], projects:object[]}} deps.lists   the user's own lists
 * @param {(userId:string) => Set<string>} deps.deleted  the user's own tombstoned chat ids
 * @param {(userId:string, chatId:string) => object[]} deps.readHistory           the user's own transcript
 * @param {{read:Function, write:Function, mkdir:Function, ops:Function}} deps.files the Diary files client (DAV's)
 * @param {{read:(userId:string)=>object, write:(userId:string, state:object)=>void}} deps.index
 * @param {(userId:string, chatId:string) => object|null} [deps.readBrain]  the chat's brain from the user's own workspace (#742)
 */
function createChatVaultMirror({ enabled, lists, deleted = () => new Set(), readHistory, readBrain = () => null, files, index, log = () => {},
  delayMs = DEFAULT_DELAY_MS, maxWaitMs = DEFAULT_MAX_WAIT_MS, retryMs = DEFAULT_RETRY_MS,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  const users = new Map(); // userId -> { timer, firstAt, dirty:Set, running, again }

  function schedule(userId, chatId = null, { immediate = false } = {}) {
    if (typeof userId !== 'string' || !userId) return;
    let u = users.get(userId);
    if (!u) { u = { timer: null, firstAt: 0, dirty: new Set(), running: false, again: false }; users.set(userId, u); }
    if (chatId) u.dirty.add(chatId);
    if (u.running) { u.again = true; return; }
    if (u.timer) clearTimer(u.timer); else u.firstAt = now();
    // Debounced, but a chat that keeps changing is still mirrored at least every maxWaitMs.
    const wait = immediate ? 0 : Math.max(0, Math.min(delayMs, u.firstAt + maxWaitMs - now()));
    u.timer = setTimer(() => { u.timer = null; return run(userId); }, wait);
    u.timer?.unref?.();
  }

  async function run(userId) {
    const u = users.get(userId);
    if (!u || u.running) return;
    u.running = true; u.again = false;
    const dirty = u.dirty; u.dirty = new Set();
    let failed = false;
    try {
      // Checked when the sync runs, not when it was scheduled: switching off stops writes at once.
      if (enabled(userId)) failed = !(await sync(userId, dirty));
    } catch (error) {
      failed = true;
      log('chat-vault-mirror: sync failed', error?.message || String(error));
    } finally {
      u.running = false;
      if (failed) { for (const id of dirty) u.dirty.add(id); u.firstAt = now(); u.timer = setTimer(() => { u.timer = null; return run(userId); }, retryMs); u.timer?.unref?.(); }
      else if (u.again) schedule(userId);
      else if (!u.timer) users.delete(userId);
    }
  }

  const missing = (error) => error?.status === 404;
  async function readNote(userId, path) {
    try { const r = await files.read(userId, path); return { content: typeof r?.content === 'string' ? r.content : null, version: r?.version ?? null }; }
    catch (error) { if (missing(error)) return { content: null, version: null }; throw error; }
  }
  async function ensureFolder(userId, folder, made) {
    for (const path of [ROOT, folder]) {
      if (made.has(path)) continue;
      // 405: it already exists (or the storage creates folders on write). Either way, go on.
      try { await files.mkdir(userId, path); } catch (error) { if (error?.status !== 405) throw error; }
      made.add(path);
    }
  }

  /** One pass: write what changed, move what was renamed, trash what is gone. Returns false when
   *  any note failed (the rest still ran; the failed ones are retried). */
  async function sync(userId, dirty) {
    const state = index.read(userId) || {};
    const notes = state.notes && typeof state.notes === 'object' ? { ...state.notes } : {};
    const { freeChats = [], projects = [] } = lists(userId) || {};
    const live = [];
    for (const chat of freeChats) if (chat && typeof chat.id === 'string') live.push({ chat, projectName: null });
    for (const project of projects) for (const chat of project?.chats || []) if (chat && typeof chat.id === 'string') live.push({ chat, projectName: typeof project.name === 'string' ? project.name : 'Project' });
    // Stable order so two chats with one title always get the same names.
    live.sort((a, b) => (a.chat.createdAt || a.chat.updatedAt || 0) - (b.chat.createdAt || b.chat.updatedAt || 0) || a.chat.id.localeCompare(b.chat.id));
    const liveIds = new Set(live.map((l) => l.chat.id));

    // Paths: a chat keeps its note while its folder and title stay the same (including a " (2)"
    // suffix it was given); otherwise it gets the first free name in its folder.
    const taken = new Set(Object.entries(notes).filter(([id, n]) => liveIds.has(id) || n?.foreign).map(([, n]) => n.path));
    const want = new Map();
    for (const { chat, projectName } of live) {
      const folder = folderFor(projectName);
      const base = `${folder}/${safeName(chat.title, 'Untitled chat')}`;
      const current = notes[chat.id]?.path;
      if (current && (current === `${base}.md` || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+\\)\\.md$`).test(current))) { want.set(chat.id, current); continue; }
      if (current) taken.delete(current);
      let path = `${base}.md`;
      for (let n = 2; taken.has(path); n++) path = `${base} (${n}).md`;
      taken.add(path);
      want.set(chat.id, path);
    }

    let ok = true;
    const made = new Set();
    for (const { chat, projectName } of live) {
      const target = want.get(chat.id);
      if (!insideMirror(target)) { ok = false; log('chat-vault-mirror: refused path', target); continue; }
      const linkNames = [...new Set(Array.isArray(chat.frame?.links) ? chat.frame.links : [])]
        .filter((id) => id !== chat.id && want.has(id)).map((id) => noteName(want.get(id)));
      let brain = null;
      try { brain = readBrain(userId, chat.id) || null; } catch { brain = null; } // no brain: the note as before
      // A brain joins the fingerprint only when there is one, so notes without a brain are not rewritten.
      const metaPrint = hash(JSON.stringify([chat.title, chat.createdAt, chat.updatedAt, chat.frame ?? null, projectName, linkNames, ...(brain ? [brain] : [])]));
      const entry = notes[chat.id];
      if (entry && entry.path === target && entry.meta === metaPrint && !dirty.has(chat.id)) continue;
      try {
        await ensureFolder(userId, target.slice(0, target.lastIndexOf('/')), made);
        const content = renderNote({ chat, projectName, history: readHistory(userId, chat.id), linkNames, brain });
        let at = entry?.path && entry.path !== target ? entry.path : target;
        let current = await readNote(userId, at);
        if (at !== target) {
          // Renamed or moved to another project: move the note itself, so links in the vault follow it.
          if (current.content !== null) {
            const dest = await readNote(userId, target);
            if (dest.content !== null) throw Object.assign(Error('a note noevia did not write already has this name'), { status: 409, taken: target });
            await files.ops(userId, { op: 'move', path: at, destination: target, overwrite: false, version: current.version });
          }
          at = target;
          current = await readNote(userId, target);
        } else if (!entry && current.content !== null) {
          // A note noevia did not write is in the way: never overwrite it; take the next free name.
          throw Object.assign(Error('a note noevia did not write already has this name'), { status: 409, taken: target });
        }
        if (current.content === content) { notes[chat.id] = { path: target, version: current.version, meta: metaPrint }; continue; }
        // Edited in the vault since noevia last wrote it: keep that copy in Trash before replacing it.
        if (current.content !== null && entry?.version && current.version !== entry.version) await files.ops(userId, { op: 'preserve', path: target, version: current.version });
        const written = await files.write(userId, { path: target, content, version: current.version });
        notes[chat.id] = { path: target, version: written?.version ?? null, meta: metaPrint };
      } catch (error) {
        ok = false;
        // Remember the name as someone else's, so the next pass picks a free one instead.
        if (error?.taken) notes[`taken:${error.taken}`] = { path: error.taken, foreign: true };
        log('chat-vault-mirror: note failed', chat.id, error?.message || String(error));
      }
    }

    // Deleted (tombstoned) chats: the note goes to the Diary's Trash. Absence alone never trashes.
    const indexed = Object.keys(notes).filter((id) => !id.startsWith('taken:'));
    let gone = [];
    if (live.length === 0 && indexed.length > 0) {
      // Sanity brake: an empty list next to mirrored notes is far likelier a bad read than a user
      // who deleted everything at once. Skip trashing; a later pass with a real list catches up.
      log('chat-vault-mirror: empty chat list with mirrored notes, trash pass skipped', indexed.length);
    } else {
      const tombstones = deleted(userId);
      const isDeleted = (id) => tombstones instanceof Set && tombstones.has(id);
      gone = indexed.filter((id) => !liveIds.has(id) && isDeleted(id));
    }
    for (const id of gone) {
      const entry = notes[id];
      try {
        if (!insideMirror(entry?.path)) { delete notes[id]; continue; }
        let stat = null;
        try { stat = await files.ops(userId, { op: 'stat', path: entry.path }); } catch (error) { if (!missing(error)) throw error; }
        if (stat && !stat.isDir) await files.ops(userId, { op: 'delete', path: entry.path, version: stat.version });
        delete notes[id];
      } catch (error) {
        ok = false;
        log('chat-vault-mirror: trash failed', id, error?.message || String(error));
      }
    }
    index.write(userId, { ...state, notes });
    return ok;
  }

  return { schedule, run, sync, pending: (userId) => users.has(userId) };
}

// Per-user preference and index, two small files in the user's own workspace directory (like the
// framing preferences): they follow the account and never another tenant.
const PREFERENCES_FILE = 'chat-vault-mirror.json';
const INDEX_FILE = 'chat-vault-mirror-index.json';
function readJsonFile(file, fallback) {
  try { return JSON.parse(require('node:fs').readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonFile(dir, name, value) {
  const fs = require('node:fs'), path = require('node:path');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readPreferences(dir) {
  const data = readJsonFile(require('node:path').join(dir, PREFERENCES_FILE), null);
  return { enabled: data?.enabled === true };
}
function writePreferences(dir, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean') throw Object.assign(Error('enabled must be true or false'), { status: 400 });
  const record = { enabled: value.enabled };
  writeJsonFile(dir, PREFERENCES_FILE, record);
  return record;
}
const readIndex = (dir) => readJsonFile(require('node:path').join(dir, INDEX_FILE), {});
const writeIndex = (dir, state) => writeJsonFile(dir, INDEX_FILE, state);

module.exports = { createChatVaultMirror, renderNote, frontmatter, safeName, folderFor, insideMirror, mirrorTrigger,
  readPreferences, writePreferences, readIndex, writeIndex, BRAIN_SCHEMA, ROOT, INBOX };
