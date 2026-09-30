'use strict';
// Durable, text-free record of System-One decisions (routing role/margin, supervision action),
// so real distributions survive container recreation — `docker logs` is wiped by every deploy.
// Callers pass only the fields they already log; nothing here adds message text. Bounded: one
// current file plus one rotated file, each at most `maxBytes`. Never throws into a chat turn.
const fs = require('node:fs'), path = require('node:path');

function createDecisionLog({ dir, name = 'system-one-decisions.jsonl', maxBytes = 1024 * 1024, now = () => new Date(), echo = console.info } = {}) {
  const file = path.join(dir, name);
  return function record(kind, entry) {
    try { echo?.(`[system-one] ${kind}`, JSON.stringify(entry)); } catch { /* console gone */ }
    try {
      const line = JSON.stringify({ at: now().toISOString(), kind, ...entry }) + '\n';
      let size = 0; try { size = fs.statSync(file).size; } catch { /* first write */ }
      if (size + line.length > maxBytes) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch { /* a full disk must not break a chat */ }
  };
}

/**
 * Summary for reading back: counts by selection and fallback, the text-free fallback causes
 * (#682), margin buckets, tool-gate reasons and resend outcomes.
 */
function summarize(lines) {
  const out = { route: { n: 0, selected: {}, fellBack: {}, cause: {}, margin: { '<0.05': 0, '0.05-0.2': 0, '>=0.2': 0 } },
    supervise: { n: 0, action: {}, fellBack: {}, cause: {} }, toolGate: { n: 0, source: {}, reason: {}, cause: {} },
    outcome: { n: 0, event: {}, previousRole: {} } };
  const bump = (bucket, key) => { if (key !== undefined && key !== null) bucket[key] = (bucket[key] || 0) + 1; };
  for (const raw of lines) {
    let e; try { e = JSON.parse(raw); } catch { continue; }
    if (e.kind === 'route') {
      const r = out.route; r.n++; bump(r.selected, e.selected); bump(r.fellBack, e.fellBack || null); bump(r.cause, e.cause || null);
      if (typeof e.margin === 'number') r.margin[e.margin < 0.05 ? '<0.05' : e.margin < 0.2 ? '0.05-0.2' : '>=0.2']++;
    } else if (e.kind === 'supervise') {
      const s = out.supervise; s.n++; bump(s.action, e.action); bump(s.fellBack, e.fellBack || null); bump(s.cause, e.cause || null);
    } else if (e.kind === 'tool-gate' && e.event === 'decision') {
      const g = out.toolGate; g.n++; bump(g.source, e.source); bump(g.reason, e.reason || null); bump(g.cause, e.cause || null);
    } else if (e.kind === 'outcome') {
      const o = out.outcome; o.n++; bump(o.event, e.event); bump(o.previousRole, e.previousRole || null);
    }
  }
  return out;
}

module.exports = { createDecisionLog, summarize };

if (require.main === module) {
  // node decision-log.cjs /app/server/ui-data  → a summary, no individual rows printed.
  const dir = process.argv[2] || path.join(__dirname, 'ui-data');
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  console.log(JSON.stringify(summarize([...read('system-one-decisions.jsonl.1'), ...read('system-one-decisions.jsonl')]), null, 1));
}
