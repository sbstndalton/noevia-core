'use strict';
// Stored alternatives of a chat turn (#1517). Regenerate keeps the answers a user turn has had
// (`answers`, with `answer` the one shown) and Edit & re-run keeps the versions of the turn
// (`branches`, with `branch` the one shown; each version holds its own `answers` and the `tail` of
// history entries that followed it). The browser saves them as opaque fields of the history entries.
// Owner decision 2026-10-13: keep the last MAX_VARIANTS per turn, older ones drop off, and the one
// shown (the chosen one) is never dropped, even when it is the oldest.

const MAX_VARIANTS = 10;
// A saved version holds the chat that followed it, which can hold turns with variants of their own.
// Past this depth the nested variants are dropped rather than followed without bound.
const MAX_DEPTH = 16;

/**
 * Keeps at most `max` variants of `list`, dropping the oldest (lowest index) first and never the
 * chosen one. The chosen index may sit past the end of the list: Regenerate and Edit & re-run reserve
 * the slot for the reply that is still being made, and that slot counts toward the limit too.
 * @param {unknown[]} list  variants, oldest first
 * @param {unknown} chosen  index of the variant shown (defaults to 0, as the browser does)
 * @param {number} [max]
 * @returns {{ list: unknown[], chosen: number }}
 */
function capVariants(list, chosen, max = MAX_VARIANTS) {
  const shown = Number.isInteger(chosen) && chosen >= 0 ? chosen : 0;
  let drop = Math.max(list.length, shown + 1) - max;
  if (drop <= 0) return { list, chosen: shown };
  const keep = [];
  let before = 0;
  list.forEach((item, i) => {
    if (drop > 0 && i !== shown) { drop -= 1; if (i < shown) before += 1; return; }
    keep.push(item);
  });
  return { list: keep, chosen: shown - before };
}

function capAnswers(owner) {
  if (!Array.isArray(owner.answers)) return owner;
  const { list, chosen } = capVariants(owner.answers, owner.answer);
  return list === owner.answers ? owner : { ...owner, answers: list, answer: chosen };
}

/** One history entry with its stored alternatives bounded; the same object when nothing changes. */
function capEntry(entry, depth = 0) {
  if (!entry || typeof entry !== 'object' || (!('answers' in entry) && !('branches' in entry))) return entry;
  if (depth > MAX_DEPTH) { const { answers, answer, branches, branch, ...rest } = entry; return rest; }
  let next = capAnswers(entry);
  if (Array.isArray(next.branches)) {
    const versions = next.branches.map((version) => {
      if (!version || typeof version !== 'object') return version;
      const withAnswers = capAnswers(version);
      const tail = Array.isArray(withAnswers.tail) ? withAnswers.tail.map((h) => capEntry(h, depth + 1)) : withAnswers.tail;
      const tailChanged = Array.isArray(tail) && tail.some((h, i) => h !== withAnswers.tail[i]);
      return withAnswers === version && !tailChanged ? version : { ...withAnswers, tail };
    });
    const { list, chosen } = capVariants(versions, next.branch);
    const changed = list !== versions || versions.some((v, i) => v !== next.branches[i]);
    if (changed) next = { ...next, branches: list, branch: chosen };
  }
  return next;
}

module.exports = { MAX_VARIANTS, capVariants, capEntry };
