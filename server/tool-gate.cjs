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
// The rules and the reading of Stage 2 are noevia-rs's tool-gate crate (dav-parse.wasm tool_gate); since #1071 they are
// the only implementation (the JS rules, the JS option shaping and the TOOL_GATE_IMPL switch that compared the two were
// deleted). This file builds the crate's inputs from the request (the offered tools' name, read-only flag, description,
// which argument names their parameters have, required; the boxes; the clock; the budget limits; the answer of the
// decision service), asks it, and applies its answer alone. Nothing the crate cannot answer is ever forced: a fault, a
// refusal or a reply of the wrong shape is 'none' (reason impl-fault, what the chat does with the gate off), as it was
// when the port and the JS disagreed before. The decision service is not asked after a fault in the rules or in the
// options. A fault is logged once, and again at the 10th, 100th, 1000th and so on, without the message.

const { causeOf, CAUSE_RE } = require('./decision/index.cjs');

// Rule kind -> candidate tools in preference order. The first one offered on this request wins (the crate applies it).
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

const toolName = (t) => t?.function?.name;
const paramsOf = (tool) => tool?.function?.parameters || {};
const requiredOf = (tool) => (Array.isArray(paramsOf(tool).required) ? paramsOf(tool).required : []);
const propsOf = (tool) => paramsOf(tool).properties || {};

/**
 * @param {{ enabled: () => boolean, decide: (request: object) => Promise<object>,
 *           boxes?: Record<string,string[]>, isWriteTool: (name: string) => boolean,
 *           log?: (entry: object) => void, now?: () => number,
 *           minConfidence?: number | (() => number), deadlineMs?: number | (() => number) }} deps
 *   decide: the decision layer's decide() (decision/index.cjs); its purpose is 'tool.gate'.
 *   log: text-free entries only (tool names, source, mode, confidence, timings, never the message).
 */
function createToolGate({ enabled, decide, boxes = DEFAULT_BOXES, isWriteTool, log = () => {}, now = Date.now,
  minConfidence = DEFAULT_MIN_CONFIDENCE, deadlineMs = DEFAULT_DEADLINE_MS, limits = null, unavailable = () => null, wording = 'laya',
  warn = (line) => console.warn(line), wasmLoader = defaultLoader }) {
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

  // ── the crate answers; nothing it cannot answer is forced ──
  /** Ask the crate; undefined (after a counted warning) when it throws or refuses. The projections are built inside, so a
   *  value that cannot be projected is a fault too. */
  function ask(fn) {
    try { return fn(wasmLoader()); } catch (err) {
      portWarn('tool_gate.wasm_fault', String(err?.reason || 'unexpected').slice(0, 40));
      return undefined;
    }
  }
  const project = (offered) => offeredProjection(offered, readOnly);
  /** The host's own floor under the crate: a decision forces only a tool this request offers and that is read-only, with the
   *  arguments of its mode. Anything else is a fault of the crate (counted warning), never a forced tool. */
  function confined(decision, offered, what) {
    const ok = !!decision && typeof decision === 'object' && typeof decision.tool === 'string' && offered.has(decision.tool) && readOnly(decision.tool)
      && (decision.mode === 'require' || (decision.mode === 'prefetch' && !!decision.args && typeof decision.args === 'object' && !Array.isArray(decision.args)));
    if (!ok) { portWarn('tool_gate.bad_decision', what); return false; }
    if (decision.mode === 'prefetch') {
      const tool = offered.get(decision.tool);
      const requiredPresent = Array.from(requiredOf(tool)).every((key) => typeof key !== 'symbol' && Object.hasOwn(decision.args, String(key)));
      // Stage 2 may require a search, but must never send the message as a search query itself.
      // Use the same first matching kind as the crate, including caller-provided box order.
      const kind = Object.keys(boxes).find((key) => key !== 'drive' && (boxes[key] || []).includes(decision.tool));
      if (!requiredPresent || (what === 'answer' && kind === 'search')) {
        portWarn('tool_gate.bad_decision', what);
        return false;
      }
    }
    return true;
  }

  async function readout(message, offered, bias) {
    // #1639: the wording of the model behind the service; only the Kev question is longer than the port
    // counts, so only it lowers the choice budget (Laya: the limits as given, as before #1639).
    let words = 'laya';
    try { words = value(wording) === 'kev' ? 'kev' : 'laya'; } catch { /* unknown: Laya's */ }
    const lim = budgetLimits(value(limits), questionFor(words));
    if (![...offered.values()].some((t) => readOnly(toolName(t)))) return { reason: 'no-read-tools' };
    const hint = typeof bias?.hint === 'string' && bias.hint ? bias.hint : '';
    const question = hint ? `${questionFor(words)} ${hint.slice(0, 160)}` : questionFor(words);
    const blocked = stage2Blocked();
    if (blocked) return { reason: blocked };
    // #739: a confirmed "search" frame puts the offered web and project-search tools first, so they survive option trimming.
    const shaped = ask((m) => m.toolGateOptions(project(offered), Array.isArray(bias?.prefer) ? bias.prefer.map(keyOf) : null,
      hint || null, limitsProjection(lim), boxesProjection(boxes)));
    if (shaped === undefined) return { reason: 'impl-fault' };
    if (!shaped.options.length) return { reason: 'no-options-fit' };
    const options = shaped.options.map((o) => ({ id: o.id, label: o.label }));
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
    const selected = result?.selected;
    const read = ask((m) => {
      const id = typeof selected === 'string' ? selected : null;
      const finite = (v) => (Number.isFinite(v) ? v : null);
      return m.toolGateAnswer(String(message), project(offered), clock(now), boxesProjection(boxes),
        typeof selected === 'string' ? selected : (selected ? true : null),
        id === null ? null : finite(result?.metadata?.bounds?.[id]?.[0]), id === null ? null : finite(result?.scores?.[id]),
        finite(result?.confidence), numberProjection(Number(min)));
    });
    if (read === undefined || !read || typeof read !== 'object') { if (read !== undefined) portWarn('tool_gate.bad_decision', 'answer'); return { reason: 'impl-fault', extra: trim }; }
    // The confidence is only reported (the log, the verdict); the crate decided whether it clears the bound.
    if (read.decision) {
      if (!confined(read.decision, offered, 'answer')) return { reason: 'impl-fault', extra: trim };
      return { confidence: confidenceOf(result, selected), decision: read.decision, extra: trim };
    }
    if (!['none', 'not-offered', 'low-confidence'].includes(read.reason)) { portWarn('tool_gate.bad_decision', 'answer'); return { reason: 'impl-fault', extra: trim }; }
    const reported = read.reason === 'none' ? confidenceOf(result, 'none') : read.reason === 'low-confidence' ? confidenceOf(result, selected) : undefined;
    return { reason: read.reason, ...(reported === undefined ? {} : { confidence: reported }), extra: trim };
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
      const ruled = ask((m) => m.toolGateRule(String(message || ''), project(offered), clock(now), boxesProjection(boxes)));
      if (ruled === undefined) return done({ decision: 'none', source: 'none' }, { reason: 'impl-fault' });
      if (!ruled || typeof ruled !== 'object' || (ruled.rule !== null && typeof ruled.rule !== 'string')) {
        portWarn('tool_gate.bad_decision', 'rule');
        return done({ decision: 'none', source: 'none' }, { reason: 'impl-fault' });
      }
      if (ruled.rule !== null) {
        if (!confined(ruled.decision, offered, 'rule')) return done({ decision: 'none', source: 'none' }, { reason: 'impl-fault' });
        return done({ decision: ruled.decision, source: 'rule' }, { rule: ruled.rule });
      }
      const read = await readout(message, offered, bias);
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

// The Stage 2 question, per decision model (#1639, decision-models.cjs `wording`). 'laya' is the one
// every release before #1639 sent, kept byte-identical for Laya and any unknown model (#1739).
// 'kev' was tuned for Kev-0.8B on a seeded tuning split of tools/decision-eval's synthetic cases (48.5%
// -> 69.1% there; held-out results on #1639): the Laya question's "must" made Kev answer "none" to
// nearly every message, and saying that the assistant on its own has no current news and none of the
// user's data moved web search from 2/16 to 13/16. With Laya it cost English tool-gate accuracy.
const QUESTION = 'Which tool, if any, must the assistant call before answering this user message?';
const KEV_QUESTION = 'Without tools the assistant knows no current news and nothing the user wrote or saved. Which tool does it need, if any?';
const questionFor = (wording) => (wording === 'kev' ? KEV_QUESTION : QUESTION);
// The Rust port (noevia-rs crates/tool-gate) shapes the options and counts the question as 79 characters plus any
// hint, the length of QUESTION, and tests/fixtures/tool-gate.v1.json must stay byte-identical with the port's copy.
// So with the longer Kev question the gate itself (budgetLimits) lowers the choice budget it gives the port by the
// extra characters, and question plus options stay within maxChoiceChars (Laya's option-head budget). Change this
// number only together with the port.
const BUDGET_QUESTION_CHARS = 79;

/** #1639: `limits` with the choice budget lowered by the characters `question` has beyond what the port
 *  counts, so question plus options fit maxChoiceChars and the port, given the same limits, shapes the
 *  same options. A question no longer than that (Laya's), no limits, or no finite choice budget: the
 *  limits object itself, unchanged. The cut does not depend on maxOptions (#1740). */
function budgetLimits(limits, question = KEV_QUESTION) {
  const excess = String(question).length - BUDGET_QUESTION_CHARS;
  if (!limits || excess <= 0 || !Number.isFinite(Number(limits.maxChoiceChars))) return limits;
  return { ...limits, maxChoiceChars: Number(limits.maxChoiceChars) - excess };
}

/** Lower bound of the selected option's readout interval if reported, else its share/confidence. */
function confidenceOf(result, id) {
  const lower = result?.metadata?.bounds?.[id]?.[0];
  if (Number.isFinite(lower)) return lower;
  if (Number.isFinite(result?.scores?.[id])) return result.scores[id];
  return Number.isFinite(result?.confidence) ? result.confidence : null;
}

const defaultLoader = () => require('./dav-parse-wasm.cjs');
const seenPort = new Map();
function portWarn(event, reason) {
  const key = `${event}:${reason}`;
  if (!seenPort.has(key) && seenPort.size >= 200) return; // bounded
  const n = (seenPort.get(key) || 0) + 1;
  seenPort.set(key, n);
  const outcome = event === 'tool_gate.prefetchable_fault' ? 'the message was not used as a search query' : 'no tool was forced';
  if (n === 1 || (n >= 10 && /^10*$/.test(String(n)))) console.warn(`[tool-gate] ${event} (${reason}); ${outcome}${n > 1 ? ` (${n} times so far)` : ''}`);
}

/** Whether the message is short, one line and plain enough to send to a search service as the query (the crate's reading:
 *  120 characters, no line break, no code fence, no quote). Asked of the crate; false when it cannot answer, which is the
 *  stricter answer for its caller (tools-mode.cjs wantsWeb adds Web search less, never more). */
function prefetchableSearch(message, wasmLoader = defaultLoader) {
  try { return wasmLoader().toolGateQueries([String(message || '')]).prefetchable[0] === true; } catch (err) {
    portWarn('tool_gate.prefetchable_fault', String(err?.reason || 'unexpected').slice(0, 40));
    return false;
  }
}

// What the crate reads of the request.
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
module.exports = { createToolGate, BUDGET_QUESTION_CHARS, budgetLimits, prefetchableSearch, DEFAULT_BOXES, DEFAULT_MIN_CONFIDENCE,
  toolProjection, offeredProjection, boxesProjection, limitsProjection, numberProjection, QUESTION, KEV_QUESTION, questionFor };
