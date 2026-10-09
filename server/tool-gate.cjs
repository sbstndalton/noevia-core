'use strict';
// Tool gate (experimental, features.toolGate). Small local models often answer in prose when a
// tool was offered and needed. Before the first model turn this decides, for one message, whether
// a READ-ONLY tool should be used, and how the chat loop should enforce it:
//
//   prefetch  the arguments follow from the message (a URL, a search query, a diary month), so
//             chat.cjs runs the tool first and hands the result to the model;
//   require   the tool is needed but its arguments are not, so the first model turn is sent with
//             tool_choice forcing that function.
//
// Stage 1 is deterministic rules (no model). Stage 2, only when no rule matched, asks the
// configured decision service to pick one offered read-only tool or "none", and accepts the
// answer only above a confidence bound. The gate never carries authority: it picks only from the
// tools already offered on this request (after tool policy and tool routing), never a write
// (writes keep the approval card), and every failure, timeout or doubt resolves to "none".
// Nothing here throws into the chat path.
//
// TOOL_GATE_IMPL=js|wasm (default js; any other value means js, with one warning), read from the
// `env` option (process.env) on every evaluate(). wasm also asks noevia-rs's tool-gate crate
// (dav-parse.wasm tool_gate) with the host's projections of the offered tools (name, read-only,
// description, which argument names the parameters have, required), the boxes and the clock. The
// JS answer is computed first and the port can only make the gate force less. "Safer" here means,
// in order: forcing no tool ('none', what the chat does with the gate off) is safer than requiring
// one (the model writes the arguments and the tool's own checks and approval apply), which is safer
// than prefetching one (the server runs it on arguments taken from the message: a search query
// sent out, a diary month read). So a tool is prefetched only if both prefetch it with the same
// arguments; it is required if one requires it and the other prefetches it; a different tool, a
// rule only one side sees, a different Stage 2 option list or answer, a fault or a bad reply is
// 'none' (reason impl-mismatch / impl-fault; the decision service is not asked after a rule or
// option mismatch); a rule decision the port made stricter is logged with reason impl-stricter. Warnings are logged once per event and reason and carry no input. The flag is
// in dav-parse-wasm.cjs IMPL_FLAGS (a missing or tampered module stops startup).

const { causeOf, CAUSE_RE } = require('./decision/index.cjs');

// Rule kind -> candidate tools in preference order. The first one offered on this request wins.
const DEFAULT_BOXES = Object.freeze({
  url: ['tavily_extract', 'web_fetch', 'fetch_url', 'browse'],
  search: ['tavily_search', 'web_search', 'wikipedia_search'],
  diary: ['diary_read_month', 'diary_read_today', 'diary_list_months'],
  drive: ['nc_webdav_search_files', 'drive_search_files', 'nc_webdav_find_by_name', 'nc_webdav_list_directory', 'project_search'],
});

// Default acceptance bound for a Stage 2 answer. It is compared with the LOWER end of the
// readout interval when the backend reports one (decision/backends.cjs llamaLogitBackend), else
// with the selected option's share. Neither is a calibrated probability of being right
// (readout-bounds.test.cjs), so this stays conservative until an evaluation run sets it.
const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_DEADLINE_MS = 1500;
const MAX_OPTIONS = 25; // the logit readout labels options A-Z; one slot is "none"

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/i;
const SEARCH_RE = /\b(search|look\s*up|google|latest|news|today'?s|current\s+price|price\s+of|weather|forecast)\b/i;
const DIARY_RE = /\b(in\s+my\s+diary|my\s+diary|my\s+journal|yesterday\s+I|last\s+(?:week|month)\s+I)\b/i;
const ISO_DATE_RE = /\b(20\d{2})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?\b/;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NAMED_DATE_RE = new RegExp(`\\b(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+)?(${MONTHS.join('|')})(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?(?:,?\\s+(20\\d{2}))?\\b`, 'i');
const DRIVE_RE = /\b(my\s+files?|a\s+file|the\s+file|files|folder|folders|document\s+named|drive|google\s+drive|nextcloud)\b/i;
const FILLER_RE = /\b(please|can\s+you|could\s+you|would\s+you|will\s+you|for\s+me|search(?:\s+the\s+web)?(?:\s+for)?|look\s*up|google|find\s+out|tell\s+me|what(?:'s|\s+is|\s+are)|who(?:'s|\s+is)|show\s+me|i\s+want\s+to\s+know|quickly|hey|hi)\b/gi;

// A search prefetch sends the query to an external service. Only a short, single-line message
// is sent that way; anything longer (pasted text, code, quotes) makes the model write the query.
const SEARCH_PREFETCH_MAX_CHARS = 120;
function prefetchableSearch(message) {
  const text = String(message || '');
  return text.trim().length <= SEARCH_PREFETCH_MAX_CHARS && !/[\r\n]/.test(text) && !/```|~~~/.test(text) && !/^\s*>/.test(text);
}

// A URL is pre-fetched only when it plainly names a public web host: http(s), no credentials,
// no IP literal in a private/loopback/link-local range, no local-only or single-label name.
// Pattern only, no DNS: anything else falls back to 'require', where the tool's own checks apply.
const LOCAL_SUFFIX_RE = /(^|\.)(localhost|local|internal|lan|home\.arpa|intranet|corp)$/i;
function publicUrlPattern(raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return false;
  // #1224: an empty label (`nas.local..`, `10.0.0.1..`, which WHATWG parses as a name) is not public.
  if (host.split('.').some((l) => !l)) return false;
  if (require('node:net').isIP(host)) return !require('./ssrf.cjs').isPrivateIp(host);
  if (!host.includes('.') || LOCAL_SUFFIX_RE.test(host)) return false;
  return true;
}

/** `.replace(/[set]+$/, '')` as one backwards scan (#1223: the regex is quadratic in V8). */
function stripTrailing(s, set) {
  let e = s.length;
  while (e > 0 && set.includes(s[e - 1])) e--;
  return s.slice(0, e);
}

const pad = (n) => String(n).padStart(2, '0');
const monthKey = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;

/** A search query from the message: filler words and trailing punctuation removed. */
function searchQuery(message) {
  const q = stripTrailing(String(message || '').replace(FILLER_RE, ' '), '?!.').replace(/\s+/g, ' ').trim();
  return (q || String(message || '').trim()).slice(0, 300);
}

/** The diary month (YYYY-MM) the message points at, or null. `now` fixes "yesterday". */
function diaryMonth(message, now) {
  const text = String(message || '');
  const iso = text.match(ISO_DATE_RE);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const named = text.match(NAMED_DATE_RE);
  if (named && (named[1] || named[3] || named[4])) {
    const year = named[4] ? Number(named[4]) : new Date(now()).getUTCFullYear();
    return `${year}-${pad(MONTHS.indexOf(named[2].toLowerCase()) + 1)}`;
  }
  if (/\byesterday\b/i.test(text)) return monthKey(new Date(now() - 86_400_000));
  if (/\btoday\b/i.test(text)) return monthKey(new Date(now()));
  return null;
}

const toolName = (t) => t?.function?.name;
const paramsOf = (tool) => tool?.function?.parameters || {};
const requiredOf = (tool) => (Array.isArray(paramsOf(tool).required) ? paramsOf(tool).required : []);
const propsOf = (tool) => paramsOf(tool).properties || {};

/** Arguments for a prefetch, or null when they cannot be derived safely from the message. */
function deriveArgs(kind, tool, message, now, stage = 'rule') {
  const props = propsOf(tool), required = requiredOf(tool);
  const fits = (args) => required.every((k) => Object.hasOwn(args, k)) && Object.keys(args).every((k) => Object.hasOwn(props, k) || !Object.keys(props).length) ? args : null;
  if (kind === 'url') {
    const match = String(message).match(URL_RE)?.[0];
    const url = match === undefined ? undefined : stripTrailing(match, '.,;:!?');
    if (!url || !publicUrlPattern(url)) return null;
    if (props.urls) return fits({ urls: [url] });
    if (props.url) return fits({ url });
    return null;
  }
  if (kind === 'search') {
    // The decision service never triggers a search prefetch: only the explicit rule, on a short message.
    if (stage !== 'rule' || !prefetchableSearch(message)) return null;
    if (props.query) return fits({ query: searchQuery(message) });
    if (props.q) return fits({ q: searchQuery(message) });
    return null;
  }
  if (kind === 'diary') {
    if (required.length === 0 && !props.month) return {}; // e.g. read today
    const month = diaryMonth(message, now);
    if (month && props.month) return fits({ month });
    return null;
  }
  return null; // drive and anything else: the model has to name the path/query itself
}

/** ruleDecision: the Stage 1 rule that matched and its decision, or null. `offered` is the
 *  request's Map of tools by name; `readOnly(name)` never throws. */
function ruleDecisionWith(message, offered, { boxes, readOnly, now }) {
  const text = String(message || '');
  const kinds = [];
  if (URL_RE.test(text)) kinds.push('url');
  if (DIARY_RE.test(text) || /\b(diary|journal)\b/i.test(text)) kinds.push('diary');
  if (SEARCH_RE.test(text)) kinds.push('search');
  // A bare explicit date ("on 3 March", "2026-09-01") points at the diary when one is offered.
  if (ISO_DATE_RE.test(text) || (NAMED_DATE_RE.exec(text) || []).slice(1).some((g, i) => i !== 1 && g)) kinds.push('diary');
  if (DRIVE_RE.test(text)) kinds.push('drive');
  for (const kind of kinds) {
    for (const name of boxes[kind] || []) {
      const tool = offered.get(name);
      if (!tool || !readOnly(name)) continue; // not offered, or a write: this rule does not apply
      const args = deriveArgs(kind, tool, text, now);
      return { rule: kind, decision: args ? { tool: name, args, mode: 'prefetch' } : { tool: name, mode: 'require' } };
    }
  }
  return null;
}

/** readout's options before the service is asked: the offered read-only tools (#739: a confirmed
 *  "search" frame puts the offered web and project-search tools first, so they survive option
 *  trimming; only reorders what is offered, nothing is added), the question, and shapeOptions. */
function readoutOptions(offered, { boxes, readOnly, bias, limits }) {
  let readTools = [...offered.values()].filter((t) => readOnly(toolName(t)));
  const preferred = Array.isArray(bias?.prefer) ? bias.prefer.flatMap((k) => boxes[k] || []) : [];
  if (preferred.length) {
    const rank = (t) => { const i = preferred.indexOf(toolName(t)); return i < 0 ? preferred.length : i; };
    readTools = readTools.map((t, i) => [t, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([t]) => t);
  }
  const question = typeof bias?.hint === 'string' && bias.hint ? `${QUESTION} ${bias.hint.slice(0, 160)}` : QUESTION;
  return { readTools, preferred, question, shape: () => shapeOptions(readTools, limits, boxes, question.length, preferred) };
}

/** readout's reading of a service answer that is not a fallback: { reason, confidence? } or
 *  { confidence, decision }. */
function readAnswer(result, message, offered, { boxes, readOnly, now, minConfidence }) {
  const selected = result?.selected;
  if (selected === 'none' || !selected) return { reason: 'none', confidence: confidenceOf(result, 'none') };
  if (!offered.has(selected) || !readOnly(selected)) return { reason: 'not-offered' };
  const confidence = confidenceOf(result, selected);
  if (!(confidence >= minConfidence)) return { reason: 'low-confidence', confidence };
  const kind = Object.keys(boxes).find((k) => k !== 'drive' && (boxes[k] || []).includes(selected));
  const args = kind ? deriveArgs(kind, offered.get(selected), message, now, 'decision') : null;
  return { confidence, decision: args ? { tool: selected, args, mode: 'prefetch' } : { tool: selected, mode: 'require' } };
}

/**
 * @param {{ enabled: () => boolean, decide: (request: object) => Promise<object>,
 *           boxes?: Record<string,string[]>, isWriteTool: (name: string) => boolean,
 *           log?: (entry: object) => void, now?: () => number,
 *           minConfidence?: number | (() => number), deadlineMs?: number | (() => number) }} deps
 *   decide: the decision layer's decide() (decision/index.cjs); its purpose is 'tool.gate'.
 *   log: text-free entries only (tool names, source, mode, confidence, timings, never the message).
 */
function createToolGate({ enabled, decide, boxes = DEFAULT_BOXES, isWriteTool, log = () => {}, now = Date.now,
  minConfidence = DEFAULT_MIN_CONFIDENCE, deadlineMs = DEFAULT_DEADLINE_MS, limits = null, unavailable = () => null,
  warn = (line) => console.warn(line), env = process.env, wasmLoader = defaultLoader }) {
  const value = (v) => (typeof v === 'function' ? v() : v);
  const safeLog = (entry) => { try { log(entry); } catch { /* logging never breaks a chat */ } };
  // #682: a decision service that cannot answer `choice` is reported once (and in Settings, via
  // features availability), not rediscovered as a silent fallback on every message.
  let warned = null;
  function stage2Blocked() {
    let reason = null;
    try { reason = unavailable() || null; } catch { reason = 'Decision service status unknown.'; }
    if (reason && warned !== reason) { warned = reason; try { warn(`[system-one] tool gate: stage 2 is off. ${reason}`); } catch { /* console gone */ } }
    if (!reason) warned = null;
    return reason ? (/does not support/.test(reason) ? 'unsupported' : 'unconfigured') : null;
  }
  const readOnly = (name) => { try { return !isWriteTool(name); } catch { return false; } };

  const ruleDecision = (message, offered) => ruleDecisionWith(message, offered, { boxes, readOnly, now });

  async function readout(message, offered, bias, impl) {
    const lim = value(limits);
    const { readTools, question, shape } = readoutOptions(offered, { boxes, readOnly, bias, limits: lim });
    if (!readTools.length) return { reason: 'no-read-tools' };
    const blocked = stage2Blocked();
    if (blocked) return { reason: blocked };
    const shaped = shape();
    if (!shaped.options.length) return { reason: 'no-options-fit' };
    if (impl === 'wasm' && !confirmOptions(shaped, offered, bias, lim)) return { reason: portReason };
    const { options } = shaped;
    const trim = { options: options.length, ...(shaped.trimmed ? { trimmed: shaped.trimmed } : {}) };
    const ms = Math.max(1, Number(value(deadlineMs)) || DEFAULT_DEADLINE_MS);
    let timer;
    const result = await Promise.race([
      Promise.resolve().then(() => decide({ kind: 'choice', purpose: 'tool.gate',
        question,
        context: { cloud: 'forbidden', stateText: String(message).slice(0, 1000) }, options,
        constraints: { deadlineMs: ms, temperature: 0 }, fallback: { selected: null, scores: {} } })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('deadline'), { deadline: true })), ms + 250); }),
    ]).finally(() => clearTimeout(timer));
    if (!result || result.source === 'fallback') {
      const cause = result?.metadata?.cause;
      return { reason: result?.metadata?.fellBack || 'fallback', extra: { ...trim, ...(typeof cause === 'string' && CAUSE_RE.test(cause) ? { cause } : {}) } };
    }
    const min = value(minConfidence);
    const read = readAnswer(result, message, offered, { boxes, readOnly, now, minConfidence: min });
    if (impl === 'wasm') {
      const checked = confirmAnswer(read, result, message, offered, min);
      if (!checked) return { reason: portReason, extra: trim };
      return { ...checked, extra: trim };
    }
    return { ...read, extra: trim };
  }

  // ── TOOL_GATE_IMPL=wasm: the port confirms; it can only make the gate force less ──
  let portReason = 'impl-fault';
  /** Ask the port; undefined (after a warning) when it throws. Projections are built inside, so a
   *  value that cannot be projected is a fault too. */
  function ask(fn) {
    try { return fn(wasmLoader()); } catch (err) {
      portReason = 'impl-fault';
      portWarn('tool_gate.wasm_fault', String(err?.reason || 'unexpected').slice(0, 40));
      return undefined;
    }
  }
  const project = (offered) => offeredProjection(offered, readOnly);
  /** The rule decision both sides agree on, the stricter one, or undefined (no tool is forced). */
  function confirmRule(ruled, message, offered) {
    const port = ask((m) => m.toolGateRule(String(message || ''), project(offered), clock(now), boxesProjection(boxes)));
    if (port === undefined) return undefined;
    if (!ruled && port.rule === null) return null;
    const merged = ruled && port.rule === ruled.rule ? stricterDecision(ruled.decision, port.decision) : undefined;
    if (ruled && merged === ruled.decision) return ruled;
    portReason = 'impl-mismatch';
    portWarn('tool_gate.impl_mismatch', merged ? 'rule-mode' : 'rule');
    return merged ? { rule: ruled.rule, decision: merged } : undefined;
  }
  function confirmOptions(shaped, offered, bias, lim) {
    const port = ask((m) => m.toolGateOptions(project(offered), Array.isArray(bias?.prefer) ? bias.prefer.map(keyOf) : null,
      typeof bias?.hint === 'string' && bias.hint ? bias.hint : null, limitsProjection(lim), boxesProjection(boxes)));
    if (port === undefined) return false;
    const same = port.trimmed === shaped.trimmed && port.options.length === shaped.options.length
      && port.options.every((o, i) => o.id === shaped.options[i].id && o.label === shaped.options[i].label);
    if (!same) { portReason = 'impl-mismatch'; portWarn('tool_gate.impl_mismatch', 'options'); }
    return same;
  }
  /** The answer both read the same way, the stricter decision, or undefined (no tool is forced). */
  function confirmAnswer(read, result, message, offered, min) {
    const selected = result?.selected;
    const port = ask((m) => {
      const id = typeof selected === 'string' ? selected : null;
      const finite = (v) => (Number.isFinite(v) ? v : null);
      return m.toolGateAnswer(String(message), project(offered), clock(now), boxesProjection(boxes),
        typeof selected === 'string' ? selected : (selected ? true : null),
        id === null ? null : finite(result?.metadata?.bounds?.[id]?.[0]), id === null ? null : finite(result?.scores?.[id]),
        finite(result?.confidence), numberProjection(Number(min)));
    });
    if (port === undefined) return undefined;
    if (!read.decision) {
      if (port.reason !== read.reason) portWarn('tool_gate.impl_mismatch', 'answer-reason');
      return read; // no tool forced either way
    }
    const merged = port.decision ? stricterDecision(read.decision, port.decision) : undefined;
    if (merged === read.decision) return read;
    portReason = 'impl-mismatch';
    portWarn('tool_gate.impl_mismatch', merged ? 'answer-mode' : 'answer');
    return merged ? { confidence: read.confidence, decision: merged } : undefined;
  }

  /**
   * @param {string} message  the user's message for this turn
   * @param {object[]} offeredTools  the OpenAI-shaped tools this request will actually send
   * @param {object|null} [bias]  chat-frame-steering.cjs gateBias(): may only narrow or prefer
   */
  async function evaluate(message, offeredTools, bias = null) {
    const started = now();
    const done = (out, extra = {}) => {
      const result = { ...out, elapsedMs: Math.max(0, now() - started) };
      const d = result.decision;
      safeLog({ event: 'decision', source: result.source, tool: d === 'none' ? 'none' : d.tool, mode: d === 'none' ? null : d.mode,
        confidence: typeof result.confidence === 'number' ? Math.round(result.confidence * 1000) / 1000 : null,
        offered: offeredTools?.length || 0, ms: result.elapsedMs, ...extra });
      return result;
    };
    try {
      if (!enabled()) return { decision: 'none', source: 'none', elapsedMs: 0 }; // off: silent, no log
      const offered = new Map((Array.isArray(offeredTools) ? offeredTools : []).filter((t) => typeof toolName(t) === 'string').map((t) => [toolName(t), t]));
      if (!offered.size) return done({ decision: 'none', source: 'none' }, { reason: 'no-tools' });
      if (bias?.noForce) return done({ decision: 'none', source: 'none' }, { reason: 'frame' });
      const impl = toolGateImpl(env);
      let ruled = ruleDecision(message, offered);
      if (impl === 'wasm') {
        const checked = confirmRule(ruled, message, offered);
        if (checked === undefined) return done({ decision: 'none', source: 'none' }, { reason: portReason, ...(ruled ? { rule: ruled.rule } : {}) });
        if (checked !== ruled) { ruled = checked; return done({ decision: ruled.decision, source: 'rule' }, { rule: ruled.rule, reason: 'impl-stricter' }); }
      }
      if (ruled) return done({ decision: ruled.decision, source: 'rule' }, { rule: ruled.rule });
      const read = await readout(message, offered, bias, impl);
      if (read.decision) return done({ decision: read.decision, source: 'decision', confidence: read.confidence }, read.extra);
      return done({ decision: 'none', source: 'none', ...(typeof read.confidence === 'number' ? { confidence: read.confidence } : {}) }, { reason: read.reason, ...read.extra });
    } catch (error) {
      return done({ decision: 'none', source: 'none' }, { reason: error?.deadline ? 'deadline' : 'error', cause: causeOf(error) });
    }
  }

  /** Text-free record of what the chat loop did with a decision (prefetch failed, gate.miss, ...). */
  function record(event, entry = {}) { safeLog({ event, ...entry }); }

  return { evaluate, record };
}

const QUESTION = 'Which tool, if any, must the assistant call before answering this user message?';
const NONE_ID = 'none';
const MIN_LABEL_CHARS = 12;

/**
 * The Stage 2 options for this request (#682). Without backend limits: every read-only tool (up to
 * the readout's 25 labels) as "name: description". With limits (the private decision service takes
 * at most 8 options of 120 characters, and question plus options must fit its option-head token
 * budget): tools the gate's rules know come first, the rest in offered order, then as many as fit
 * with a label of at least MIN_LABEL_CHARS; the service sees the id, so the label is the description
 * alone. "none" is always the last option. `trimmed` counts tools left out.
 */
function shapeOptions(readTools, limits, boxes = DEFAULT_BOXES, questionChars = QUESTION.length, preferred = []) {
  const describe = (t) => String(t.function?.description || '').replace(/\s+/g, ' ').trim();
  if (!limits || !Number.isFinite(limits.maxOptions)) {
    const tools = readTools.slice(0, MAX_OPTIONS - 1);
    return { trimmed: readTools.length - tools.length, options: [...tools.map((t) => ({ id: toolName(t), label: `${toolName(t)}: ${describe(t).slice(0, 160)}` })),
      { id: NONE_ID, label: 'none: answer directly, no tool is needed' }] };
  }
  const known = [...preferred, ...Object.values(boxes).flat()];
  const rank = (t) => { const i = known.indexOf(toolName(t)); return i < 0 ? known.length : i; };
  const ordered = readTools.map((t, i) => [t, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([t]) => t);
  const none = { id: NONE_ID, label: 'No tool: answer directly' };
  const maxLabel = Math.max(1, Number(limits.maxLabelChars) || 120);
  const budget = (Number(limits.maxChoiceChars) || Infinity) - questionChars - (none.id.length + none.label.length + 2);
  let tools = ordered.slice(0, Math.max(0, Math.min(MAX_OPTIONS, limits.maxOptions) - 1));
  for (;;) {
    const idChars = tools.reduce((n, t) => n + toolName(t).length + 2, 0);
    const per = tools.length ? Math.min(maxLabel, Math.floor((budget - idChars) / tools.length)) : 0;
    if (!tools.length || per >= MIN_LABEL_CHARS) {
      return { trimmed: readTools.length - tools.length, options: tools.length ? [...tools.map((t) => ({ id: toolName(t), label: (describe(t) || toolName(t)).slice(0, per) })), none] : [] };
    }
    tools = tools.slice(0, -1);
  }
}

/** Lower bound of the selected option's readout interval if reported, else its share/confidence. */
function confidenceOf(result, id) {
  const lower = result?.metadata?.bounds?.[id]?.[0];
  if (Number.isFinite(lower)) return lower;
  if (Number.isFinite(result?.scores?.[id])) return result.scores[id];
  return Number.isFinite(result?.confidence) ? result.confidence : null;
}

// ── TOOL_GATE_IMPL ──────────────────────────────────────────────────────────

const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';
/** TOOL_GATE_IMPL: 'js' (default) or 'wasm'. */
function toolGateImpl(env = process.env) {
  const raw = env?.TOOL_GATE_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const v = String(raw).trim().toLowerCase();
  if (IMPLS.has(v)) return v;
  if (warnedImpl !== v) {
    warnedImpl = v;
    console.warn(`[tool-gate] TOOL_GATE_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}
const defaultLoader = () => require('./dav-parse-wasm.cjs');
const warnedPort = new Set();
function portWarn(event, reason) {
  const key = `${event}:${reason}`;
  if (warnedPort.has(key)) return;
  warnedPort.add(key);
  console.warn(`[tool-gate] ${event} (${reason}); the stricter answer was used`);
}

// What the rules read, as the JS reads it.
const ARG_KEYS = ['urls', 'url', 'query', 'q', 'month'];
const keyOf = (k) => (typeof k === 'symbol' ? null : String(k));
/** One offered tool: name, readOnly(name), String(description || ''), which argument names its
 *  parameters.properties has (own) and holds truthy, whether it has any key, and required. */
function toolProjection(tool, readOnly) {
  const name = toolName(tool);
  const props = propsOf(tool);
  return {
    name, readOnly: readOnly(name) === true, description: String(tool.function?.description || ''),
    own: ARG_KEYS.filter((k) => Object.hasOwn(props, k)), truthy: ARG_KEYS.filter((k) => !!props[k]),
    anyProps: Object.keys(props).length > 0, required: Array.from(requiredOf(tool), keyOf),
  };
}
/** The request's Map of offered tools, in its order. */
const offeredProjection = (offered, readOnly) => [...offered.values()].map((t) => toolProjection(t, readOnly));
/** boxes in Object.keys order; a list each (a missing one is empty; anything else that is not a
 *  list cannot be projected). */
function boxesProjection(boxes) {
  return Object.keys(boxes).map((k) => {
    const v = boxes[k];
    if (v === undefined || v === null) return [k, []];
    if (!Array.isArray(v)) throw Object.assign(Error('a box list is not a list'), { reason: 'boxes' });
    return [k, Array.from(v, (n) => (typeof n === 'string' ? n : null))];
  });
}
/** A number for the wire: finite as is, else a string the port reads (JSON has no NaN). */
const numberProjection = (n) => (Number.isFinite(n) ? n : n === Infinity ? 'Infinity' : n === -Infinity ? '-Infinity' : 'NaN');
function clock(now) {
  const t = now();
  if (typeof t !== 'number') throw Object.assign(Error('the clock is not a number'), { reason: 'clock' });
  return Number.isFinite(t) ? t : null;
}
/** shapeOptions' limits as it reads them: null where it uses none. */
function limitsProjection(limits) {
  if (!limits || !Number.isFinite(limits.maxOptions)) return null;
  return { maxOptions: limits.maxOptions, maxLabelChars: numberProjection(Math.max(1, Number(limits.maxLabelChars) || 120)),
    maxChoiceChars: numberProjection(Number(limits.maxChoiceChars) || Infinity) };
}
const argsText = (d) => JSON.stringify(d.args);
/** The stricter of two decisions on the same tool: prefetch only when both prefetch the same
 *  arguments, else require. A different tool: undefined (no tool is forced). Returns `js` itself
 *  when it stands. */
function stricterDecision(js, port) {
  if (!js || !port || port.tool !== js.tool) return undefined;
  if (js.mode === 'require') return js;
  if (port.mode === 'prefetch' && argsText(port) === argsText(js)) return js;
  return { tool: js.tool, mode: 'require' };
}

module.exports = { createToolGate, shapeOptions, searchQuery, diaryMonth, publicUrlPattern, prefetchableSearch, DEFAULT_BOXES, DEFAULT_MIN_CONFIDENCE,
  toolGateImpl, ruleDecisionWith, readoutOptions, readAnswer, toolProjection, offeredProjection, boxesProjection, limitsProjection,
  numberProjection, stricterDecision, QUESTION };
