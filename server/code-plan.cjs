'use strict';
// A Code plan is a display-only report from the harness, not a progress tracker.
// Keep both fresh journal events and legacy replay small before they reach the task view.
const MAX_CODE_PLAN_ENTRIES = 20;
const MAX_CODE_PLAN_ENTRY_BYTES = 200;

function clipUtf8(text, maxBytes) {
  let clipped = '', bytes = 0;
  for (const unit of text) {
    const char = /^[\uD800-\uDFFF]$/.test(unit) ? '\uFFFD' : unit;
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    clipped += char;
    bytes += size;
  }
  return clipped;
}

function boundCodePlan(data = {}) {
  const entries = Array.isArray(data.subQuestions) ? data.subQuestions : [];
  let truncated = data.truncated === true || entries.length > MAX_CODE_PLAN_ENTRIES;
  const subQuestions = entries.slice(0, MAX_CODE_PLAN_ENTRIES).map((entry) => {
    const original = String(entry ?? '');
    const text = clipUtf8(original, MAX_CODE_PLAN_ENTRY_BYTES);
    if (text !== original) truncated = true;
    return text;
  });
  return { subQuestions, truncated };
}

module.exports = { boundCodePlan, MAX_CODE_PLAN_ENTRIES, MAX_CODE_PLAN_ENTRY_BYTES };
