'use strict';
// #1693: a reply whose tools ran but that wrote no answer. The last tool round (round 2) ends the loop with its
// results never shown to the model, and a round after tool results can end on reasoning only. Before this the
// reply ended with "The model returned reasoning without a final answer" and everything gathered was dropped.
// Now one bounded extra round, with no tools, asks for the final answer; if that also writes none, the reply
// keeps the links the tools returned and points at the reasoning. Pure helpers; chat.cjs owns the loop.

const LAST_TOOL_ROUND = 2;
const FINAL_ANSWER_NOTE = 'Write your final answer to the user now, using the tool results above. Cite the source links they contain. Do not call any more tools. If a tool failed, say so in one line and answer from the results that did come back.';
const MAX_SOURCES = 5;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;

/** Whether the reply needs the no-tools final-answer round: the last tool round called tools (their results were
 *  never read), or a round after tool results wrote no answer text. Round 0 with no tools is not a tool reply. */
function needsFinalPass({ round, toolCalls, hasContent }) {
  if (toolCalls > 0) return round >= LAST_TOOL_ROUND;
  return round > 0 && !hasContent;
}

/** The distinct http(s) links in one tool result, in order, at most MAX_SOURCES. Trailing punctuation is dropped. */
function sourceLinks(text) {
  const out = [];
  for (const m of String(text || '').matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (url.length > 400 || out.includes(url)) continue;
    out.push(url);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/** The reply text when the final-answer round wrote nothing: the links the tools returned. The reasoning itself is
 *  not copied into the answer (it stays in the thinking panel, where the person can read it; promoting it would turn
 *  internal narration into a stated answer), only pointed at. */
function fallbackText({ sources }) {
  const links = (Array.isArray(sources) ? sources : []).slice(0, MAX_SOURCES);
  return links.length
    ? `\n\nThe model did not write a final answer. Its reasoning is in the thinking above; these are the sources the tools returned:\n${links.map((u) => `- ${u}`).join('\n')}`
    : '\n\nThe model did not write a final answer from the tool results. Its reasoning is in the thinking above. Try again or choose another model.';
}

module.exports = { needsFinalPass, sourceLinks, fallbackText, FINAL_ANSWER_NOTE, LAST_TOOL_ROUND, MAX_SOURCES };
