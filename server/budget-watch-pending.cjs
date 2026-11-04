'use strict';
// The native worker fsyncs per-model fences before unloading; only Rust writes/removes them.
// Legacy releases ignore this directory. Root accepts rollback as the same quarantine loss as
// a Node restart (the legacy quarantine is in memory); leftover files must not gate rollback.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
function pendingRefusal(dir, model, revision, budgetGib) {
  if (!dir) return null;
  const hash = createHash('sha256').update(model).digest('hex');
  const validRevision = r => r === null || (typeof r === 'string' && /^[a-f0-9]{64}$/.test(r));
  const stale = q => (q.revisionKnown !== false && Object.hasOwn(q, 'revision') && q.revision !== revision) || (typeof q.budgetGib === 'number' && q.budgetGib !== budgetGib);
  let context = null;
  try {
    context = JSON.parse(fs.readFileSync(path.join(dir, hash + '.context'), 'utf8'));
    if (!context || typeof context.revisionKnown !== 'boolean' || !validRevision(context.revision) || (context.budgetGib !== null && !Number.isFinite(context.budgetGib))) context = null;
  } catch { context = null; }
  try {
    const q = JSON.parse(fs.readFileSync(path.join(dir, hash + '.json'), 'utf8'));
    if (q.model !== model || !validRevision(q.revision) || !Number.isFinite(q.budgetGib) || !(q.budgetGib > 0)) throw Error('invalid fence');
    if (stale(q)) return null;
    return { body: { error: 'This model stays unloaded until its settings or inference budget change.', code: 'inference_budget_unloaded', budgetGib, unloadedAt: new Date(q.at).toISOString() } };
  } catch (e) {
    // A renamed damaged payload (or the context-only pre-write after a crash) still fences its
    // own hash. Healthy and damaged stale contexts both release admission immediately.
    if (context && stale(context)) return null;
    if (e.code === 'ENOENT') {
      try { if (!fs.readdirSync(dir).some(n => n === hash + '.context' || n.startsWith(hash + '.json.damaged-'))) return null; }
      catch (error) { if (error.code === 'ENOENT') return null; }
    }
    return { body: { error: 'The memory safety net admission state is unavailable.', code: 'inference_budget_pending' } };
  }
}
module.exports = { pendingRefusal };
