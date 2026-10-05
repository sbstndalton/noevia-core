'use strict';
// Fixed inputs the full auto-tuner (llamacpp-full-autotune.cjs) measures with: the three short
// deterministic workloads, the speculative-decoding profiles it tries, and the geometric mean it
// scores generation speed by.

const WORKLOADS = [
  { id: 'list', max: 160, prompt: 'List the whole numbers from 1 to 60, separated by commas, and nothing else.' },
  { id: 'prose', max: 160, prompt: 'Write one paragraph explaining why community gardens matter to a neighbourhood.' },
  { id: 'code', max: 200, prompt: 'Write a JavaScript function median(values) that returns the median of an array without modifying it. Code only.' },
];
const SPEC_CANDIDATES = [
  { id: 'off', label: 'Off', options: { 'spec-type': 'none', 'spec-draft-n-max': '', 'spec-draft-p-min': '' } },
  { id: 'mtp', label: 'MTP (engine defaults)', needsHead: true, options: { 'spec-type': 'draft-mtp', 'spec-draft-n-max': '', 'spec-draft-p-min': '' } },
  { id: 'mtp-deep', label: 'MTP deep drafts', needsHead: true, options: { 'spec-type': 'draft-mtp', 'spec-draft-n-max': '8', 'spec-draft-p-min': '0.05' } },
  { id: 'mtp-shallow', label: 'MTP shallow drafts', needsHead: true, options: { 'spec-type': 'draft-mtp', 'spec-draft-n-max': '2', 'spec-draft-p-min': '0.6' } },
  { id: 'ngram', label: 'N-gram', options: { 'spec-type': 'ngram-simple', 'spec-draft-n-max': '', 'spec-draft-p-min': '' } },
];

function geomean(values) {
  const v = values.filter((x) => x > 0);
  return v.length ? Math.exp(v.reduce((a, x) => a + Math.log(x), 0) / v.length) : 0;
}

module.exports = { WORKLOADS, SPEC_CANDIDATES, geomean };
