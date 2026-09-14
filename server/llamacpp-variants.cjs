'use strict';
// Public HF file metadata only. Do not forward the inference API key to HF.
async function variants(repo, fetchJson) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return {ok:false,status:400,body:{error:'Invalid repository'}};
  const result = await fetchJson(`https://huggingface.co/api/models/${repo}?blobs=true`, {}, 20000);
  if (!result.ok) return result;
  if (result.body?.private || !Array.isArray(result.body?.siblings)) return {ok:false,status:502,body:{error:'Public file metadata unavailable'}};
  const groups = new Map();
  for (const file of result.body.siblings) {
    const name = file.rfilename;
    if (typeof name !== 'string' || /mmproj/i.test(name)) continue;
    const match = /(?:^|[.\/_-])((?:IQ|Q)\d[\w]*|BF16|F16|F32)(?:-(\d{5})-of-(\d{5}))?\.gguf$/i.exec(name);
    if (!match) continue;
    const quant = match[1].toUpperCase(), group = groups.get(quant) || [];
    group.push({name, size:file.lfs?.size ?? file.size, shard:match[2], count:match[3]});groups.set(quant,group);
  }
  const rows = [];
  for (const [name, files] of groups) {
    // The native :quant selector cannot disambiguate two unrelated files.
    // Only expose a single file or a complete, consistently named shard set.
    const first=files[0], count=Number(first.count);
    const stem=f=>f.name.replace(/-\d{5}-of-\d{5}\.gguf$/i,'');
    const complete=first.shard && count===files.length && new Set(files.map(f=>f.shard)).size===count && files.every(f=>f.count===first.count && stem(f)===stem(first) && Number(f.shard)>=1 && Number(f.shard)<=count);
    if (files.length!==1 && !complete || first.shard && !complete) continue;
    const sizes=files.map(f=>f.size);
    rows.push({name,primary_file:first.name,files:files.map(f=>f.name),size_bytes:sizes.every(n=>Number.isFinite(n)&&n>0)?sizes.reduce((a,b)=>a+b,0):null});
  }
  return {ok:true,status:200,body:{suggested_name:repo,variants:rows.sort((a,b)=>a.name.localeCompare(b.name))}};
}
module.exports={variants};
