'use strict';
// sbstndalton/noevia#2190 round 6: the provider keys are re-sealed by the Rust front. The front is
// the only writer of users/<id>/providers.json and shared-providers.json (provider_routes.rs,
// capability rust-providers), so a secrets rotation (secrets-rotate.cjs) does not rewrite them from
// here: it asks the front's internal store, `POST /v1/providers/reseal`, for one pass over each file
// under that file's own lock with the current and the previous key, and gets the counts back. The
// front pairs this client by the capability `rust-providers-reseal` (noevia-rs lib.rs FEATURES);
// require() of this module in index.cjs is the Core marker the web supervisor and the release
// assembly pair it with, so a Core that rotates through the store never runs beside a front without
// the op, and a front that has it never runs beside a Core that still rewrites the files itself.

const COUNTS = ['current', 'rotated', 'upgraded', 'empty', 'failed'];
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * The front's pass over the provider files, as `{ tables, failures }` in secrets.cjs rotate()'s
 * report shape (`shared_providers`, `user_providers:<id>`). Throws when the front cannot do it
 * (store unreachable, credential keys unavailable) or answers something else.
 * @param {{ providersReseal: (scope: string) => Promise<object> }} client  project-store-client.cjs
 */
async function resealProviderKeys(client, scope = 'all') {
  if (!client || typeof client.providersReseal !== 'function') throw new Error('the Rust front\'s provider key re-seal is not available');
  const body = await client.providersReseal(scope);
  if (!body || body.ok !== true || !body.tables || typeof body.tables !== 'object' || !Array.isArray(body.failures)) throw new Error('the Rust front answered the provider key re-seal with something unexpected');
  const tables = {};
  for (const [name, counts] of Object.entries(body.tables)) {
    if (typeof name !== 'string' || !counts || typeof counts !== 'object' || !COUNTS.every((k) => isCount(counts[k]))) throw new Error('the Rust front answered the provider key re-seal with something unexpected');
    tables[name] = Object.fromEntries(COUNTS.map((k) => [k, counts[k]]));
  }
  // A failure names the table and the row's position, and says why in the front's words; never a key.
  const failures = body.failures.slice(0, 1000).map((f) => ({ table: String(f && f.table), ref: f && Number.isSafeInteger(f.ref) ? f.ref : null, error: String(f && f.error || '').slice(0, 200) }));
  return { tables, failures };
}

module.exports = { resealProviderKeys };
