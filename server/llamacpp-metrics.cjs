'use strict';
function parseMetrics(text) {
  const values = {};
  for (const line of String(text || '').split('\n')) {
    const match = /^llamacpp:([a-z_]+)\s+([^\s]+)$/.exec(line);
    if (!match) continue;
    const n=Number(match[2]);
    if (Number.isFinite(n) && n>=0) values[match[1]]=n;
  }
  return values;
}
function summarize(rows) {
  const sum = key => rows.length && rows.every(r=>Number.isFinite(r.values[key])) ? rows.reduce((n,r)=>n+r.values[key],0) : null;
  return {
    // Native totals are for currently loaded processes, and reset on eviction.
    scope:'loaded model processes; counters reset on unload',
    tokens_per_second:sum('predicted_tokens_seconds'),
    input_tokens_total:sum('prompt_tokens_total'), output_tokens_total:sum('tokens_predicted_total'),
    mtp:rows.flatMap(({model,values:v})=>{
      const drafted=v.spec_decode_num_draft_tokens_total,accepted=v.spec_decode_num_accepted_tokens_total;
      return drafted>0 && Number.isFinite(accepted) && accepted<=drafted ? [{model,drafted,accepted,rate:accepted/drafted,source:'backend total'}] : [];
    }),
  };
}
module.exports={parseMetrics,summarize};
