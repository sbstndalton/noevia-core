'use strict';
// Throughput evidence from finished model-manager benchmark runs. Only a variant that ran
// the model's saved preset (no argument overrides) and finished recently counts: an older
// run or a sweep variant measured a different configuration than the live identity.
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round = (n) => Math.round(n * 10) / 10;

function throughputRecords(detail, { now = Date.now(), maxAgeMs = 30 * 60000 } = {}) {
  const run = detail?.run;
  if (!run || run.status !== 'done' || !Number.isFinite(Number(run.finished_at))) return [];
  if (now - Number(run.finished_at) * 1000 > maxAgeMs) return [];
  const out = [];
  for (const v of detail.variants || []) {
    let argv = {};
    try { argv = JSON.parse(v.argv_json || '{}'); } catch { continue; }
    if (argv && Object.keys(argv).length) continue;
    const ok = (detail.results || []).filter((r) => r.alias === v.alias && !r.err && !r.cold && !r.contended && !r.truncated && Number(r.gen_tps) > 0);
    if (ok.length < 2) continue;
    const prompt = ok.map((r) => Number(r.prompt_tps)).filter((n) => n > 0);
    out.push({ model: v.alias, record: {
      category: 'throughput', result: 'reported',
      value: { rate: round(median(ok.map((r) => Number(r.gen_tps)))), promptRate: prompt.length ? round(median(prompt)) : null, samples: ok.length, runId: run.id },
      suite: { name: 'model-manager-benchmark', version: 1 }, source: 'benchmark',
      limitations: [`median of ${ok.length} warm, uncontended requests; depends on prompt mix and max tokens`],
    } });
  }
  return out;
}

module.exports = { throughputRecords };
