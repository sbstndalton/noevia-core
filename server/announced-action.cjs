'use strict';
// #1552: a small model with tools on offer sometimes ends its reply with a plan ("I will read the full
// file and total the months.") and no tool call, so the turn shows a promise and no answer. When the
// end of a reply announces a tool action and no tool was called, the chat loop gives the model one
// more try with ANNOUNCED_NOTE; its first text is kept as narration (the same path as gate.retry).
//
// Only the tail of the reply is checked, and only first-person future phrasing of a tool-shaped verb,
// so an answer that merely mentions reading ("I read the CSV; the total is 4") is left alone.

const TAIL_CHARS = 280;
const VERBS = 'read|open|check|look(?:\\s+(?:at|up|into|through))?|search|list|fetch|load|scan|inspect|examine|retrieve|browse|query|calculate|count|compute|go\\s+through|use\\s+the';
const ANNOUNCE = new RegExp(
  `(?:^|[\\s.!?:;(])(?:I\\s*(?:will|'ll|’ll|am\\s+going\\s+to|'m\\s+going\\s+to|’m\\s+going\\s+to|need\\s+to|have\\s+to|should)|let\\s+me|let's|(?:first|then|next),?\\s+I(?:\\s*'ll|\\s*’ll|\\s+will)?)\\s+(?:now\\s+|first\\s+|quickly\\s+|carefully\\s+|go\\s+(?:and\\s+)?)?(?:${VERBS})\\b`,
  'i');

const ANNOUNCED_NOTE = 'You said you would use a tool, but no tool was called, so nothing was read or run. '
  + 'Call the tool now. If no tool fits, give the final answer from what you already have, and say plainly what you could not check. '
  + 'Do not describe files, excerpts or results you have not seen.';

/** True when the last part of `text` announces a tool action that was not taken. */
function announcesToolAction(text) {
  const tail = String(text || '').trim().slice(-TAIL_CHARS);
  if (!tail) return false;
  // The announcement must be the last sentence: a promise followed by an answer is an answer.
  const sentences = tail.split(/(?<=[.!?:])\s+/).filter(Boolean);
  return ANNOUNCE.test(sentences.at(-1) || '');
}

module.exports = { ANNOUNCED_NOTE, announcesToolAction, TAIL_CHARS };
