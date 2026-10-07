'use strict';
// Routing modes (#778, features.routingModes, off by default). An account chooses where Auto sends
// its chats: `local` (local roles only), `cloud` (a cloud provider the account names), or `hybrid`
// (cloud, unless the turn looks sensitive). Only Auto chats are routed; a model picked by hand is
// respected, and the existing hard bans (provider-egress.cjs) always win.
//
// In hybrid, a flagged turn is never sent to cloud silently. Cheap deterministic rules run first
// (Diary content, obvious secrets and account numbers); otherwise the router role is asked through
// decide() with `cloud: 'forbidden'`. Every failure of that call is treated as "flagged". A flagged
// turn either stays local (the account's "always local" choice) or the person is asked, through the
// same pending-card mechanism as the write approvals, and nothing reaches the cloud provider until
// they pick "Send to cloud". A timeout, a cancel or a lost connection keeps it local.
//
// Logs and the decision log carry codes only (mode, route, reason, flag), never message text.

const fs = require('node:fs');
const path = require('node:path');

const MODES = Object.freeze(['local', 'cloud', 'hybrid']);
const WHEN_SENSITIVE = Object.freeze(['ask', 'local']);
// Codes only, never text: a reply's reason is mode, user-choice, force-local, sensitive-rule,
// fail-closed or remembered; a turn's flag (shown on the card) is diary, secret, iban, card, router
// or unavailable.
const ROLE_KEYS = Object.freeze(['fast', 'smart', 'code']);
const MODEL_RE = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const PROVIDER_RE = /^[A-Za-z0-9_-]{1,80}$/;
const FILE = 'routing-mode.json';
const ALLOWED_KEY = 'routing_modes_allowed';

// ── Account settings ────────────────────────────────────────────────────────

/** The stored setting, normalized. `mode: null` means "not chosen": routing behaves as before. */
function normalize(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mode = MODES.includes(value.mode) ? value.mode : null;
  const whenSensitive = WHEN_SENSITIVE.includes(value.whenSensitive) ? value.whenSensitive : 'ask';
  const c = value.cloud && typeof value.cloud === 'object' ? value.cloud : {};
  const cloud = { providerId: typeof c.providerId === 'string' && PROVIDER_RE.test(c.providerId) ? c.providerId : '' };
  for (const role of ROLE_KEYS) cloud[role] = typeof c[role] === 'string' && MODEL_RE.test(c[role].trim()) ? c[role].trim() : '';
  return { mode, whenSensitive, cloud };
}

function read(dir) {
  try { return normalize(JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'))); } catch { return normalize(null); }
}

/** Validates a PUT body; throws { status: 400 } on anything it cannot store. */
function validate(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(Error('request body must be a JSON object'), { status: 400 });
  if (body.mode !== null && !MODES.includes(body.mode)) throw Object.assign(Error("mode must be 'local', 'cloud', 'hybrid' or null"), { status: 400 });
  if (body.mode && !allowed.includes(body.mode)) throw Object.assign(Error('An administrator has not allowed this routing mode.'), { status: 403 });
  if (body.whenSensitive !== undefined && !WHEN_SENSITIVE.includes(body.whenSensitive)) throw Object.assign(Error("whenSensitive must be 'ask' or 'local'"), { status: 400 });
  const c = body.cloud === undefined ? {} : body.cloud;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw Object.assign(Error('cloud must be an object'), { status: 400 });
  if (c.providerId !== undefined && c.providerId !== '' && !(typeof c.providerId === 'string' && PROVIDER_RE.test(c.providerId))) throw Object.assign(Error('cloud.providerId is not a provider id'), { status: 400 });
  for (const role of ROLE_KEYS) {
    const v = c[role];
    if (v !== undefined && v !== '' && !(typeof v === 'string' && MODEL_RE.test(v.trim()))) throw Object.assign(Error(`cloud.${role} must be a model id`), { status: 400 });
  }
  return normalize(body);
}

function write(dir, value) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalize(value)));
  fs.renameSync(tmp, file);
}

/** The modes an administrator allows (all three unless restricted). */
function allowedModes(store) {
  try {
    const list = JSON.parse(store.get(ALLOWED_KEY) || 'null');
    if (Array.isArray(list)) { const out = MODES.filter((m) => list.includes(m)); return out; }
  } catch { /* fall through */ }
  return [...MODES];
}

function setAllowedModes(store, list) {
  if (!Array.isArray(list) || list.some((m) => !MODES.includes(m))) throw Object.assign(Error("allowed must list 'local', 'cloud' and/or 'hybrid'"), { status: 400 });
  const out = MODES.filter((m) => list.includes(m));
  store.set(ALLOWED_KEY, JSON.stringify(out));
  return out;
}

/** The mode in force. A mode an administrator later disallowed falls back to local, the one
 *  direction that never sends more data out. */
function effectiveMode(settings, allowed) {
  if (!settings.mode) return null;
  return allowed.includes(settings.mode) ? settings.mode : 'local';
}

// ── Per chat / project (#1007) ─────────────────────────────────────────────
// A project (or a free chat's own context project) may override the account's mode and sensitive
// handling. The cloud provider and models stay the account's. Absent means "as the account".

/** A project's stored override, or null. Throws { status: 400 } when `strict` and it is malformed. */
function projectOverride(raw, strict = false) {
  if (raw === undefined || raw === null) return null;
  const bad = (m) => { if (strict) throw Object.assign(Error(m), { status: 400 }); return null; };
  if (typeof raw !== 'object' || Array.isArray(raw)) return bad('routingMode must be an object or null');
  if (!MODES.includes(raw.mode)) return bad("routingMode.mode must be 'local', 'cloud' or 'hybrid'");
  if (raw.whenSensitive !== undefined && !WHEN_SENSITIVE.includes(raw.whenSensitive)) return bad("routingMode.whenSensitive must be 'ask' or 'local'");
  return { mode: raw.mode, whenSensitive: raw.whenSensitive || 'ask' };
}

/** The account settings with a project's override applied; effectiveMode still applies after. */
function withProjectOverride(settings, project) {
  const o = projectOverride(project && project.routingMode);
  return o ? { ...settings, mode: o.mode, whenSensitive: o.whenSensitive } : settings;
}

// ── Deterministic pre-rules ─────────────────────────────────────────────────

function ibanValid(raw) {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of code) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

function luhn(digits) {
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

// Every pattern here must stay linear on hostile input (#779 review F3): no unbounded run that a
// later failing token can make the engine rescan from every start position. Bounded quantifiers
// where a run precedes a literal; the key shape is matched with matchAll (non-overlapping) and
// its "has a digit and a letter" condition checked in code instead of with lookaheads.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/,
  /\bBearer\s{1,8}[A-Za-z0-9._~+/-]{16}/,
];
// #817: "<keyword> = value" / "<keyword>: value", tuned so code does not trip it. The keyword, then
// one "=" or ":" that is not "==" or "::", then an optional quote and a bounded value: every part is
// bounded, so it stays linear (matchAll, non-overlapping). Bare "pwd" (the shell command) is gone.
const SECRET_ASSIGN_RE = /\b(password|passwort|passwd|passcode|pin|api[ _-]?key|secret|access[ _-]?token|auth[ _-]?token|token)\s{0,8}(?:=(?!=)|:(?!:))\s{0,8}(["'`]?)([^\s"'`;,)]{4,200})/gi;
const PASSWORD_WORDS = new Set(['password', 'passwort', 'passwd']);
const NOT_A_VALUE = /^(?:null|none|nil|true|false|undefined)$/i;
const PLACEHOLDER = /^(?:x+|\*+|\.{3,}|…|<.*>|\$\{.*\}|your.*|changeme|example.*)$/i;
const MEMBER_ACCESS = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const CALL = /^[A-Za-z_$][\w$.]*\(/;
// A plain identifier whose only digits are a short suffix (value2, token10): code, not a secret.
const CODE_NAME = /^[A-Za-z_$][A-Za-z_$]*\d{0,2}$/;
/** True when a keyword is assigned something that looks like a real secret rather than code. */
function secretAssignment(s) {
  for (const m of s.matchAll(SECRET_ASSIGN_RE)) {
    const keyword = m[1].toLowerCase(), quoted = m[2] !== '', value = m[3];
    if (NOT_A_VALUE.test(value)) continue;
    // A PIN is short and all digits; anything else follows the general rule.
    if ((keyword === 'pin' || keyword === 'passcode') && /^\d{4,12}$/.test(value)) return true;
    if (quoted) { if (value.length >= 6 && !PLACEHOLDER.test(value)) return true; continue; }
    // A password is often a plain word ("letmein", "hunter2"): for the password family an unquoted
    // value of 6+ characters counts unless it is a placeholder, a call or a member access.
    if (PASSWORD_WORDS.has(keyword)) {
      if (value.length >= 6 && !PLACEHOLDER.test(value) && !CALL.test(value) && !MEMBER_ACCESS.test(value)) return true;
      continue;
    }
    // token, secret, API keys: code assigns these all the time, so an unquoted value must look like one.
    if (value.length >= 8 && /\d/.test(value) && !PLACEHOLDER.test(value) && !CALL.test(value) && !MEMBER_ACCESS.test(value) && !CODE_NAME.test(value)) return true;
  }
  return false;
}
// A JWT: matched as a whole dotted run (a match never fails once started, so it is linear), then
// its first three segments are checked in code.
const JWT_RE = /\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)*/g;
const KEY_SHAPE_RE = /\b[a-z]{2,8}[-_][A-Za-z0-9_-]{24,}\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;
const SCAN_LIMIT = 400_000;

/** A long key-shaped token: a short lowercase prefix, then 24+ characters mixing letters and digits. */
function keyShaped(s) {
  for (const m of s.matchAll(KEY_SHAPE_RE)) if (/\d/.test(m[0]) && /[A-Za-z]/.test(m[0].slice(m[0].search(/[-_]/) + 1))) return true;
  return false;
}

function jwtShaped(s) {
  for (const m of s.matchAll(JWT_RE)) { const [a, b, c] = m[0].split('.'); if (a.length >= 11 && b?.length >= 8 && c?.length >= 8) return true; }
  return false;
}

/** The first rule a text trips, as a flag code, or null. Pure; bounded; linear in the text. */
function preRule(text) {
  const s = String(text || '').slice(0, SCAN_LIMIT);
  if (SECRET_PATTERNS.some((re) => re.test(s)) || secretAssignment(s) || jwtShaped(s) || keyShaped(s)) return 'secret';
  for (const m of s.matchAll(IBAN_RE)) if (ibanValid(m[0])) return 'iban';
  for (const m of s.matchAll(CARD_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return 'card';
  }
  return null;
}

/** Diary content in what would be sent: a Diary tool's result in the history. */
function hasDiaryContent(history) {
  return (Array.isArray(history) ? history : []).some((h) => h && (h.role === 'tool' || h.role === 'function') && /^diary[_-]/i.test(String(h.name || '')));
}

// ── What the router role reads ──────────────────────────────────────────────

// The decision service rejects a state over its token budget instead of truncating it. Laya's
// /model/rl_agent_config.json has max_len 512 and head_max_len 192, and services/laya/server.py
// refuses a state over max_len - head_max_len - 16 = 304 tokens: roughly 1,000-1,200 characters of
// prose. The backend's advertised maxStateChars (decision-settings.cjs, 4000) is a character cap,
// not this token budget, so each router input is cut to this conservative size; a smaller
// backend limit wins (see chunkCharsFor).
const ROUTER_CHUNK_CHARS = 1000;
// One router call per turn by default: Laya (services/laya/server.py) is a plain single-threaded
// HTTPServer with one worker, so "parallel" chunk calls queue behind each other. At 0.5-1.4 s per
// decision against the 1.5 s deadline, 2-4 chunks time out and fail closed on every turn, and the
// stale queued calls slow the classify call that follows. The single chunk keeps the priority of
// routerChunks (message first, then the newest history and the context); the deterministic
// pre-rules still cover the full text. Raise it (1-4) with NOEVIA_ROUTER_CHUNKS only after
// measuring against a backend that serves decisions concurrently.
const ROUTER_MAX_CHUNKS = 1;
const ROUTER_CHUNKS_MAX_SETTING = 4;
const MAX_CHUNKS_CAP = 8;

/** The admin-set router chunk count (env NOEVIA_ROUTER_CHUNKS), bounded to 1-4, default 1. */
function routerMaxChunks(env = process.env) {
  const n = Math.floor(Number(env && env.NOEVIA_ROUTER_CHUNKS));
  return Number.isFinite(n) && n >= 1 ? Math.min(ROUTER_CHUNKS_MAX_SETTING, n) : ROUTER_MAX_CHUNKS;
}
const DIGEST_MAX = ROUTER_CHUNK_CHARS * MAX_CHUNKS_CAP; // hard cap on any one router payload
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join(' ') : '');

/** The chunk size to use for a backend: ROUTER_CHUNK_CHARS, or the backend's own smaller limit. */
function chunkCharsFor(backend) {
  const limit = Number(backend?.limits?.maxStateChars);
  return Number.isFinite(limit) && limit >= 200 ? Math.min(ROUTER_CHUNK_CHARS, Math.floor(limit)) : ROUTER_CHUNK_CHARS;
}

/** Max-min fair shares of `budget` for sections needing `needs` characters (in order). */
function fairShares(needs, budget) {
  const shares = needs.map(() => 0);
  let left = Math.max(0, budget);
  let open = needs.map((n, i) => i).filter((i) => needs[i] > 0);
  while (open.length && left > 0) {
    const each = Math.floor(left / open.length);
    if (each === 0) break;
    const next = [];
    for (const i of open) {
      const give = Math.min(each, needs[i] - shares[i]);
      shares[i] += give; left -= give;
      if (shares[i] < needs[i]) next.push(i);
    }
    open = next;
  }
  return shares;
}

/**
 * What the router role is asked about, as up to `maxChunks` strings of at most `chunkChars` each.
 * Covers, in this order: the message, the recent history (most recent first), the context (system
 * prompt, RAG, memory) and the attachment names. When everything does not fit, each section gets a
 * fair share (an empty or short section gives its unused room to the others), so neither history
 * nor attachments is ever dropped for a long message. What does not fit is still covered by the
 * deterministic pre-rules, which the caller runs over the whole text first.
 */
function routerChunks({ message, system, history, attachments }, { chunkChars = ROUTER_CHUNK_CHARS, maxChunks = ROUTER_MAX_CHUNKS } = {}) {
  const size = Math.max(200, Math.min(ROUTER_CHUNK_CHARS * 4, Math.floor(Number(chunkChars) || ROUTER_CHUNK_CHARS)));
  const count = Math.max(1, Math.min(MAX_CHUNKS_CAP, Math.floor(Number(maxChunks) || ROUTER_MAX_CHUNKS)));
  const hist = (Array.isArray(history) ? history : []).slice(-40).reverse()
    .map((h) => (h ? `${h.role}: ${textOf(h.content).slice(0, size * count)}` : '')).filter((t) => t.length > 2).join('\n');
  const names = (Array.isArray(attachments) ? attachments : []).filter((n) => typeof n === 'string' && n).join(', ');
  const sections = [
    ['Message', String(message || '')],
    ['Recent history (most recent first)', hist],
    ['Context', String(system || '')],
    ['Attachments', names],
  ].filter(([, text]) => text.trim());
  if (!sections.length) return [];
  const SEP = '\n\n';
  // Labels, the separators between sections and a little slack are paid for before the shares.
  const overhead = sections.reduce((n, [label]) => n + label.length + 2, 0) + SEP.length * (sections.length - 1);
  const shares = fairShares(sections.map(([, text]) => text.length), size * count - overhead);
  const whole = sections.map(([label, text], i) => `${label}:\n${text.slice(0, shares[i])}`).join(SEP);
  const chunks = [];
  for (let at = 0; at < whole.length && chunks.length < count; at += size) chunks.push(whole.slice(at, at + size));
  return chunks;
}

// ── The router role ─────────────────────────────────────────────────────────

const OPTIONS = Object.freeze([
  { id: 'sensitive', label: 'Private or confidential: health, finances, ID numbers, passwords, relationships, legal or work secrets' },
  { id: 'not_sensitive', label: 'General, public or harmless content that is fine to send to an external service' },
]);

/**
 * async (chunks) => { flagged, flag }. `chunks` is a string or an array of router inputs (see
 * routerChunks); they are asked one after another (the decision service is single-worker) within
 * ONE shared deadline budget: each call gets what is left, and once the budget is spent no further
 * chunk is sent and the turn fails closed. The turn is flagged when ANY chunk is judged sensitive
 * ('router', which also stops further calls) or any chunk fails ('unavailable'); an empty input is
 * a failure too. Never throws.
 */
function createSensitivity({ decide, deadlineMs = () => 1500, minConfidence = 0.6, maxChunks = MAX_CHUNKS_CAP, log = () => {} }) {
  async function one(text, deadline) {
    let result;
    try {
      if (typeof decide !== 'function') throw Error('no decision service');
      result = await decide({ kind: 'choice', purpose: 'routing.sensitivity',
        question: 'Does this content contain sensitive personal or confidential information?',
        context: { cloud: 'forbidden', stateText: String(text || '').slice(0, DIGEST_MAX) }, options: OPTIONS.map((o) => ({ ...o })),
        constraints: { deadlineMs: deadline, minConfidence }, fallback: { selected: null, scores: {} } });
    } catch { result = null; }
    const answered = result && result.source !== 'fallback' && OPTIONS.some((o) => o.id === result.selected);
    const confident = answered && (typeof result.confidence !== 'number' || result.confidence >= minConfidence);
    return !confident ? 'unavailable' : result.selected === 'sensitive' ? 'router' : null;
  }
  return async function check(input) {
    const list = (Array.isArray(input) ? input : [input]).map((t) => String(t || '')).filter(Boolean).slice(0, Math.max(1, maxChunks));
    const deadline = Math.max(100, Number(deadlineMs()) || 1500);
    let verdicts;
    try {
      // One overall deadline as well, so a backend that ignores its own cannot hold the turn.
      let timer;
      const late = new Promise((resolve) => { timer = setTimeout(() => resolve(['unavailable']), deadline + 250); });
      const run = async () => {
        if (!list.length) return ['unavailable'];
        const out = [];
        const start = Date.now();
        for (const t of list) {
          const left = deadline - (Date.now() - start);
          if (left < 50) { out.push('unavailable'); break; } // budget spent: send nothing more
          const v = await one(t, left);
          out.push(v);
          if (v === 'router') break;
        }
        return out;
      };
      verdicts = await Promise.race([run(), late]);
      clearTimeout(timer);
    } catch { verdicts = ['unavailable']; }
    const flag = verdicts.includes('router') ? 'router' : verdicts.includes('unavailable') ? 'unavailable' : null;
    const out = flag ? { flagged: true, flag } : { flagged: false, flag: null };
    try { log({ verdict: out.flag || 'clear', fellBack: verdicts.includes('unavailable'), chunks: list.length }); } catch { /* codes only, never breaks routing */ }
    return out;
  };
}

/**
 * Where an Auto turn goes. Pure apart from the injected `check` and `ask`.
 * @returns {Promise<{ route:'local'|'cloud', reason:string, flag?:string, remember?:'local'|'cloud' } | { cancel:true, reason:string }>}
 */
async function resolveRoute({ mode, whenSensitive = 'ask', hasCloud, hasLocal = true, hardLocal = false, forceLocal = false, allowCloud = false,
  preFlag = null, check = async () => ({ flagged: true, flag: 'unavailable' }), ask = async () => ({ choice: 'timeout' }) }) {
  const local = (reason, extra = {}) => (hasLocal ? { route: 'local', reason, ...extra } : { cancel: true, reason });
  if (hardLocal) return local('sensitive-rule', { flag: 'diary' });
  if (forceLocal) return local('force-local');
  if (mode === 'local' || !hasCloud) return local('mode');
  if (mode === 'cloud') return { route: 'cloud', reason: 'mode' };
  // hybrid
  let flag = preFlag;
  if (!flag) { const verdict = await check(); if (!verdict || verdict.flagged !== false) flag = verdict?.flag || 'unavailable'; }
  if (!flag) return { route: 'cloud', reason: 'mode' };
  const flagReason = flag === 'unavailable' ? 'fail-closed' : 'sensitive-rule';
  if (allowCloud) return { route: 'cloud', reason: 'remembered', flag };
  if (whenSensitive === 'local') return local(flagReason, { flag });
  let answer;
  try { answer = await ask(flag); } catch { answer = null; }
  if (answer?.choice === 'cloud') return { route: 'cloud', reason: 'user-choice', flag, ...(answer.remember ? { remember: 'cloud' } : {}) };
  if (answer?.choice === 'local') return local('user-choice', { flag, ...(answer.remember ? { remember: 'local' } : {}) });
  // Timed out, cancelled or unanswered: never cloud.
  return local('fail-closed', { flag });
}

/** The chat's stored routing flags, from the requesting user's own lists only. */
function chatFlags({ chatId, list }) {
  const meta = (Array.isArray(list) ? list : []).find((c) => c && c.id === chatId);
  return { forceLocal: meta?.forceLocal === true, allowCloud: meta?.allowCloud === true };
}

/** The cloud model for a role, falling back smart → fast → code. */
function cloudModel(cloud, role) {
  return cloud[role] || cloud.smart || cloud.fast || cloud.code || '';
}

module.exports = { MODES, WHEN_SENSITIVE, OPTIONS, FILE, ALLOWED_KEY, normalize, read, write, validate, allowedModes, setAllowedModes,
  effectiveMode, projectOverride, withProjectOverride, preRule, hasDiaryContent, routerChunks, chunkCharsFor, ROUTER_CHUNK_CHARS, ROUTER_MAX_CHUNKS, routerMaxChunks, createSensitivity, resolveRoute, chatFlags, cloudModel, ibanValid, luhn };
