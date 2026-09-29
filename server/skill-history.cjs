'use strict';
// Revoked Skills in earlier turns (#546). #543 stops a reply the moment a Skill it loaded is disabled
// or changed, but the chat history the client sends with the NEXT message can still carry that
// Skill's instructions: a read_project_file / project_read_file result replayed as a tool message,
// or an assistant reply that repeated the body. This module removes them server-side, before the
// history reaches the model. The client's history is never trusted to say what came from a Skill.
//
// What counts as Skill content is decided only from server-held records:
//   - a tenant-scoped ledger (one file in the account's own workspace directory, keyed by project)
//     of every Skill version an exchange put in front of the model: file, name, SHA-256, the chats
//     that loaded it, and SHA-256 fingerprints of its lines. The ledger keeps no copy of the body.
//   - the project as stored now: a disabled Skill that was loaded before the ledger existed.
// A version is revoked when its (file, SHA-256) is no longer an enabled Skill of the project. In the
// history of a revoked version, these are replaced with a short neutral placeholder:
//   - a tool/function message that is the Skill reader's output for it (its heading names the
//     SHA-256): the whole message. Anywhere in the project: the SHA-256 is a server-made marker.
//   - any other line that names its SHA-256. Anywhere in the project.
//   - a verbatim echo of its body: only in a chat the ledger says loaded that version, and only a run
//     of at least two identifying lines (or one long one). A single common line ("import numpy as
//     np", "Let me know if you have any questions.") shared with a Skill is never enough, and code
//     fences are never taken.
// A disabled Skill known only from the project (no ledger entry) is matched by its SHA-256 alone:
// switching off a Skill that was never enabled must not rewrite text that happens to resemble it.
// Lines that also belong to a Skill that is still enabled are left alone. System and user messages
// are never changed: the system prompt is built by core from the current project, and the person may
// have typed or pasted that text themselves.
//
// Limits (documented, deliberate): a paraphrase or an inline quotation inside a longer line is not
// recognised; only verbatim lines are. Text that merely claims to be from a Skill but matches no
// server record is ordinary history. A server-side compaction summary built over the old text no
// longer applies once the covered history changes (chat-context.cjs fingerprints that prefix), so
// it is rebuilt from the scrubbed history rather than reused.
const crypto = require('node:crypto');
const instructionSkills = require('./instruction-skills.cjs');

const FILE = 'skill-history.json';
const MAX_LINES = 2000; // per version; a Skill body is at most 32 KiB
const STRONG = 16; // a normalised line this long (with real words) can identify a Skill line
const RUN_CHARS = 80; // a text-only run needs two identifying lines, or this many identifying characters
const SHA = /\b[a-f0-9]{64}\b/g;
const SHA_ONE = /^[a-f0-9]{64}$/;
const READER = /^(?:Loaded instruction skill |Loaded part of instruction skill )/;
const FENCE = /^\s*(?:`{3,}|~{3,})/;

const normalise = (line) => String(line).replace(/^\s*(?:[-*+>]|#{1,6}|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
const fingerprint = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
function fingerprints(content) {
  const out = new Set();
  for (const line of String(content || '').split(/\r?\n/)) {
    if (FENCE.test(line)) continue;
    const n = normalise(line);
    if (n && n !== '---') out.add(fingerprint(n));
    if (out.size >= MAX_LINES) break;
  }
  return out;
}
const placeholder = (names) => `[Skill ${[...names].map((n) => JSON.stringify(n)).join(', ')} was disabled or changed, and its instructions were removed]`;

// One ledger entry as stored, or null when it is not structurally sound (dropped on load).
function validEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  if (typeof e.file !== 'string' || !e.file || typeof e.hash !== 'string' || !SHA_ONE.test(e.hash)) return null;
  return {
    file: e.file, hash: e.hash,
    name: typeof e.name === 'string' && e.name ? e.name.slice(0, 160) : e.file,
    lines: Array.isArray(e.lines) ? e.lines.filter((l) => typeof l === 'string' && /^[a-f0-9]{16}$/.test(l)).slice(0, MAX_LINES) : [],
    chats: Array.isArray(e.chats) ? e.chats.filter((c) => typeof c === 'string' && c) : [],
    at: Number.isFinite(e.at) ? e.at : 0,
  };
}

function createSkillHistory({ fs, path, cacheMax = 256, maxVersions = 64, maxChats = 200 }) {
  // dir -> { v, projects: { [projectId]: [entry] } }. Read from disk once per account directory, then
  // served from memory, so a chat without Skills costs a map lookup. Writes go to memory and disk.
  const cache = new Map();
  function load(dir) {
    if (cache.has(dir)) { const v = cache.get(dir); cache.delete(dir); cache.set(dir, v); return v; }
    const state = { v: 1, projects: Object.create(null) };
    const file = path.join(dir, FILE);
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { /* absent: nothing recorded yet */ }
    if (raw !== null) {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      if (parsed && typeof parsed === 'object' && parsed.projects && typeof parsed.projects === 'object' && !Array.isArray(parsed.projects)) {
        for (const [id, list] of Object.entries(parsed.projects)) {
          if (!Array.isArray(list)) continue;
          const kept = list.map(validEntry).filter(Boolean);
          if (kept.length) state.projects[id] = kept;
        }
      } else {
        // Unreadable: kept aside for inspection rather than silently overwritten by the next record.
        try { fs.renameSync(file, `${file}.corrupt`); console.warn(`[skills] ${FILE} was unreadable and was moved to ${FILE}.corrupt`); }
        catch (error) { console.warn(`[skills] ${FILE} was unreadable and could not be moved aside: ${error.message}`); }
      }
    }
    cache.set(dir, state);
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value);
    return state;
  }
  function persist(dir, state, assertActive) {
    assertActive?.(); // a deleted account's folder is never recreated
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, FILE), tmp = `${file}.${crypto.randomUUID()}`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  const entries = (dir, projectId) => {
    const list = load(dir).projects[projectId];
    return Array.isArray(list) ? list : [];
  };
  const activeKeys = (project) => new Set(instructionSkills.list(project).filter((s) => s.status === 'enabled').map((s) => `${s.file}\0${s.hash}`));

  /**
   * Records one Skill version an exchange loaded, and the chat that loaded it. Idempotent per
   * (project, file, SHA-256, chat). Returns whether anything changed.
   */
  function record(dir, project, { file, name, hash, content }, { chatId = null, assertActive = null } = {}) {
    if (!dir || !project?.id || typeof file !== 'string' || !SHA_ONE.test(String(hash || ''))) return false;
    const state = load(dir);
    const list = entries(dir, project.id);
    const chat = typeof chatId === 'string' && chatId ? chatId : null;
    const existing = list.find((e) => e.file === file && e.hash === hash);
    if (existing && (!chat || existing.chats.includes(chat))) return false;
    let next;
    if (existing) {
      next = list.map((e) => (e === existing ? { ...e, chats: [...e.chats, chat].slice(-maxChats) } : e));
    } else {
      next = [...list, { file, name: String(name || file).slice(0, 160), hash, lines: [...fingerprints(content)], chats: chat ? [chat] : [], at: Date.now() }];
      // Over the cap, versions still enabled go first (oldest first): they are not needed to scrub
      // anything until they are revoked, and they are recorded again the next time they load.
      const active = next.length > maxVersions ? activeKeys(project) : null;
      while (next.length > maxVersions) {
        const i = next.findIndex((e) => active.has(`${e.file}\0${e.hash}`));
        next.splice(i >= 0 ? i : 0, 1);
      }
    }
    // A deleted (inactive) account records nothing, in memory or on disk.
    try { assertActive?.(); } catch { return false; }
    state.projects[project.id] = next;
    // A failed write keeps the in-memory record, so this process still scrubs; it is logged.
    try { persist(dir, state, assertActive); } catch (error) { console.warn(`[skills] could not record a loaded skill: ${error.message}`); }
    return true;
  }

  /**
   * The versions of this project's Skills that were in front of a model once and are not enabled now:
   * SHA-256 -> { name, lines }. `lines` (for echo matching) is filled only for versions the ledger says
   * `chatId` loaded; every other revoked version is matched by its SHA-256 alone.
   */
  function revokedVersions(dir, project, chatId = null) {
    const recorded = dir ? entries(dir, project.id) : [];
    const tracked = project.instructionSkills && Object.keys(project.instructionSkills).length > 0;
    if (!recorded.length && !tracked) return { revoked: new Map(), enabled: [] };
    const now = tracked ? instructionSkills.list(project) : [];
    const enabled = now.filter((s) => s.status === 'enabled');
    const enabledHashes = new Set(enabled.map((s) => s.hash));
    const active = new Set(enabled.map((s) => `${s.file}\0${s.hash}`));
    const revoked = new Map();
    for (const e of recorded) {
      if (active.has(`${e.file}\0${e.hash}`) || enabledHashes.has(e.hash)) continue;
      const known = revoked.get(e.hash) || { name: e.name || e.file, lines: new Set() };
      if (chatId && e.chats.includes(chatId)) for (const l of e.lines) known.lines.add(l);
      revoked.set(e.hash, known);
    }
    // Loaded before the ledger existed (or never loaded at all: a Skill switched off while awaiting
    // review is 'disabled' too). Matched only where its SHA-256 is named, never by its text.
    for (const s of now) if (s.status === 'disabled' && !enabledHashes.has(s.hash) && !revoked.has(s.hash)) revoked.set(s.hash, { name: s.name || s.file, lines: new Set() });
    return { revoked, enabled };
  }

  function scrubText(content, revoked, byLine, keep) {
    const lines = String(content).split('\n');
    // H: names a revoked SHA-256 (removed on its own); S: an identifying echo line; W: a matching line
    // too short or too plain to identify anything; B: blank; N: anything else, including code fences.
    const marks = lines.map((line) => {
      const named = (String(line).match(SHA) || []).filter((h) => revoked.has(h));
      if (named.length) return { kind: 'H', names: named.map((h) => revoked.get(h).name) };
      if (FENCE.test(line)) return { kind: 'N' };
      const n = normalise(line.replace(/\r$/, ''));
      if (!n) return { kind: 'B' };
      if (!byLine.size) return { kind: 'N' };
      const fp = fingerprint(n);
      if (keep.has(fp) || !byLine.has(fp)) return { kind: 'N' };
      return { kind: n.length >= STRONG && /[a-z]{3}/.test(n) ? 'S' : 'W', names: byLine.get(fp), chars: n.length };
    });
    const out = [], removed = new Set();
    for (let i = 0; i < lines.length;) {
      if (marks[i].kind === 'N') { out.push(lines[i]); i++; continue; }
      let j = i;
      while (j < lines.length && marks[j].kind !== 'N') j++;
      const decisive = (k) => marks[k].kind === 'H' || marks[k].kind === 'S';
      let a = i, b = j - 1;
      while (a <= b && !decisive(a)) a++;
      while (b >= a && !decisive(b)) b--;
      let take = false;
      if (a <= b) {
        const strong = marks.slice(a, b + 1).filter((m) => m.kind === 'S');
        take = marks.slice(a, b + 1).some((m) => m.kind === 'H') || strong.length >= 2 || strong.reduce((n, m) => n + m.chars, 0) >= RUN_CHARS;
      }
      if (!take) { out.push(...lines.slice(i, j)); i = j; continue; }
      // Short matching lines directly next to the run belong to it; blanks further out stay.
      while (a > i && marks[a - 1].kind === 'W') a--;
      while (b < j - 1 && marks[b + 1].kind === 'W') b++;
      const names = new Set();
      for (let k = a; k <= b; k++) for (const name of marks[k].names || []) names.add(name);
      for (const name of names) removed.add(name);
      out.push(...lines.slice(i, a), placeholder(names), ...lines.slice(b + 1, j));
      i = j;
    }
    return { text: removed.size ? out.join('\n') : content, removed };
  }

  /**
   * Returns the history with revoked Skill content replaced, and the Skill names that were removed.
   * `messages` holds { role, content[, name] }; it is never mutated, and when nothing is revoked the
   * same array comes back. `chatId` is the chat the history belongs to.
   */
  function scrub({ dir, project, messages, chatId = null }) {
    const none = { messages, removed: [] };
    if (!project || !Array.isArray(messages) || !messages.length) return none;
    const { revoked, enabled } = revokedVersions(dir, project, typeof chatId === 'string' && chatId ? chatId : null);
    if (!revoked.size) return none;
    const byLine = new Map(); // fingerprint -> [names], only for versions this chat loaded
    for (const { name, lines } of revoked.values()) for (const l of lines) byLine.set(l, [...(byLine.get(l) || []), name]);
    const keep = new Set(); // lines of Skills that are still enabled are not revoked instructions
    if (byLine.size) for (const s of enabled) for (const l of fingerprints(s.content)) keep.add(l);
    const removed = new Set();
    let changed = false;
    const next = messages.map((m) => {
      if (!m || m.role === 'user' || m.role === 'system' || typeof m.content !== 'string') return m;
      const named = [...new Set((m.content.match(SHA) || []).filter((h) => revoked.has(h)))];
      if ((m.role === 'tool' || m.role === 'function') && named.length && READER.test(m.content.trimStart())) {
        const names = named.map((h) => revoked.get(h).name);
        for (const name of names) removed.add(name);
        changed = true;
        return { ...m, content: placeholder(names) };
      }
      if (!named.length && !byLine.size) return m;
      const { text, removed: here } = scrubText(m.content, revoked, byLine, keep);
      if (!here.size) return m;
      for (const name of here) removed.add(name);
      changed = true;
      return { ...m, content: text };
    });
    return changed ? { messages: next, removed: [...removed] } : none;
  }

  return { record, scrub, revokedVersions };
}

module.exports = { createSkillHistory, fingerprints, normalise, placeholder, FILE };
