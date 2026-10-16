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
    reason:supported ? 'Native MTP detected. Applies to this shared model when loaded.' : 'MTP head presence is unverified: the model manager does not report native MTP for this installation. Check the exact download files; a missing label is not proof that the head is absent.'};
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
// The MTP acceptance rate (and the last-response samples it fell back to) left with GET /api/stats:
// it is the Rust front's since sbstndalton/noevia#1071 (noevia-rs crates/server-stats).
module.exports={capability,loadOptions,specType};
