'use strict';

// Native llama-server router API. Model processes, routing and eviction remain
// owned by llama.cpp; noevia never launches a process through this adapter.
// Router status.args is effective argv, available before a model is loaded.
// Match complete flag tokens only; paths and model names are not capabilities.
function nativeLabels(model) {
  const args = Array.isArray(model.status?.args) ? model.status.args : [];
  return [
    ...(args.some(arg => ['--embedding', '--embeddings'].includes(arg)) ? ['embeddings'] : []),
    ...(args.some(arg => ['--rerank', '--reranking'].includes(arg)) ? ['reranking'] : []),
    ...(model.architecture?.input_modalities?.includes('image') ? ['vision'] : []),
  ];
}
function createLlamaCppManager({ baseUrl, apiKey, fetchJson, presetPath, downloadStatePath, fetchStream, autoconfig = {} }) {
  const base = String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Invalid llama.cpp router URL');
  function headers(extra) {
    return { 'Content-Type': 'application/json', ...(apiKey && apiKey !== 'local' ? { Authorization: `Bearer ${apiKey}` } : {}), ...(extra || {}) };
  }
  const request = (path, options = {}, timeout = 8000) => fetchJson(base + path, { ...options, headers: headers(options.headers) }, timeout);
  const post = (path, body, timeout = 120000, signal) => request(path, { method: 'POST', body: JSON.stringify(body), signal }, timeout);
  const unsupported = operation => Promise.resolve({ ok: false, status: 501, body: { error: `${operation} is not exposed by this llama.cpp adapter` } });
  const modelQuery = model => '?model=' + encodeURIComponent(model) + '&autoload=false';
  const rawModels = signal => request('/models', {signal});
  const tracker=require('./llamacpp-downloads.cjs').createDownloadTracker({base,headers,file:downloadStatePath,fetchStream});
  const presets=presetPath ? require('./llamacpp-presets.cjs').createPresetStore(presetPath) : null;
  const maintenance=require('./inference-maintenance.cjs').createMaintenanceGate();
  async function mutate(fn) {const leave=maintenance.enter();try{return await fn();}finally{leave();}}
  async function listModels() {
    const response = await rawModels();
    if (!response.ok) return response;
    if (!Array.isArray(response.body?.data)) throw Error('Invalid llama.cpp model listing');
    return { ...response, body: { data: response.body.data.map(model => ({
      id: model.id,
      status: { value: model.status?.value || 'unknown', failed: model.status?.failed === true },
      source: model.source || null, can_remove: model.can_remove === true,
      loaded: model.status?.value === 'loaded',
      labels: nativeLabels(model),
      // Router metadata is an architecture ceiling, never a live allocation.
      max_context_window: Number.isFinite(model.meta?.n_ctx_train) ? model.meta.n_ctx_train : null,
      size: Number.isFinite(model.meta?.size) ? model.meta.size / 1e9 : null,
      recipe: 'llamacpp',
    })) } };
  }
  async function health() {
    const response = await rawModels();
    if (!response.ok) return response;
    if (!Array.isArray(response.body?.data)) throw Error('Invalid llama.cpp model listing');
    const loaded = response.body.data.filter(model => model.status?.value === 'loaded');
    const models = [];
    // Bound concurrent router requests. autoload=false is essential: polling
    // must not evict an active model or wake an unloaded one on a small GPU.
    for (let i = 0; i < loaded.length; i += 4) {
      models.push(...await Promise.all(loaded.slice(i, i + 4).map(async model => {
        let props;
        try { props = await request('/props' + modelQuery(model.id)); } catch {}
        const context = props?.ok ? Number(props.body?.default_generation_settings?.n_ctx) : NaN;
        const slots = props?.ok ? Number(props.body?.total_slots) : NaN;
        return { model_name: model.id, loaded: true, backend_alive: props?.ok === true,
          recipe_options: { native_profile: require('node:crypto').createHash('sha256').update(JSON.stringify([model.id,model.status?.args,model.meta])).digest('hex'), ...(Number.isSafeInteger(context) && context > 0 ? { ctx_size: context } : {}) },
          slots: Number.isSafeInteger(slots) && slots > 0 ? slots : null,
          engineVersion: props?.ok ? props.body?.build_info || null : null };
      })));
    }
    return { ...response, body: { manager: 'llamacpp', version: null, all_models_loaded: models } };
  }
  async function load(model, options = {}, signal) {
    if (Object.keys(options).length) return unsupported('Runtime option changes; configure a native model preset');
    const leave=maintenance.enter();
    try {
      signal?.throwIfAborted();
      const started=await post('/models/load', { model },120000,signal);
      if(!started.ok)return started;
      // Native load acknowledges launch; readiness must be observed separately.
      const deadline=Date.now()+120000;
      while(Date.now()<deadline) {
        signal?.throwIfAborted();
        const listing=await rawModels(signal);
        if(!listing.ok)return listing;
        const entry=listing.body?.data?.find(m=>m.id===model);
        if(entry?.status?.value==='loaded')return started;
        if(!entry || entry.status?.failed || entry.status?.value==='unloaded')return {ok:false,status:502,body:{error:'The native model failed to become ready. Check its artifact and preset.'}};
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      return {ok:false,status:504,body:{error:'Native model loading is still unconfirmed. Check its status before retrying.'}};
    }finally{leave();}
  }
  async function downloads() {
    tracker.connect();
    const response=await rawModels();
    if(!response.ok)return response;
    if(!Array.isArray(response.body?.data))throw Error('Invalid router download listing');
    return {...response,body:{jobs:tracker.snapshot(response.body.data)}};
  }
  async function stats() {
    const listing=await rawModels();
    if (!listing.ok) return listing;
    const loaded=(listing.body?.data || []).filter(m=>m.status?.value==='loaded');
    const rows=[];
    for (let i=0;i<loaded.length;i+=4) {
      rows.push(...await Promise.all(loaded.slice(i,i+4).map(async m=>{
        let result;try { result=await request('/metrics'+modelQuery(m.id),{},6000); } catch {}
        return {model:m.id,values:result?.ok ? require('./llamacpp-metrics.cjs').parseMetrics(result.body) : {}};
      })));
    }
    return {ok:true,status:200,body:require('./llamacpp-metrics.cjs').summarize(rows)};
  }
  async function applyPreset(body) {
    if(!presets)return unsupported('Native preset editing; configure LLAMACPP_PRESET_PATH');
    if(body?.confirmReload!==true) return {ok:false,status:400,body:{error:'Confirm that other clients and Diary background inference are stopped before reloading.'}};
    return maintenance.exclusive(async()=>{
      const listing=await rawModels();
      if(!listing.ok) return listing;
      const models=listing.body?.data;
      if(!Array.isArray(models))throw Error('Invalid router model listing');
      if(!models.some(m=>m.id===body.model))return {ok:false,status:404,body:{error:'Choose an installed model'}};
      if(models.some(m=>!['unloaded'].includes(m.status?.value)))return {ok:false,status:409,body:{error:'Unload all router models and finish downloads before applying a profile. Other clients must remain stopped.'}};
      const candidate=presets.prepare(body);
      presets.commit(candidate);
      try {
        const result=await request('/models?reload=1',{},120000);
        if(!result.ok)throw Error('Native reload failed');
        return {ok:true,status:200,body:{...presets.get(body.model),applied:true,qualification:'unqualified; load and test this profile before relying on its capacity'}};
      } catch {
        // Restore only our own version; never overwrite an operator's later edit.
        try {presets.commit({baseRevision:candidate.revision,text:candidate.before});}
        catch {return {ok:false,status:503,body:{error:'Reload outcome is uncertain and the file changed again. Stop inference and inspect native presets before retrying.'}};}
        try {await request('/models?reload=1',{},120000);}catch {}
        return {ok:false,status:503,body:{error:'Reload failed or timed out. Previous preset file restored; check router health before retrying.'}};
      }
    });
  }
  // Size-based preset suggestion. Reads model file headers through a read-only mount and
  // never writes; the admin reviews and applies it through applyPreset.
  async function suggestPreset(model) {
    if(!presets)return unsupported('Native preset suggestions; configure LLAMACPP_PRESET_PATH');
    const {modelsPath,budgetGib,cacheRamMaxMib}=autoconfig;
    if(!modelsPath)return {ok:false,status:501,body:{error:'Suggestions need the model directory mounted read-only; set LLAMACPP_MODELS_PATH.'}};
    if(!(budgetGib>0))return {ok:false,status:501,body:{error:'Suggestions need an inference memory budget; set LLAMACPP_AUTOCONFIG_MEMORY_GIB or LLAMACPP_MEMORY_LIMIT.'}};
    const profile=presets.get(model);
    if(!profile.exists)return {ok:false,status:404,body:{error:'This model has no preset section to size.'}};
    const files=presets.files(model);
    const resolve=containerPath=>{
      // Preset paths are llama-container paths under /models; map onto our mount.
      if(typeof containerPath!=='string'||!containerPath.startsWith('/models/'))return null;
      const fs=require('node:fs'),path=require('node:path');
      const root=fs.realpathSync(modelsPath),candidate=path.join(modelsPath,containerPath.slice('/models/'.length));
      let real;try{real=fs.realpathSync(candidate);}catch{return null;}
      if(!real.startsWith(root+path.sep))return null;
      const stat=fs.statSync(real);return stat.isFile()?{file:real,size:stat.size}:null;
    };
    const modelFile=resolve(files.model);
    if(!modelFile)return {ok:false,status:404,body:{error:'The preset\'s model file is not visible under the read-only model mount.'}};
    const mmproj=files.mmproj?resolve(files.mmproj):null;
    if(files.mmproj&&!mmproj)return {ok:false,status:404,body:{error:'The preset\'s vision projector is not visible under the read-only model mount.'}};
    const {readGguf,summarize}=require('./gguf-meta.cjs');
    let meta;try{meta=summarize(readGguf(modelFile.file));}catch(e){return {ok:false,status:422,body:{error:'Could not read model metadata: '+e.message}};}
    const result=require('./llamacpp-autoconfig.cjs').suggest({meta,modelBytes:modelFile.size,mmprojBytes:mmproj?.size||0,budgetGib,current:{...profile.defaults,...profile.options},cacheRamMaxMib});
    return {ok:true,status:200,body:{model,revision:profile.revision,arch:meta.arch,...result}};
  }
  return {
    kind: 'llamacpp', enabled: true, baseUrl: base, headers, request,
    capabilities: { routing: true, load: true, unload: true, download: true, deleteCached: true, runtimeOptions: false, hardware: false, presets: !!presets },
    requireEnabled() {},
    listModels, health, load, downloads,
    close:tracker.close,
    enterInference: maintenance.enter,
    getPreset: model => presets ? Promise.resolve({ok:true,status:200,body:presets.get(model)}) : unsupported('Native preset editing'),
    applyPreset,
    suggestPreset,
    unload: model => mutate(()=>post('/models/unload', { model })),
    pull: ({ checkpoint }) => mutate(async () => {
      if (!/^[\w.-]+\/[\w.-]+(?::[\w.-]+)?$/.test(checkpoint || '')) return { ok: false, status: 400, body: { error: 'Choose a Hugging Face repository and quantization' } };
      tracker.requested(checkpoint);
      const response = await post('/models', { model: checkpoint });
      if(!response.ok)tracker.rejected(checkpoint);
      return response.ok ? { ...response, body: { ...response.body, id: checkpoint, modelName: checkpoint } } : response;
    }),
    deleteModel: model => mutate(()=>request('/models?model=' + encodeURIComponent(model), { method: 'DELETE' }, 60000)),
    props: model => request('/props' + modelQuery(model)),
    metrics: model => model ? request('/metrics' + modelQuery(model), {}, 6000) : unsupported('Aggregate metrics'),
    stats,
    systemStats: () => unsupported('Host telemetry'),
    systemInfo: () => unsupported('Host hardware discovery'),
    variants: repo => require('./llamacpp-variants.cjs').variants(repo, fetchJson),
  };
}
module.exports = { createLlamaCppManager };
