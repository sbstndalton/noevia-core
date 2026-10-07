'use strict';

// Shared by tests/server/mcp-frame-differential.test.cjs and tools/gen-mcp-fixtures.cjs (#980); lives
// here because the runtime image carries tests/ but not tools/.

/** The module's tree encoding of a resolveSchemaRefs result (see crates/mcp-frame schema.rs).
 *  Iterative: values may nest far deeper than the JS stack. */
function encodeTree(root) {
  const out = [];
  const scalar = (v) => (typeof v === 'number'
    ? (Object.is(v, -0) ? '-0' : Number.isFinite(v) ? JSON.stringify(v) : v > 0 ? '1e400' : '-1e400')
    : JSON.stringify(v));
  // Work items: a value to write, or a literal string.
  const stack = [{ v: root }];
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === 'string') { out.push(item); continue; }
    const v = item.v;
    if (v === null || typeof v !== 'object') { out.push(scalar(v)); continue; }
    const parts = [];
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) { if (i) parts.push(','); parts.push({ v: v[i] }); }
      stack.push(']', ...parts.reverse(), '[');
      continue;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype) parts.push('"^":', { v: proto });
    for (const k of Object.keys(v)) { if (parts.length) parts.push(','); parts.push(`${JSON.stringify(`=${k}`)}:`, { v: v[k] }); }
    stack.push('}', ...parts.reverse(), '{');
  }
  return out.join('');
}

module.exports = { encodeTree };
