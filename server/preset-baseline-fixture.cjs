'use strict';
// Tests only: a stand-in for the front's preset reload baseline (noevia-rs model_maint/reload.rs
// BaselineAuthority, served on the internal store listener as /v1/preset-baseline/*), in the shapes
// of its bridge contract. It keeps the baseline in memory, reads unknown while a reload ticket is
// open, refuses a settle for an unknown ticket with 409 stale_ticket (and forgets), and downgrades a
// record to forget when its ticket overlapped another or anything was asked after it began.
// `log` gets one line per call, so a test can see its order against the router's calls.
const { engineView } = require('./preset-reload.cjs');

function createFakePresetBaseline({ check, session = 200, begin = 200, staleSettle = false, unreachable = [], log = [] } = {}) {
  let baseline = null, gen = 0, n = 0, epoch = 'fake-epoch-1', starts = 1;
  const open = new Map();
  const boots = [];
  const answer = (status, body) => ({ status, body });
  const current = () => (open.size ? null : baseline);
  async function presetBaseline(op, body = {}, { timeoutMs } = {}) {
    log.push(`bridge ${op}${typeof body.origin === 'string' ? `:${body.origin}` : ''}`);
    if (!(timeoutMs > 0 && timeoutMs <= 5000)) throw new Error(`the bridge call had no bounded timeout: ${timeoutMs}`);
    if (unreachable.includes(op)) throw Object.assign(new Error('The project store is busy. Try again shortly.'), { status: 503 });
    switch (op) {
      case 'session':
        if (session !== 200) return answer(session, { error: 'Not found' });
        boots.push(body.nodeBoot);
        return answer(200, { epoch, protocol: 1 });
      case 'begin': {
        if (begin !== 200) return answer(begin, { error: 'preset reload baseline unavailable' });
        const g = ++gen, ticket = `${epoch}-${++n}`;
        const overlapped = open.size > 0;
        for (const t of open.values()) t.overlapped = true;
        open.set(ticket, { gen: g, overlapped });
        return answer(200, { ticket, gen: g, epoch, deadlineMs: 180000 });
      }
      case 'settle': {
        const t = open.get(body.ticket);
        open.delete(body.ticket);
        if (!t || staleSettle) { gen += 1; baseline = null; return answer(409, { error: 'The reload ticket is unknown or expired.', code: 'stale_ticket', gen, saved: true }); }
        const view = engineView(body.rows);
        const keep = body.outcome === 'record' && !t.overlapped && t.gen === gen && typeof body.before === 'string' && body.before === body.after && view !== null;
        gen += 1;
        baseline = keep ? { text: body.before, view } : null;
        return answer(200, { gen, saved: true });
      }
      case 'invalidate':
        gen += 1; baseline = null;
        return answer(200, { gen, saved: true });
      case 'router-text': {
        const b = current(), view = engineView(body.rows);
        return answer(200, { text: b && view !== null && view === b.view ? b.text : null });
      }
      case 'verdict': {
        const b = current();
        if (!b) return answer(200, { safe: false, reason: 'unknown' });
        const view = engineView(body.rows);
        if (view === null) return answer(200, { safe: false, reason: 'unknown' });
        if (view !== b.view) return answer(200, { safe: false, reason: 'engine_moved' });
        if (typeof body.current !== 'string') return answer(200, { safe: false, reason: 'unreadable' });
        const r = check({ baseline: b.text, current: body.current, loaded: body.loaded });
        return answer(200, r.safe ? { safe: true, reason: 'unchanged' } : { safe: false, reason: r.reason || 'changed', changed: r.changed || [] });
      }
      default:
        return answer(404, { error: 'Not found' });
    }
  }
  /** A front restarted on its own: a new epoch, nothing open, no session, the baseline unknown. */
  const restart = () => { starts += 1; epoch = `fake-epoch-${starts}`; open.clear(); baseline = null; gen = 0; boots.length = 0; };
  return { presetBaseline, log, restart, state: () => ({ baseline, open: open.size, gen, epoch, boots: [...boots] }) };
}

module.exports = { createFakePresetBaseline };
