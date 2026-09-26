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
// The RAG reranker (NOEVIA_FEATURE_RAG_RERANK, rag.cjs) is the other small resident when enabled.
function keepAlongside() {
  const e = process.env.EMBEDDING_MODEL || process.env.EMBED_MODEL || '';
  const r = /^(1|true|on)$/i.test(process.env.NOEVIA_FEATURE_RAG_RERANK || '') ? (process.env.RERANK_MODEL || '').trim() : '';
  return [...(e && e !== 'default' ? [e] : []), ...(r ? [r] : [])];
}

function createLlamaCppManager({ baseUrl, apiKey, fetchJson, presetPath, downloadStatePath, fetchStream, autoconfig = {}, calibrationStatePath, calibrationOptions = {}, evidenceDir, autotuneStatePath, autotuneTablePath, autotuneOptions = {}, presetWriter = null }) {
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
  // Set once evidenceStore/importEvidence exist below; the tracker is created first because
  // presets/evidence require the request() helper this closure also builds.
  let onDownloadCompleted=null;
  const tracker=require('./llamacpp-downloads.cjs').createDownloadTracker({base,headers,file:downloadStatePath,fetchStream,onCompleted:model=>onDownloadCompleted?.(model)});
  const store=presetPath ? require('./llamacpp-presets.cjs').createPresetStore(presetPath,{writer:presetWriter}) : null;
  // Every commit (apply, calibration, auto-tune, restores) settles an uncertain Model Loader
  // write by reading models.ini back instead of assuming nothing changed (#339).
  const {commitReconciled}=require('./models-ini-writer.cjs');
  const presets=store ? {...store,commit:candidate=>commitReconciled(store,candidate)} : null;
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
  // The engine keeps two models so the small embedding model can sit beside the chat model
  // (tool routing, 2026-09-19). Two CHAT models would not fit the GPU, so before a chat model is
  // used, any other loaded model except those in `keep` is unloaded first.
  async function makeRoomFor(model, keep = keepAlongside()) {
    const listing = await rawModels().catch(() => null);
    if (!listing?.ok || !Array.isArray(listing.body?.data)) return;
    const others = listing.body.data.filter((m) => m.id !== model && !keep.includes(m.id) && ['loaded', 'loading'].includes(m.status?.value));
    for (const m of others) await post('/models/unload', { model: m.id }, 60000).catch(() => null);
  }
  async function load(model, options = {}, signal) {
    if (Object.keys(options).length) return unsupported('Runtime option changes; configure a native model preset');
    const leave=maintenance.enter();
    try {
      signal?.throwIfAborted();
      await makeRoomFor(model);
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
      const {isSystemModel,modelPathFromArgs,SYSTEM_MODEL_REASON}=require('./model-system.cjs');
      const listing=await rawModels();
      if(listing.ok){
        const row=(listing.body?.data||[]).find(m=>m.id===body?.model);
        if(row && isSystemModel(row.id, modelPathFromArgs(row.status?.args))) return {ok:false,status:400,body:{error:SYSTEM_MODEL_REASON}};
      }
      return applyUnlocked(body);
    });
  }
  // Caller must hold the maintenance gate (applyPreset or a calibration job).
  async function applyUnlocked(body) {
    const listing=await rawModels();
    if(!listing.ok) return listing;
    const models=listing.body?.data;
    if(!Array.isArray(models))throw Error('Invalid router model listing');
    if(!models.some(m=>m.id===body.model))return {ok:false,status:404,body:{error:'Choose an installed model'}};
    if(models.some(m=>!['unloaded'].includes(m.status?.value)))return {ok:false,status:409,body:{error:'Unload all router models and finish downloads before applying a profile. Other clients must remain stopped.'}};
    const candidate=presets.prepare(body);
    try {await presets.commit(candidate);}
    catch(e) {
      // A settled Model Loader outcome carries its own message; a 5xx would otherwise reach
      // the admin as "Internal error". Nothing was reloaded: the file is not ours to apply.
      if(e?.publicMessage&&e.status>=500)return {ok:false,status:e.status,body:{error:e.publicMessage,...(e.retryable?{retryable:true}:{})}};
      throw e;
    }
    try {
      const result=await request('/models?reload=1',{},120000);
      if(!result.ok)throw Error('Native reload failed');
      return {ok:true,status:200,body:{...presets.get(body.model),applied:true,qualification:'unqualified; load and test this profile before relying on its capacity'}};
    } catch {
      // Restore only our own version; never overwrite an operator's later edit.
      try {await presets.commit({baseRevision:candidate.revision,text:candidate.before});}
      catch(e) {
        if(e?.status===409)return {ok:false,status:503,body:{error:'Reload outcome is uncertain and the file changed again. Stop inference and inspect native presets before retrying.'}};
        if(e?.retryable)return {ok:false,status:503,body:{error:'Reload failed or timed out, and the previous preset file could not be restored: models.ini still holds the new settings. Check router and Model Loader health before retrying.'}};
        return {ok:false,status:503,body:{error:'Reload failed or timed out, and restoring the previous preset file could not be confirmed. Stop inference and inspect native presets before retrying.'}};
      }
      try {await request('/models?reload=1',{},120000);}catch {}
      return {ok:false,status:503,body:{error:'Reload failed or timed out. Previous preset file restored; check router health before retrying.'}};
    }
  }
  // Re-read models.ini after an edit made outside noevia's own preset editor. With a model
  // loaded this refuses unless the caller asked to unload it: the router must not swap the
  // settings under a running instance.
  async function reloadPresets({unload=false}={}) {
    return maintenance.exclusive(async()=>{
      const listing=await rawModels();
      if(!listing.ok)return listing;
      const loaded=(listing.body?.data||[]).filter(m=>['loaded','loading'].includes(m.status?.value));
      if(loaded.length&&!unload)return {ok:false,status:409,body:{error:'A model is loaded. Unload it to apply the new settings.',loaded:loaded.map(m=>m.id)}};
      for(const m of loaded)await post('/models/unload',{model:m.id},60000).catch(()=>null);
      const result=await request('/models?reload=1',{},120000);
      return result.ok?{ok:true,status:200,body:{reloaded:true,unloaded:loaded.map(m=>m.id)}}:{ok:false,status:502,body:{error:'The engine did not reload its settings. Check the Hardware tab.'}};
    });
  }
  // Maps an engine-side path (/models/..., /cache/...) onto noevia's read-only mounts.
  function localFile(containerPath) {
    const fs=require('node:fs'),path=require('node:path');
    const roots=[['/models/',autoconfig.modelsPath],['/cache/',autoconfig.cachePath]];
    for(const [prefix,root] of roots){
      if(!root||typeof containerPath!=='string'||!containerPath.startsWith(prefix))continue;
      let real,base;
      try{base=fs.realpathSync(root);real=fs.realpathSync(path.join(root,containerPath.slice(prefix.length)));}catch{return null;}
      if(!real.startsWith(base+path.sep))return null;
      const stat=fs.statSync(real);return stat.isFile()?{file:real,size:stat.size}:null;
    }
    return null;
  }
  // The router reports each model's effective argv, which names its files even when the
  // model came from the download cache and has no preset section of its own.
  async function modelFiles(model) {
    let args=[];
    try {const listing=await rawModels();args=listing.body?.data?.find(m=>m.id===model)?.status?.args||[];}catch {}
    const flag=names=>{const i=args.findIndex(a=>names.includes(a));return i>=0?args[i+1]:undefined;};
    const fromPreset=presets?presets.files(model):{};
    return {model:flag(['--model','-m'])||fromPreset.model,mmproj:flag(['--mmproj','-mm'])||fromPreset.mmproj};
  }
  async function readModel(model) {
    const files=await modelFiles(model);
    const modelFile=localFile(files.model);
    if(!modelFile)return {error:'The model file is not visible under noevia\'s read-only model mounts.',status:404};
    const mmproj=files.mmproj?localFile(files.mmproj):null;
    if(files.mmproj&&!mmproj)return {error:'The vision projector is not visible under noevia\'s read-only model mounts.',status:404};
    const {readGguf,summarize}=require('./gguf-meta.cjs');
    try{return {meta:summarize(readGguf(modelFile.file)),modelFile,mmproj};}catch(e){return {error:'Could not read model metadata: '+e.message,status:422};}
  }
  // Size-based preset suggestion. Never writes; the admin applies it through applyPreset.
  async function suggestPreset(model) {
    if(!presets)return unsupported('Native preset suggestions; configure LLAMACPP_PRESET_PATH');
    const {modelsPath,budgetGib,cacheRamMaxMib}=autoconfig;
    if(!modelsPath)return {ok:false,status:501,body:{error:'Suggestions need the model directory mounted read-only; set LLAMACPP_MODELS_PATH.'}};
    if(!(budgetGib>0))return {ok:false,status:501,body:{error:'Suggestions need an inference memory budget; set LLAMACPP_AUTOCONFIG_MEMORY_GIB or LLAMACPP_MEMORY_LIMIT.'}};
    const profile=presets.get(model);
    const read=await readModel(model);
    if(read.error)return {ok:false,status:read.status,body:{error:read.error}};
    const result=require('./llamacpp-autoconfig.cjs').suggest({meta:read.meta,modelBytes:read.modelFile.size,mmprojBytes:read.mmproj?.size||0,budgetGib,current:{...profile.defaults,...profile.options},cacheRamMaxMib});
    return {ok:true,status:200,body:{model,revision:profile.revision,arch:read.meta.arch,...result}};
  }
  // Memory-estimate inputs for the guided "Will it fit?" panel (#204). Reads the model file's
  // metadata only; never loads, writes or measures. budgetGib is null when none is configured.
  async function estimateMemory(model) {
    if(!presets)return unsupported('Memory estimates; configure LLAMACPP_PRESET_PATH');
    if(!autoconfig.modelsPath)return {ok:false,status:501,body:{error:'Estimates need the model directory mounted read-only; set LLAMACPP_MODELS_PATH.'}};
    const profile=presets.get(model);
    const read=await readModel(model);
    if(read.error)return {ok:false,status:read.status,body:{error:read.error}};
    const inputs=require('./llamacpp-autoconfig.cjs').estimateInputs({meta:read.meta,modelBytes:read.modelFile.size,mmprojBytes:read.mmproj?.size||0,current:{...profile.defaults,...profile.options}});
    return {ok:true,status:200,body:{model,budgetGib:autoconfig.budgetGib>0?autoconfig.budgetGib:null,...inputs}};
  }
  // Starting settings for calibration: structural values from the model file; the context
  // itself is measured, so an unconfigured memory budget is not an obstacle here.
  async function conservativeFor(model) {
    const read=await readModel(model);
    if(read.error)return null;
    const profile=presets.get(model);
    const result=require('./llamacpp-autoconfig.cjs').suggest({meta:read.meta,modelBytes:read.modelFile.size,mmprojBytes:read.mmproj?.size||0,budgetGib:autoconfig.budgetGib>0?autoconfig.budgetGib:1e6,current:{...profile.defaults,...profile.options},cacheRamMaxMib:autoconfig.cacheRamMaxMib});
    return {native:read.meta.contextLength||0,values:result.values||null};
  }
  // Live identity of a model's current configuration (spec-agent-execution §1). Null when
  // the engine or the model file cannot be read: evidence is then `unavailable`.
  const evidenceLib=require('./evidence.cjs');
  const evidenceStore=evidenceDir?evidenceLib.createStore(evidenceDir):null;
  const identityCache=new Map();
  async function evidenceIdentity(model) {
    const hit=identityCache.get(model);
    if(hit&&Date.now()-hit.at<30000)return hit.value;
    const value=await computeIdentity(model);
    identityCache.set(model,{at:Date.now(),value});
    if(identityCache.size>64)identityCache.delete(identityCache.keys().next().value);
    return value;
  }
  async function computeIdentity(model) {
    const files=await modelFiles(model);
    const artifact=evidenceLib.fileFingerprint(localFile(files.model)?.file);
    if(!artifact)return null;
    let build=null;try{const props=await request('/props',{},8000);build=props?.body?.build_info||null;}catch{}
    const profile=presets?presets.get(model):{options:{},defaults:{}};
    const options={...(profile.defaults||{}),...(profile.options||{})};
    const draft=options['spec-draft-model']?evidenceLib.fileFingerprint(localFile(options['spec-draft-model'])?.file):null;
    const identity={backend:'llamacpp',build,endpoint:evidenceLib.identityHash(base).slice(0,16),model,artifact,
      projector:files.mmproj?evidenceLib.fileFingerprint(localFile(files.mmproj)?.file):null,preset:evidenceLib.presetHash(options),
      context:{ctx:options['ctx-size']||null,parallel:options.parallel||null,cacheK:options['cache-type-k']||null,cacheV:options['cache-type-v']||null},
      mtp:options['spec-type']?{type:options['spec-type'],draft}:null};
    return {identity,identityHash:evidenceLib.identityHash(identity)};
  }
  async function recordEvidence(model,record){
    if(!evidenceStore)return null;
    // Only frequent reported rates may use the cached identity; results right after a
    // configuration change (calibration) must be filed under the new configuration.
    const live=record.result==='reported'?await evidenceIdentity(model):await computeIdentity(model);
    if(!live)return null;
    const entry={model,identityHash:live.identityHash,identity:live.identity,...record};
    return record.result==='reported'&&Number.isFinite(Number(record.value?.rate))?evidenceStore.appendReportedRate(entry):evidenceStore.appendIfChanged(entry);
  }
  async function evidence(model){
    const live=evidenceStore?await computeIdentity(model):null;
    if(evidenceStore)identityCache.set(model,{at:Date.now(),value:live});
    const records=evidenceStore?evidenceStore.list():[];
    const importLib=require('./model-evidence-import.cjs');
    const external=importLib.deriveExternal(records,{model,artifactHash:live?.identity?.artifact?importLib.artifactIdentityHash(live.identity.artifact):null});
    return {ok:true,status:200,body:{model,tracked:!!evidenceStore,identityHash:live?.identityHash||null,
      categories:evidenceLib.CATEGORIES.map(category=>{const d=evidenceLib.derive(records,{model,category,liveHash:live?.identityHash||null});
        return {category,state:d.state,value:d.record?.value??null,result:d.record?.result??null,at:d.record?.at??null,suite:d.record?.suite??null,limitations:d.record?.limitations||[]};}),
      external:{category:'external_model_card',state:external.state,value:external.record?.value??null,at:external.record?.at??null,suite:external.record?.suite??null,
        provenance:external.record?.provenance??null,limitations:external.record?.limitations||[]}}};
  }
  // Best-effort import of attributable model-card evidence for one model (#266). The
  // checkpoint (HF repo) equals the llama.cpp model id for a pulled model; a locally
  // renamed or non-HF model simply has no importable checkpoint and this resolves to
  // { ok:false }. An explicit checkpoint override (only reachable from the admin-only
  // "fetch evidence" route) is rejected unless it names the same repository as the model
  // itself — see resolveCheckpoint in model-evidence-import.cjs — so an admin cannot
  // attribute an unrelated repo's card to this model. This resolves failures, it does not
  // throw for them; but the write it performs (store.append, on a change) can still throw
  // on credential-shaped content, so every caller here (the download-completed hook and the
  // explicit route) catches and swallows.
  async function importEvidence(model,{checkpoint}={}){
    const importLib=require('./model-evidence-import.cjs');
    const live=await computeIdentity(model);
    if(!live)return {ok:false,reason:'model artifact unavailable'};
    return importLib.importModelEvidence({model,checkpoint,artifact:live.identity.artifact,fetchJson,store:evidenceStore,now:()=>Date.now()});
  }
  onDownloadCompleted=evidenceStore?(model=>importEvidence(model).catch(()=>{})):null;
  // Identity for the auto-tune lookup table: architecture, quantisation and hardware class.
  async function tuneIdentity(model){
    const read=await readModel(model);
    const file=read.modelFile?.file||'';
    const quant=(/(?:^|[-_.])((?:UD-)?(?:IQ\d[\w]*|Q\d(?:_[\dKSMLX]+)*|F16|BF16|F32|MXFP4))(?:[-_.]|\.gguf$)/i.exec(require('node:path').basename(file))||[])[1]||null;
    let build=null;try{build=(await request('/props',{},8000))?.body?.build_info||null;}catch{}
    let memGiB=null;try{memGiB=Math.round(Number(/^MemTotal:\s+(\d+)/m.exec(require('node:fs').readFileSync('/proc/meminfo','utf8'))[1])/1048576);}catch{}
    const parsed=presets?require('./llamacpp-presets.cjs').parse(presets.snapshot().text):null;
    const sectionText=name=>{const s=parsed?.sections.get(name);return s?parsed.lines.slice(s.start,s.end).join('\n'):'';};
    return {arch:read.meta?.arch||null,quant:quant&&quant.toUpperCase(),artifact:evidenceLib.fileFingerprint(file),build,
      profile:evidenceLib.identityHash([sectionText('*'),sectionText(model)]),
      hardware:[autoconfig.hardwareLabel||null,memGiB?`${memGiB}GiB`:null,JSON.stringify(build)].filter(Boolean).join(' ')||null};
  }
  const calibrator=presets?require('./llamacpp-calibration.cjs').createCalibrator({request,rawModels,presets,maintenance,applyUnlocked,conservativeFor,onResult:({model,status,entry})=>recordEvidence(model,status==='passed'?{category:'context_capacity',result:'passed',value:{ctx:entry.verifiedCtx,appliedCtx:entry.appliedCtx,slots:entry.slots},suite:{name:'native-calibration',version:1},source:'calibration',limitations:[`prompt budget ${entry.promptBudgetSeconds} s`]}:{category:'context_capacity',result:'failed',value:null,suite:{name:'native-calibration',version:1},source:'calibration',limitations:[String(entry.error||'').slice(0,200)]}),stream:(path,opts={})=>(fetchStream||fetch)(base+path,{...opts,headers:headers(opts.headers),redirect:'error'}),stateFile:calibrationStatePath,memoryFloorGib:autoconfig.memoryFloorGib||2,...calibrationOptions}):null;
  const speedDeps={request,rawModels,presets,maintenance,applyUnlocked,identityFor:tuneIdentity,
    calibrate:(model,promptBudgetSeconds)=>calibrator.start(model,{confirmPause:true,promptBudgetSeconds}),
    stateFile:autotuneStatePath,tableFile:autotuneTablePath,memoryFloorGib:autoconfig.memoryFloorGib||2,...(calibrationOptions.readMemory?{readMemory:calibrationOptions.readMemory}:{}),...autotuneOptions};
  // Internal context checks run under the full tuner's per-model lease; standalone
  // calibration still acquires the real gate.
  const managedGate={hold:()=>()=>{}};
  const autotuner=presets&&autotuneStatePath?(autotuneOptions.speedOnly===true
    ?require('./llamacpp-autotune.cjs').createAutotuner(speedDeps)
    :require('./llamacpp-full-autotune.cjs').createFullAutotuner({request,rawModels,presets,maintenance,applyUnlocked,identityFor:speedDeps.identityFor,stateFile:autotuneStatePath,
      readMemory:speedDeps.readMemory,memoryFloorGib:speedDeps.memoryFloorGib,
      ...(autotuneOptions.betweenModelsMs!=null?{betweenModelsMs:autotuneOptions.betweenModelsMs}:{}),
      ...(autotuneOptions.idleTimeoutMs!=null?{idleTimeoutMs:autotuneOptions.idleTimeoutMs}:{}),
      ...(autotuneOptions.sleep?{sleep:autotuneOptions.sleep}:{}),
      onResult:async({model,result})=>{for(const [category,value] of [['context_capacity',{ctx:result.context,appliedCtx:result.context,slots:Number(presets.get(model).options.parallel)||1}],['throughput',{rate:result.generation}],...(result.acceptance==null?[]:[['mtp_acceptance',{rate:result.acceptance/100}]])])await recordEvidence(model,{category,result:'passed',value,suite:{name:'full-autotune',version:3},source:'autotune',limitations:['Three deterministic quality smoke probes, not a general quality benchmark','120 s default prompt budget; existing MTP head only']});},
      contextFactory:hooks=>require('./llamacpp-calibration.cjs').createCalibrator({request,rawModels,presets,applyUnlocked,conservativeFor,maintenance:managedGate,
        stream:(path,opts={})=>(fetchStream||fetch)(base+path,{...opts,headers:headers(opts.headers),redirect:'error'}),
        memoryFloorGib:autoconfig.memoryFloorGib||2,...calibrationOptions,stateFile:undefined,...hooks})})):null;
  return {
    kind: 'llamacpp', enabled: true, baseUrl: base, headers, request,
    capabilities: { routing: true, load: true, unload: true, download: true, deleteCached: true, runtimeOptions: false, hardware: false, presets: !!presets, autotune: !!autotuner },
    requireEnabled() {},
    listModels, health, load, downloads, makeRoomFor,
    close:tracker.close,
    enterInference: maintenance.enter,
    getPreset: model => presets ? Promise.resolve({ok:true,status:200,body:presets.get(model)}) : unsupported('Native preset editing'),
    applyPreset,
    suggestPreset,
    estimateMemory,
    reloadPresets,
    evidence, recordEvidence, importEvidence,
    calibration: calibrator ? { start: calibrator.start, cancel: calibrator.cancel, status: calibrator.status, recover: calibrator.recover } : null,
    autotune: autotuner ? { start: autotuner.start, resume: autotuner.resume, cancel: autotuner.cancel, status: autotuner.status, recover: autotuner.recover, untuned: autotuner.untuned } : null,
    unload: model => mutate(()=>post('/models/unload', { model })),
    pull: ({ checkpoint }) => mutate(async () => {
      if (!/^[\w.-]+\/[\w.-]+(?::[\w.-]+)?$/.test(checkpoint || '')) return { ok: false, status: 400, body: { error: 'Choose a Hugging Face repository and quantization' } };
      tracker.requested(checkpoint);
      const response = await post('/models', { model: checkpoint });
      if(!response.ok)tracker.rejected(checkpoint);
      return response.ok ? { ...response, body: { ...response.body, id: checkpoint, modelName: checkpoint } } : response;
    }),
    deleteModel: model => mutate(async () => { const r = await request('/models?model=' + encodeURIComponent(model), { method: 'DELETE' }, 60000); if (r.ok) identityCache.delete(model); return r; }),
    // Unload-then-delete as ONE mutate() gate, so an on-demand load triggered by another
    // request cannot slip in between the two the way it could with separate unload()/
    // deleteModel() calls. If the delete is still refused (busy, or a load raced in despite
    // the gate — the router itself can start one outside this process's control), retry the
    // unload once more and try the delete again before giving up.
    removeModel: model => mutate(async () => {
      let unloaded = !!(await post('/models/unload', { model }).catch(() => null))?.ok;
      let del = await request('/models?model=' + encodeURIComponent(model), { method: 'DELETE' }, 60000);
      if (!del.ok) {
        if ((await post('/models/unload', { model }).catch(() => null))?.ok) unloaded = true;
        del = await request('/models?model=' + encodeURIComponent(model), { method: 'DELETE' }, 60000);
      }
      if (del.ok) identityCache.delete(model);
      return { ...del, unloaded };
    }),
    // Exposed so callers that delete a model's files through a different path (the raw
    // model-manager folder-scan proxy, routes/models.cjs) can still drop its cached identity.
    forgetIdentity: model => identityCache.delete(model),
    props: model => request('/props' + modelQuery(model)),
    metrics: model => model ? request('/metrics' + modelQuery(model), {}, 6000) : unsupported('Aggregate metrics'),
    stats,
    systemStats: () => unsupported('Host telemetry'),
    systemInfo: () => unsupported('Host hardware discovery'),
    variants: repo => require('./llamacpp-variants.cjs').variants(repo, fetchJson),
  };
}
module.exports = { createLlamaCppManager };
