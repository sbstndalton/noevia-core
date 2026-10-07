'use strict';
// Where a file's top-level declarations start and end.
//
// The problem this exists for is concrete: server/index.cjs is 264 KB
// and holds the routes, the tool loop, the budgets and the MCP plumbing. An
// agent that wants `toolTokenBudgetFor` does not need the other 260 KB, but
// without an outline the only safe move is to read the whole file — which is
// most of a context window spent before any work starts.
//
// Brace counting, not a parser. It is wrong on braces inside strings and
// regexes, so end lines are advisory and the CALLER is told they are: the
// outline points you at a range to read, it does not replace reading it.

const DECL = [
  // name-capturing patterns, tried in order, anchored at column 0
  /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\()/,
  /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /^def\s+([A-Za-z_][\w]*)/,
  /^class\s+([A-Za-z_][\w]*)/,
];

function declAt(line) {
  for (const re of DECL) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return null;
}

function outline(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const name = declAt(lines[i]);
    if (!name) continue;
    out.push({ name, line: i + 1, endLine: endOf(lines, i) });
  }
  return out;
}

function endOf(lines, start) {
  // Python: dedent to column 0. JS: balance braces from the first one seen.
  if (/^(?:def|class)\s/.test(lines[start])) {
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trim() && !/^\s/.test(lines[i])) return i;
    }
    return lines.length;
  }
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}') depth--;
    }
    if (opened && depth <= 0) return i + 1;
    // A one-line `const x = …;` never opens a brace; do not run to EOF for it.
    if (!opened && /;\s*$/.test(lines[i])) return i + 1;
  }
  return lines.length;
}

// The declaration a given line number falls inside, so a grep hit can be
// reported as "in toolTokenBudgetFor" rather than as a bare line number.
function enclosing(text, line) {
  let best = null;
  for (const d of outline(text)) {
    if (d.line <= line && line <= d.endLine && (!best || d.line > best.line)) best = d;
  }
  return best;
}

module.exports = { outline, enclosing, declAt };
