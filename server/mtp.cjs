'use strict';
// Lemonade 10.8 exposes GGUF-derived `mtp` labels and saved recipe_options.
function tokens(args='') {
  const input=String(args), result=[];
  let i=0;
  while(i<input.length){
    if (/\s/.test(input[i])) {i++;continue;}
    const start=i;let value='',quote='';
    while(i<input.length){
      const c=input[i];
      if(!quote && /\s/.test(c))break;
      if(c==='\\' && quote!=="'" && i+1<input.length){value+=input[i+1];i+=2;continue;}
      if(c===quote){quote='';i++;continue;}
      if(!quote && (c==='"' || c==="'")){quote=c;i++;continue;}
      value+=c;i++;
    }
    result.push({start,end:i,value});
  }
  return result;
}
function specType(args='') {
  const parts=tokens(args);let value=null;
  for(let i=0;i<parts.length;i++){
    if(parts[i].value==='--spec-type')value=parts[++i]?.value || null;
    else if(parts[i].value.startsWith('--spec-type='))value=parts[i].value.slice(12);
  }
  return value;
}
function withoutSpecType(args='') {
  const parts=tokens(args), ranges=[];
  for(let i=0;i<parts.length;i++){
    const part=parts[i];
    if(part.value==='--spec-type')ranges.push([part.start,parts[++i]?.end || part.end]);
    else if(part.value.startsWith('--spec-type='))ranges.push([part.start,part.end]);
  }
  let result=String(args);
  for(const [start,end] of ranges.reverse())result=result.slice(0,start)+result.slice(end);
  return result.trim();
}
function capability(model) {
  const supported=model.recipe==='llamacpp' && model.labels?.includes('mtp');
  const type=specType(model.recipe_options?.llamacpp_args);
  return {supported:!!supported, enabled:supported ? (type===null || type.split(',').includes('draft-mtp')) : false,
    reason:supported ? 'Native MTP detected. Applies to this shared model when loaded.' : 'This installed file does not report MTP weights. Even if the original model supports MTP, its GGUF must include the MTP head. Use an MTP-enabled checkpoint.'};
}
function loadOptions(model, enabled) {
  if(typeof enabled!=='boolean') throw new Error('MTP must be Yes or No');
  if(!capability(model).supported) throw new Error('This model does not report native MTP support. Use a compatible MTP checkpoint; a separate draft model needs its own configuration.');
  const options={...(model.recipe_options || {})};
  // Preserve other flags and every recipe option, including GPU splitting/cache settings.
  const args=withoutSpecType(options.llamacpp_args || '');
  options.llamacpp_args=`${args} --spec-type ${enabled?'draft-mtp':'none'}`.trim();
  return options;
}
function acceptance(metrics, models, installed=[], owner) {
  const rows=[];
  for(const m of models || []) {
    const registered=installed.find(row=>(row.id || row.model_name)===m.model_name);
    const type=specType(m.recipe_options?.llamacpp_args);
    const enabled=type===null ? !!(registered && capability(registered).enabled) : type.split(',').includes('draft-mtp');
    if(!m.loaded || m.type!=='llm' || !enabled) continue;
    const counters={};
    for(const line of String(metrics || '').split('\n')) {
      const match=/^lemonade_llamacpp_spec_decode_num_(draft|accepted)_tokens_total\{([^}]*)\}\s+([^\s]+)/.exec(line);
      if(!match) continue;
      const name=/(?:^|,)model_name=("(?:[^"\\]|\\.)*")/.exec(match[2]);
      if(!name || JSON.parse(name[1])!==m.model_name)continue;
      const n=Number(match[3]);if(!Number.isFinite(n)||n<0)continue;
      counters[match[1]]=(counters[match[1]]||0)+n;
    }
    const drafted=counters.draft,accepted=counters.accepted;
    const rate=Number.isFinite(drafted)&&drafted>0&&Number.isFinite(accepted)&&accepted<=drafted ? accepted/drafted : null;
    const last=samples.get(`${owner}:${m.model_name}`);
    const fallback=last && Date.now()-last.at < 10*60*1000 ? last : null;
    rows.push(rate===null && fallback ? {model:m.model_name,rate:fallback.accepted/fallback.drafted,drafted:fallback.drafted,accepted:fallback.accepted,source:'last response'} : {model:m.model_name,rate,drafted:drafted??null,accepted:accepted??null,source:'backend total'});
  }
  return rows;
}
const samples=new Map();
function record(owner,model,timings) {
  const drafted=timings?.draft_n,accepted=timings?.draft_n_accepted;
  if(!owner || typeof model!=='string' || !model || drafted===undefined)return;
  const key=`${owner}:${model}`;
  if(!Number.isFinite(drafted) || drafted<=0 || !Number.isFinite(accepted) || accepted<0 || accepted>drafted){samples.delete(key);return;}
  samples.delete(key);samples.set(key,{drafted,accepted,at:Date.now()});
  while(samples.size>200)samples.delete(samples.keys().next().value);
}
module.exports={capability,loadOptions,acceptance,specType,record};
