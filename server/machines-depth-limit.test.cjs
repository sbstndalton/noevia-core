'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ARRAY_NESTING_LIMIT, MEASURED_LINUX_X64, measure, runProbe } = require('./machines-depth-limit.cjs');

// The reference route saves a name nested in arrays until V8 runs out of stack, and answers
// 500 (nothing saved) beyond that. The native route's cutoff must not refuse anything this
// saves; it is the most permissive context's limit.
test('the reference route saves array-nested names up to a stack-dependent depth', { timeout: 120000 }, () => {
  // Below the boundary every context on every platform saves (arm64's http context is the lowest, 2520).
  for (const ctx of ['route', 'http', 'bare']) {
    for (const depth of [1, 2500]) assert.equal(runProbe(ctx, depth).ok, true, `${ctx} ${depth}`);
  }
  // The 2,601 and 2,610 levels a review saved through the route: saved by the route and bare
  // contexts everywhere, and by the http context on the web image's platform (linux x64).
  const onX64 = process.platform === 'linux' && process.arch === 'x64';
  for (const ctx of onX64 ? ['route', 'http', 'bare'] : ['route', 'bare']) {
    for (const depth of [2601, 2610]) assert.equal(runProbe(ctx, depth).ok, true, `${ctx} ${depth}`);
  }
  // Far above it every context refuses: the route's catch answers 500 and saves nothing.
  const over = runProbe('route', 5000);
  assert.deepEqual([over.ok, over.status, over.error, over.writes], [false, 500, 'The inference machines could not be changed.', 0]);
  assert.equal(runProbe('http', 5000).status, 500);
  assert.equal(runProbe('bare', 5000).ok, false);
  const measured = measure();
  const window = Object.values(measured);
  assert.ok(Math.min(...window) >= 2500 && Math.max(...window) < 5000, JSON.stringify(measured));
  if (onX64) {
    // The platform of the web image: pin the measured boundary at, one below and one above.
    assert.deepEqual(measured, MEASURED_LINUX_X64, 'V8 stack budget changed: re-measure and update the native cutoff');
    assert.equal(Math.max(...window), ARRAY_NESTING_LIMIT);
    for (const [ctx, max] of Object.entries(measured)) {
      assert.equal(runProbe(ctx, max - 1).ok, true, `${ctx} ${max - 1}`);
      assert.equal(runProbe(ctx, max).ok, true, `${ctx} ${max}`);
      assert.equal(runProbe(ctx, max + 1).ok, false, `${ctx} ${max + 1}`);
    }
    assert.equal(runProbe('bare', ARRAY_NESTING_LIMIT + 1).ok, false);
  }
});
