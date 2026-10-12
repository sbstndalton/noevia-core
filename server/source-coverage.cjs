'use strict';
// #1513: a large text source is never read whole into one reply. The reply sees the excerpts that
// matched the question, or the start of each file when there is no index, and a file that is not
// placed at all is only named. An answer that says some text is absent from such a file is confidently
// wrong. This names, per source, how much of it this reply read, so the model and the user are told
// which part was included and that the rest was not read. Pure: no I/O, no model call.

// rag.cjs places a file at or under this length whole (DIRECT_INJECT_MAX); anything longer is partial
// unless the placed text covers all of it.
const WHOLE_MAX = 2400;

const number = (n) => Number(n).toLocaleString('en-GB');

/**
 * Sources of which this reply read only part.
 * @param {object[]} files   the readable project sources ({ name, content })
 * @param {object[]} placed  what filesContext put in the prompt ({ file, body }), as onSources reports it
 * @returns {{ name: string, length: number, read: number }[]}
 */
function partialSources(files, placed) {
  if (!Array.isArray(files) || !Array.isArray(placed)) return [];
  const out = [];
  for (const f of files) {
    const length = String((f && f.content) || '').length;
    if (length <= WHOLE_MAX) continue;
    let read = 0;
    for (const p of placed) if (p && p.file === f.name) read += String(p.body || '').length;
    if (read >= length) continue;
    out.push({ name: String(f.name), length, read: Math.min(read, length) });
  }
  return out;
}

/** The system-text note for the model. Empty when every source was read in full. */
function coverageNote(partial) {
  if (!Array.isArray(partial) || !partial.length) return '';
  // A synced file's name is not ours to trust: quoted and escaped, so a quote or a newline in it cannot start
  // a line of its own in the system text (#1588).
  const parts = partial.map((p) => `${JSON.stringify(String(p.name))} is ${number(p.length)} characters long and this reply read ${p.read ? `only ${number(p.read)} characters of it (excerpts or the start)` : 'none of it (it was not included)'}`);
  return `Source text was truncated for this reply: ${parts.join('; ')}. The rest of each file was NOT read. Do not say that some text is absent from a file, or answer "no", from the part you read; say which part you read. read_project_file with an offset can read more of a file.`;
}

/** The warning the user sees with the reply, in the same terms as the note. Empty when nothing was cut. */
function coverageWarning(partial) {
  if (!Array.isArray(partial) || !partial.length) return '';
  return partial.map((p) => `Only part of "${p.name}" was read for this reply (${number(p.read)} of ${number(p.length)} characters); answers about the rest may be wrong.`).join(' ');
}

module.exports = { partialSources, coverageNote, coverageWarning, WHOLE_MAX };
