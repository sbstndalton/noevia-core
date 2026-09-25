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
  if (require('node:net').isIP(host)) return !require('./ssrf.cjs').isPrivateIp(host);
  if (!host.includes('.') || LOCAL_SUFFIX_RE.test(host)) return false;
  return true;
}

const pad = (n) => String(n).padStart(2, '0');
const monthKey = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;

/** A search query from the message: filler words and trailing punctuation removed. */
function searchQuery(message) {
  const q = String(message || '').replace(FILLER_RE, ' ').replace(/[?!.]+$/g, '').replace(/\s+/g, ' ').trim();
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
    const url = String(message).match(URL_RE)?.[0].replace(/[.,;:!?]+$/, '');
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

/**
 * @param {{ enabled: () => boolean, decide: (request: object) => Promise<object>,
 *           boxes?: Record<string,string[]>, isWriteTool: (name: string) => boolean,
 *           log?: (entry: object) => void, now?: () => number,
 *           minConfidence?: number | (() => number), deadlineMs?: number | (() => number) }} deps
 *   decide: the decision layer's decide() (decision/index.cjs); its purpose is 'tool.gate'.
 *   log: text-free entries only (tool names, source, mode, confidence, timings, never the message).
 */
function createToolGate({ enabled, decide, boxes = DEFAULT_BOXES, isWriteTool, log = () => {}, now = Date.now,
  minConfidence = DEFAULT_MIN_CONFIDENCE, deadlineMs = DEFAULT_DEADLINE_MS }) {
  const value = (v) => (typeof v === 'function' ? v() : v);
  const safeLog = (entry) => { try { log(entry); } catch { /* logging never breaks a chat */ } };
  const readOnly = (name) => { try { return !isWriteTool(name); } catch { return false; } };

  function ruleDecision(message, offered) {
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

  async function readout(message, offered) {
    const tools = [...offered.values()].filter((t) => readOnly(toolName(t))).slice(0, MAX_OPTIONS - 1);
    if (!tools.length) return { reason: 'no-read-tools' };
    const options = [...tools.map((t) => ({ id: toolName(t), label: `${toolName(t)}: ${String(t.function?.description || '').slice(0, 160)}` })),
      { id: 'none', label: 'none: answer directly, no tool is needed' }];
    const ms = Math.max(1, Number(value(deadlineMs)) || DEFAULT_DEADLINE_MS);
    let timer;
    const result = await Promise.race([
      Promise.resolve().then(() => decide({ kind: 'choice', purpose: 'tool.gate',
        question: 'Which tool, if any, must the assistant call before answering this user message?',
        context: { cloud: 'forbidden', stateText: String(message).slice(0, 1000) }, options,
        constraints: { deadlineMs: ms, temperature: 0 }, fallback: { selected: null, scores: {} } })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('deadline'), { deadline: true })), ms + 250); }),
    ]).finally(() => clearTimeout(timer));
    const selected = result?.selected;
    if (!result || result.source === 'fallback') return { reason: result?.metadata?.fellBack || 'fallback' };
    if (selected === 'none' || !selected) return { reason: 'none', confidence: confidenceOf(result, 'none') };
    if (!offered.has(selected) || !readOnly(selected)) return { reason: 'not-offered' };
    const confidence = confidenceOf(result, selected);
    if (!(confidence >= value(minConfidence))) return { reason: 'low-confidence', confidence };
    const kind = Object.keys(boxes).find((k) => k !== 'drive' && (boxes[k] || []).includes(selected));
    const args = kind ? deriveArgs(kind, offered.get(selected), message, now, 'decision') : null;
    return { confidence, decision: args ? { tool: selected, args, mode: 'prefetch' } : { tool: selected, mode: 'require' } };
  }

  /**
   * @param {string} message  the user's message for this turn
   * @param {object[]} offeredTools  the OpenAI-shaped tools this request will actually send
   */
  async function evaluate(message, offeredTools) {
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
      const ruled = ruleDecision(message, offered);
      if (ruled) return done({ decision: ruled.decision, source: 'rule' }, { rule: ruled.rule });
      const read = await readout(message, offered);
      if (read.decision) return done({ decision: read.decision, source: 'decision', confidence: read.confidence });
      return done({ decision: 'none', source: 'none', ...(typeof read.confidence === 'number' ? { confidence: read.confidence } : {}) }, { reason: read.reason });
    } catch (error) {
      return done({ decision: 'none', source: 'none' }, { reason: error?.deadline ? 'deadline' : 'error' });
    }
  }

  /** Text-free record of what the chat loop did with a decision (prefetch failed, gate.miss, ...). */
  function record(event, entry = {}) { safeLog({ event, ...entry }); }

  return { evaluate, record };
}

/** Lower bound of the selected option's readout interval if reported, else its share/confidence. */
function confidenceOf(result, id) {
  const lower = result?.metadata?.bounds?.[id]?.[0];
  if (Number.isFinite(lower)) return lower;
  if (Number.isFinite(result?.scores?.[id])) return result.scores[id];
  return Number.isFinite(result?.confidence) ? result.confidence : null;
}

module.exports = { createToolGate, searchQuery, diaryMonth, publicUrlPattern, prefetchableSearch, DEFAULT_BOXES, DEFAULT_MIN_CONFIDENCE };
