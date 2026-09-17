'use strict';
// Plain-language hints on borrowed tool descriptions.
//
// noevia does not write the tools it forwards — an MCP server does, in its own vocabulary, for
// its own reasons. Nextcloud's to-do tools are the clearest case: every one of them is named
// `nc_calendar_*` and described in calendar words, so a small model asked to "add a task" is
// looking at six calendar tools and does not connect them. The words are the server's; the
// words the MODEL sees are noevia's responsibility.
//
// So a manifest row may add a sentence per tool. It is appended, never a replacement: the
// server's own description stays intact and first, because it is the accurate one, and the hint
// says what the tool is FOR in the user's vocabulary. Hints are bounded and idempotent, so
// re-discovery cannot grow a description turn after turn.
//
// This is a hypothesis about why the 4B skips the Tasks box, not a measured fix. It costs a few
// tokens (which `estimateToolTokens` already charges to the budget) and it cannot change what a
// tool does. Confirming it needs a model run in a maintenance window.

const MAX_HINT = 200;

/**
 * @param {object} tool an OpenAI-shaped tool definition
 * @param {string} hint one short sentence in the user's vocabulary
 * @returns {object} the same tool when there is nothing to add, otherwise a copy
 */
function withHint(tool, hint) {
  const text = typeof hint === 'string' ? hint.trim().slice(0, MAX_HINT) : '';
  if (!text || !tool || !tool.function) return tool;
  const original = typeof tool.function.description === 'string' ? tool.function.description.trim() : '';
  // Idempotent: discovery runs again on a TTL, and a description that grew a copy of its hint
  // every time would quietly eat the tool budget.
  if (original.includes(text)) return tool;
  const description = original ? `${original} ${text}` : text;
  return { ...tool, function: { ...tool.function, description } };
}

/** Apply a box's `hints` map to one bound tool. Unknown names are simply not hinted. */
function hintTool(box, tool) {
  const name = tool && tool.function && tool.function.name;
  const hint = name && box && box.hints ? box.hints[name] : null;
  return hint ? withHint(tool, hint) : tool;
}

module.exports = { withHint, hintTool, MAX_HINT };
