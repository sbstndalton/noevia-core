'use strict';
// Stable ids for the English limitation sentences recorded next to evidence (#598). The store keeps
// the sentence (it is what older records already hold), so the id is derived on the way out: a
// client translates the id and falls back to the sentence for anything not listed here (a probe's
// own failure text, for instance). Order matters only where two patterns could both match.

const PATTERNS = [
  { id: 'autotune-quality', re: /^Three deterministic quality smoke probes, not a general quality benchmark$/ },
  { id: 'autotune-budget', re: /^120 s default prompt budget; existing MTP head only$/ },
  { id: 'vision-probe', re: /^1×1 image accepted; not an accuracy test$/ },
  { id: 'single-reply', re: /^single reply; depends on content$/ },
  { id: 'calibration-budget', re: /^prompt budget (\d+(?:\.\d+)?) s$/, params: (m) => ({ seconds: Number(m[1]) }) },
  { id: 'benchmark-median', re: /^median of (\d+) warm, uncontended requests; depends on prompt mix and max tokens$/, params: (m) => ({ n: Number(m[1]) }) },
  { id: 'source-unverified', re: /^unverified, from source: published by the model repository, not measured locally$/ },
];

/** One `{ id, params }` (or null when the sentence has no id) per limitation, in the same order. */
function limitationKeys(limitations) {
  return (Array.isArray(limitations) ? limitations : []).map((text) => {
    if (typeof text !== 'string') return null;
    for (const p of PATTERNS) {
      const m = p.re.exec(text);
      if (m) return { id: p.id, params: p.params ? p.params(m) : {} };
    }
    return null;
  });
}

module.exports = { limitationKeys, LIMITATION_IDS: PATTERNS.map((p) => p.id) };
