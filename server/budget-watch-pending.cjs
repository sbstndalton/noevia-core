'use strict';
// The native worker fsyncs this per-model fence BEFORE sending an emergency unload.
// Read on every admission, including after either process restarts. Only Rust writes/removes it.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
function pendingRefusal(dir, model, revision, budgetGib) {
  if (!dir) return null;
  try {
    const file = path.join(dir, createHash('sha256').update(model).digest('hex') + '.json');
    const q = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (q.model !== model || !Object.hasOwn(q, 'revision') || typeof q.budgetGib !== 'number' || !(q.budgetGib > 0)) throw Error('invalid fence');
    if (q.revision !== revision || q.budgetGib !== budgetGib) return null;
    return { body: { error: 'This model stays unloaded until its settings or inference budget change.', code: 'inference_budget_unloaded', budgetGib, unloadedAt: new Date(q.at).toISOString() } };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return { body: { error: 'The memory safety net admission state is unavailable.', code: 'inference_budget_pending' } };
  }
}
module.exports = { pendingRefusal };
