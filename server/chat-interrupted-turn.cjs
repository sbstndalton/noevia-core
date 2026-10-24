'use strict';
// #679: a reply whose browser went away (reload, closed tab, lost network) before it finished.
//
// Chat transcripts are saved by the client: the user message as the turn starts (App.tsx), the
// reply when it ends. A reload mid-reply kills the client before that second save, so without
// this the reply, and the record of any write that was approved and ran, were lost although the
// change had landed. The server follows the stream it sends (`createTurnRecord().observe`, the
// same fields the client keeps for a reply) and, when the client disconnects before the reply
// ended, appends that reply to the stored transcript as stopped: partial text kept, unfinished
// tool calls marked stopped (a pending approval card never ran and cannot be answered any more),
// and applied writes kept with a "N changes were saved" note, so Regenerate re-runs with the
// record and never replays the write.
//
// It only ever appends the reply directly after the user message this request carried, and only
// when that message is still the last stored entry: if the client (Stop pressed, tab still open)
// or another tab already saved past it, or the user message never reached storage, nothing is
// written. Always the requesting account's own workspace (pinned when the request began), never
// a deleted chat.

const STOPPED_SENDER = 'Stopped'; // src/chat-labels.ts STOPPED_SENDER (language-neutral token, #634)
const TOOL_RESULT_LIMIT = 4000; // src/components/ToolCalls.tsx TOOL_RESULT_LIMIT
const TOOL_NAME = /^[\w.-]{1,80}$/;
// The same shape the badge accepts (web RouteControls.tsx) and the cause codes routing-modes.cjs makes.
const DETAIL_CODE = /^[a-z][a-z0-9-]{0,39}$/;

const str = (v) => (typeof v === 'string' ? v : '');
const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Follows one reply's stream events and builds the transcript entry the client would have saved. */
function createTurnRecord({ now = Date.now } = {}) {
  const startedAt = now();
  let content = '', reasoning = '', narration = '', model, routingDecision, routeTarget, sources, stats, paused, failed = false;
  const tools = [];
  function observe(ev) {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'meta':
        if (ev.route) { model = `Assistant · Auto (${ev.route})`; routingDecision = ev.routingDecision; }
        // #778: where the reply went and why (codes only). #1421 follow-up: a check that could not
        // answer also carries its short cause, which the badge shows as "(cause)"; keep it here too,
        // or a saved interrupted turn loses the suffix that the live reply shows.
        if (ev.routing && ['local', 'cloud'].includes(ev.routing.route) && typeof ev.routing.reason === 'string') {
          const cause = ev.routing.reason === 'check-unavailable' && typeof ev.routing.detail === 'string' && DETAIL_CODE.test(ev.routing.detail) ? ev.routing.detail : null;
          routeTarget = { route: ev.routing.route, reason: ev.routing.reason, ...(cause ? { detail: cause } : {}) };
        }
        break;
      case 'sources':
        if (Array.isArray(ev.sources)) sources = ev.sources;
        break;
      case 'reasoning':
        reasoning += str(ev.text);
        break;
      case 'preamble': {
        // Narration before a tool call belongs with the thinking, not the answer (as in App.tsx).
        const text = str(ev.text);
        if (!text) break;
        const at = content.lastIndexOf(text);
        if (at >= 0) content = content.slice(0, at) + content.slice(at + text.length);
        reasoning += (reasoning ? '\n\n' : '') + text.trim();
        narration += (narration ? '\n\n' : '') + text.trim();
        break;
      }
      case 'delta':
        content += str(ev.text);
        break;
      case 'tool': {
        const at = Number.isInteger(ev.index) && ev.index >= 0 ? ev.index : tools.length;
        tools[at] = { name: str(ev.name) || 'tool', args: str(ev.args), status: 'running' };
        break;
      }
      case 'tool_pending': {
        const at = Number.isInteger(ev.index) && ev.index >= 0 ? ev.index : Math.max(0, tools.length - 1);
        tools[at] = { name: str(ev.name) || 'tool', args: str(ev.args), status: 'pending',
          ...(str(ev.target) ? { target: ev.target } : {}),
          ...(ev.targetKind === 'drive' || ev.targetKind === 'drive-new' ? { targetKind: ev.targetKind } : {}) };
        break;
      }
      case 'tool_result': {
        let at = Number.isInteger(ev.index) && ev.index >= 0 ? ev.index : tools.findIndex((t) => t && t.name === ev.name);
        if (at < 0) at = tools.length;
        const previous = tools[at];
        const target = str(ev.target) || previous?.target;
        tools[at] = {
          name: str(ev.name) || previous?.name || 'tool',
          args: previous ? previous.args : '',
          result: str(ev.text).slice(0, TOOL_RESULT_LIMIT),
          status: ev.declined === true ? 'denied' : ev.notRun === true ? 'stopped' : 'done',
          ...(target ? { target } : {}),
          ...(previous?.targetKind ? { targetKind: previous.targetKind } : {}),
          ...(ev.applied === true ? { applied: true } : {}),
        };
        break;
      }
      case 'paused': {
        const applied = Number.isInteger(ev.applied) && ev.applied >= 0 ? ev.applied : 0;
        paused = ev.reason === 'declined'
          ? { reason: 'declined', applied, declined: [...new Set((Array.isArray(ev.declined) ? ev.declined : []).filter((n) => typeof n === 'string' && TOOL_NAME.test(n)))].slice(0, 8) }
          : ev.reason === 'sensitive-tool-result' ? { reason: 'sensitive', applied } : { reason: 'supervision', applied };
        break;
      }
      case 'usage':
        stats = { promptTokens: count(ev.promptTokens), completionTokens: count(ev.completionTokens), totalTokens: count(ev.totalTokens),
          tokensPerSecond: count(ev.tokensPerSecond), elapsedMs: Math.max(0, now() - startedAt) };
        break;
      case 'error':
        failed = true;
        break;
      default:
    }
  }
  /** The reply as it stood when the client went away, or null when there is nothing to keep. */
  function assistantEntry() {
    // Nothing still runs or waits for approval once the request is gone (settleToolCalls in the client).
    const calls = tools.filter(Boolean).map((c) => (c.status === 'done' || c.status === 'denied' ? c : { ...c, status: 'stopped' }));
    const applied = calls.filter((c) => c.applied === true).length;
    if (failed) {
      // A failed reply is not kept, except as the record of the changes it saved (#658).
      if (!applied) return null;
      return { role: 'assistant', content: '', toolCalls: calls.filter((c) => c.status !== 'denied'),
        paused: paused?.reason === 'declined' ? paused : { reason: 'stopped', applied } };
    }
    // A reply cut off after tool steps and before any answer keeps what the model said before
    // them (its narration, shown with the thinking while streaming) as its text, so it is not lost.
    const text = content.trim() ? content.trimStart() : narration;
    const note = paused || (applied ? { reason: 'stopped', applied } : undefined);
    // No answer and no note: the language-neutral Stopped placeholder (#634), which keeps
    // Regenerate on the reply. Its unfinished thinking is not kept.
    const stopped = !text.trim() && !note;
    return {
      role: 'assistant',
      content: stopped ? '' : text,
      model: stopped ? STOPPED_SENDER : model,
      ...(routingDecision && !stopped ? { routingDecision } : {}),
      ...(routeTarget ? { routeTarget } : {}),
      ...(reasoning && !stopped ? { reasoning } : {}),
      ...(calls.length ? { toolCalls: calls } : {}),
      ...(stats ? { stats } : {}),
      ...(sources && sources.length && !stopped ? { sources } : {}),
      ...(note ? { paused: note } : {}),
    };
  }
  /**
   * #1507: the reply so far, marked interrupted, for the partial file and for a stored turn whose
   * client left. Unlike assistantEntry() it keeps the thinking when no answer was written yet, which is
   * the case that lost the reply in the report. A failed reply is not kept; nothing at all is null.
   */
  function partialEntry() {
    if (failed) return null;
    const base = assistantEntry();
    if (!base) return null;
    const stopped = base.model === STOPPED_SENDER && !base.content;
    const entry = stopped ? { role: 'assistant', content: '', model: base.model, ...(base.toolCalls ? { toolCalls: base.toolCalls } : {}) } : { ...base };
    if (stopped && reasoning.trim()) entry.reasoning = reasoning;
    if (!entry.content && !entry.reasoning && !(Array.isArray(entry.toolCalls) && entry.toolCalls.length) && !entry.paused) return null;
    return { ...entry, interrupted: true };
  }
  return { observe, assistantEntry, partialEntry };
}

/**
 * Append an interrupted reply after its user message in the requesting account's stored transcript.
 * Returns what happened: 'saved', or the reason nothing was written.
 *
 * sbstndalton/noevia#1071 slice 4: the Rust store makes the append (workspace.transcripts, the
 * account's own; noevia-rs crates/server-projects transcript append_if_last): the tombstone check,
 * the "is the user message still last" check, the cap, the sanitising and the write happen in one
 * hold of its lock. This process read, checked and wrote through a fixed `<file>.tmp` with nothing
 * held, so a client save landing meanwhile was lost, or two writers' temp files collided. There is
 * no local fallback: without the store the call fails, and nothing is written.
 * @param {object} o
 * @param {{ dir:string, transcripts:{ appendIfLast:(chat:string, message:string, entry:object)=>Promise<string> }, assertActive?:()=>void }} o.workspace  the request's own workspace
 * @param {string} o.chatId
 * @param {string} o.message  the user message this request answered
 * @param {object|null} o.entry  createTurnRecord().assistantEntry()
 * @returns {Promise<string>}
 */
async function saveInterruptedTurn({ workspace, chatId, message, entry }) {
  const lists = require('./chat-lists.cjs');
  const id = lists.safeChatId(chatId);
  if (!id || !workspace?.dir) return 'no-chat';
  if (!entry) return 'nothing-to-keep';
  // Checked again under the store's lock; this one only spares the call.
  if (lists.readTombstones(workspace.dir).has(id)) return 'deleted';
  if (typeof message !== 'string') return 'not-last';
  workspace.assertActive?.();
  if (typeof workspace.transcripts?.appendIfLast !== 'function') throw new Error('the transcript store is not available: the interrupted reply is not kept (Node never writes a transcript itself)');
  return workspace.transcripts.appendIfLast(id, message, entry, { origin: 'turn' });
}

module.exports = { createTurnRecord, saveInterruptedTurn, STOPPED_SENDER };
