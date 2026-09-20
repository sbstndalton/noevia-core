'use strict';
// Compact what a tool RETURNS, before it goes back to the model.
//
// The budget in index.cjs (`toolTokenBudgetFor`) governs tool DEFINITIONS.
// Nothing governed tool RESULTS, and with the Nextcloud box live a single
// listing call is a JSON array of near-identical objects whose keys are
// repeated once per row. That text is appended to `roundMessages` and, like
// the catalogue, is re-prefilled on every subsequent round of the exchange —
// so it is paid in the same currency the budget is measured in: seconds of
// silence before the first token.
//
// The technique is the one Headroom uses for uniform JSON and it is worth
// about what the repeated keys cost: a header row once, values after. It is
// implemented here in plain JS rather than pulled in as a dependency — the
// server has three runtime deps by choice, and a reduction we cannot read at
// review time is not one we can trust with the model's only view of a result.
//
// The contract is the same one `resolveTools` keeps for dropped tools: nothing
// is ever removed silently. Every reduction states what it did, in a line the
// model can read, so it can ask for the rest rather than answer from a
// truncation it did not know about.

const DEFAULT_MAX_CHARS = 8000;
// Long enough for a path, a title, or a one-line summary — the fields a model
// actually reasons over. Past this a value is a document, and a document that
// arrived inside a listing is almost never what the turn is about.
const DEFAULT_MAX_VALUE_CHARS = 300;
// Two rows is where a header row starts paying for itself; one row costs more
// than it saves.
const MIN_ROWS = 2;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Empty in the sense that matters here: the field carries no information for
// the model. `false` and `0` are information and are kept.
function isEmptyValue(v) {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
}

function truncateValue(v, maxValueChars) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (typeof s !== 'string') return String(s);
  if (s.length <= maxValueChars) return s;
  return `${s.slice(0, maxValueChars)}…[+${s.length - maxValueChars} chars]`;
}

// Union of keys across rows, in first-seen order, minus the keys that are
// empty in EVERY row. A key empty in only some rows is kept: its absence in
// one row is then itself a fact.
function usefulKeys(rows) {
  const keys = [];
  const seen = new Set();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) { seen.add(k); keys.push(k); }
    }
  }
  return keys.filter((k) => rows.some((row) => !isEmptyValue(row[k])));
}

function tabular(rows, keys, maxValueChars) {
  const lines = [keys.join('\t')];
  for (const row of rows) {
    lines.push(keys.map((k) => {
      const v = row[k];
      if (v === undefined) return '';
      if (typeof v === 'string') return truncateValue(v, maxValueChars).replace(/[\t\r\n]+/g, ' ');
      return truncateValue(v, maxValueChars).replace(/[\t\r\n]+/g, ' ');
    }).join('\t'));
  }
  return lines.join('\n');
}

// Recursively drop empty fields and truncate long strings, then serialise
// without indentation. Used for JSON that is not a uniform array — there is no
// header row to hoist, but the padding is still worth removing.
function compactValue(v, maxValueChars) {
  if (typeof v === 'string') return truncateValue(v, maxValueChars);
  if (Array.isArray(v)) return v.map((x) => compactValue(x, maxValueChars));
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (isEmptyValue(val)) continue;
      out[k] = compactValue(val, maxValueChars);
    }
    return out;
  }
  return v;
}

/**
 * @returns {{ text: string, reduced: boolean, note: string }}
 *   `text` is what goes to the model, already carrying `note` when reduced.
 *   `note` is empty when the result was passed through untouched.
 */
function reduceToolResult(result, opts = {}) {
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  const maxValueChars = opts.maxValueChars || DEFAULT_MAX_VALUE_CHARS;
  const text = typeof result === 'string' ? result : String(result == null ? '' : result);

  // Under budget: the model gets exactly what the tool said. Most results are
  // here, and reducing them would cost fidelity to save nothing.
  if (text.length <= maxChars) return { text, reduced: false, note: '' };

  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }

  // Not JSON — prose, a stack trace, a CSV. There is no structure to exploit,
  // so the only honest move is a truncation that says so.
  if (parsed === undefined) {
    const note = `\n\n[truncated: showing the first ${maxChars} of ${text.length} characters. Ask for a narrower query if you need the rest.]`;
    return { text: text.slice(0, maxChars) + note, reduced: true, note: note.trim() };
  }

  const rows = Array.isArray(parsed) ? parsed : null;
  if (rows && rows.length >= MIN_ROWS && rows.every(isPlainObject)) {
    const keys = usefulKeys(rows);
    if (keys.length > 0) {
      const droppedKeys = new Set(rows.flatMap((r) => Object.keys(r)));
      for (const k of keys) droppedKeys.delete(k);
      const legend = `[${rows.length} records, tab-separated, first line is the column names${droppedKeys.size ? `; ${droppedKeys.size} column(s) omitted because they were empty in every record: ${[...droppedKeys].join(', ')}` : ''}]`;
      let body = tabular(rows, keys, maxValueChars);
      let kept = rows.length;
      // Still over after hoisting the keys: drop whole records from the end
      // rather than cutting a line in half, and say how many went.
      //
      // The budget has to account for the "showing N of M" note, because that
      // note only exists when records are dropped — i.e. in exactly this
      // branch. Measuring legend+body alone overshot the cap by the length of
      // the note every time it fired: a real 400-record Nextcloud-shaped
      // listing reduced to 8,037 characters against a 8,000 cap.
      const noteFor = (n) => `[showing ${n} of ${rows.length} records; ${rows.length - n} omitted to fit. Narrow the query if you need them.]`;
      const fits = (n, text) => legend.length + 1 + noteFor(n).length + 1 + text.length <= maxChars;
      if (legend.length + 1 + body.length > maxChars) {
        while (kept > 1) {
          kept -= 1;
          body = tabular(rows.slice(0, kept), keys, maxValueChars);
          if (fits(kept, body)) break;
        }
      }
      const omitted = rows.length - kept;
      const note = omitted ? noteFor(kept) : legend;
      const head = omitted ? `${legend}\n${note}` : legend;
      return { text: `${head}\n${body}`, reduced: true, note };
    }
  }

  // Structured, but not a uniform array: strip the padding and re-serialise.
  const compacted = JSON.stringify(compactValue(parsed, maxValueChars));
  if (compacted.length <= maxChars) {
    const note = `[compacted: empty fields removed and long values shortened; ${text.length} → ${compacted.length} characters.]`;
    return { text: `${note}\n${compacted}`, reduced: true, note };
  }
  const note = `\n\n[truncated: showing the first ${maxChars} of ${compacted.length} characters after compaction. Ask for a narrower query if you need the rest.]`;
  return { text: compacted.slice(0, maxChars) + note, reduced: true, note: note.trim() };
}

/**
 * The header-row form on its own, for callers that build the rows themselves
 * and want one predictable output shape rather than "JSON, unless it got big".
 * @returns {{ text: string, note: string, kept: number }}
 */
function tabulate(rows, opts = {}) {
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  const maxValueChars = opts.maxValueChars || DEFAULT_MAX_VALUE_CHARS;
  const list = Array.isArray(rows) ? rows.filter(isPlainObject) : [];
  if (!list.length) return { text: '(no records)', note: '', kept: 0 };
  const keys = usefulKeys(list);
  if (!keys.length) return { text: '(no records)', note: '', kept: 0 };
  let kept = list.length;
  let body = tabular(list, keys, maxValueChars);
  while (kept > 1 && body.length > maxChars) {
    kept -= 1;
    body = tabular(list.slice(0, kept), keys, maxValueChars);
  }
  const omitted = list.length - kept;
  const note = omitted ? `[showing ${kept} of ${list.length}; ${omitted} omitted to fit]` : '';
  return { text: body, note, kept };
}

module.exports = { reduceToolResult, tabulate, DEFAULT_MAX_CHARS, DEFAULT_MAX_VALUE_CHARS };
