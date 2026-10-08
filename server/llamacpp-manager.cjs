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
// Small models that may stay beside the chat model on a multi-slot engine: the embedding model,
// only while embeddings are served by this engine (no EMBEDDING_BASE_URL sidecar), and the RAG
// reranker, only where it is allowed on the shared engine (rerank-target.cjs, #697).
function keepAlongside(env = process.env) {
  const e = String(env.EMBEDDING_BASE_URL || '').trim() ? '' : (env.EMBEDDING_MODEL || env.EMBED_MODEL || '');
  const target = require('./rerank-target.cjs').rerankTarget(env);
  const r = target.enabled && target.shared ? target.model || '' : '';
  return [...(e && e !== 'default' ? [e] : []), ...(r ? [r] : [])];
}

function createLlamaCppManager({ baseUrl, apiKey, fetchJson, presetPath, downloadStatePath, fetchStream, autoconfig = {}, calibrationStatePath, calibrationOptions = {}, evidenceDir, autotuneStatePath, autotuneOptions = {}, presetWriter = null, unloadWait = {}, inferenceBudget = null, reloadStatePath = null, reloadGuard: reloadGuardOption = null }) {
  const base = String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Invalid llama.cpp router URL');
  function headers(extra) {
    return { 'Content-Type': 'application/json', ...(apiKey && apiKey !== 'local' ? { Authorization: `Bearer ${apiKey}` } : {}), ...(extra || {}) };
  }
  const rawRequest = (path, options = {}, timeout = 8000) => fetchJson(base + path, { ...options, headers: headers(options.headers) }, timeout);
  // #697: every load this process asks for (the Models page, calibration, auto-tune) passes the
  // inference memory budget first. Chat loads pass it in makeRoomFor, before anything is evicted.
  async function request(path, options = {}, timeout = 8000) {
    if (path === '/models/load' && String(options.method || 'GET').toUpperCase() === 'POST') {
      let model = null;
      try { model = JSON.parse(options.body || '{}').model; } catch {}
      const refusal = typeof model === 'string' ? await overBudget(model) : null;
      if (refusal) return { ok: false, status: 409, body: refusal.body };
    }
    return rawRequest(path, options, timeout);
  }
  const post = (path, body, timeout = 120000, signal) => request(path, { method: 'POST', body: JSON.stringify(body), signal }, timeout);
  const unsupported = operation => Promise.resolve({ ok: false, status: 501, body: { error: `${operation} is not exposed by this llama.cpp adapter` } });
  const modelQuery = model => '?model=' + encodeURIComponent(model) + '&autoload=false';
  const rawModels = signal => request('/models', {signal});
  // Set once evidenceStore/importEvidence exist below; the tracker is created first because
  // presets/evidence require the request() helper this closure also builds.
  let onDownloadCompleted=null;
  const tracker=require('./llamacpp-downloads.cjs').createDownloadTracker({base,headers,file:downloadStatePath,fetchStream,onCompleted:model=>onDownloadCompleted?.(model)});
  const store=presetPath ? require('./llamacpp-presets.cjs').createPresetStore(presetPath,{writer:presetWriter,cacheRam:autoconfig.cacheRam||null}) : null;
  // Every commit (apply, calibration, auto-tune, restores) settles an uncertain Model Loader
  // write by reading models.ini back instead of assuming nothing changed (#339).
  const {commitReconciled}=require('./models-ini-writer.cjs');
  const presets=store ? {...store,commit:(candidate,options)=>commitReconciled(store,candidate,options)} : null;
  const maintenance=require('./inference-maintenance.cjs').createMaintenanceGate();
  // #1012: what the router last read, so a reload can keep loaded models (PRESET_RELOAD_IMPL=wasm).
  const reloadGuard=reloadGuardOption||require('./preset-reload.cjs').createReloadGuard({stateFile:reloadStatePath,log:m=>console.log(m)});
  // Every router preset reload noevia makes goes through here: re-read the file just before the
  // call, and afterwards record that text with the router's own view of it (or forget the
  // baseline when the outcome is unclear), so the next reload can be judged.
  // With the flag off this is just the router call, as before (#1040). `expectText`: the text a
  // reload that keeps loaded models was judged on; the file is re-read here and must still match.
  async function routerReload(timeout=120000,{expectText=null}={}) {
    const tracking=reloadGuard.mode()==='wasm';
    if(!tracking&&expectText===null)return request('/models?reload=1',{},timeout);
    let before=null;try{before=presets?.snapshot().text??null;}catch{}
    if(expectText!==null&&before!==expectText)return {ok:false,status:409,refused:'file_changed',body:{}};
    let result;
    try {result=await request('/models?reload=1',{},timeout);}
    catch(e){reloadGuard.forget();throw e;}
    if(!result.ok){reloadGuard.forget();return result;}
    try {
      const after=await rawModels();
      let textAfter=null;try{textAfter=presets?.snapshot().text??null;}catch{}
      if(after.ok&&Array.isArray(after.body?.data)&&before!==null)reloadGuard.record(before,after.body.data,textAfter);
      else reloadGuard.forget();
    } catch {reloadGuard.forget();}
    return result;
  }
  async function mutate(fn) {const leave=maintenance.enter();try{return await fn();}finally{leave();}}
  // Serialize only admission/eviction, never the inference that follows it.
  let admission = Promise.resolve();
  async function withAdmission(work, signal) {
    signal?.throwIfAborted();
    const previous = admission;
    let release;
    admission = new Promise(resolve => { release = resolve; });
    let onAbort, acquired = false;
    const cancelled = signal && new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      await (cancelled ? Promise.race([previous, cancelled]) : previous);
      acquired = true;
      signal?.throwIfAborted();
      return await work();
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      // An aborted waiter returns promptly, but its queue slot remains behind the previous
      // operation until that operation finishes; later admissions cannot overtake it.
      if (acquired) release(); else void previous.then(release);
    }
  }
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
  // Before a chat model is used, any other loaded model except those in `keep` is unloaded first.
  // The engine runs one model at a time (compose --models-max, #697); on a multi-slot engine the
  // small models in keepAlongside() may stay, but two chat models never share it.
  const admissionError = message => Object.assign(Error(message), { status: 409, publicMessage: message });
  async function makeRoomForUnlocked(model, keep, signal) {
    // #1068: a restored models.ini the router has not re-read yet is re-read before this model loads.
    await autotuner?.flushReload?.(model);
    // Refuse before evicting anything: an over-budget model must not cost the loaded one.
    const refusal = await overBudget(model);
    if (refusal) throw Object.assign(admissionError(refusal.body.error), { code: refusal.body.code });
    const listing = await rawModels(signal);
    if (!listing.ok || !Array.isArray(listing.body?.data)) throw admissionError('Could not check loaded models before switching. Try again.');
    const others = listing.body.data.filter((m) => m.id !== model && !keep.includes(m.id) && ['loaded', 'loading'].includes(m.status?.value));
    for (const m of others) {
      signal?.throwIfAborted();
      const result = await post('/models/unload', { model: m.id }, 60000, signal);
      if (!result.ok) throw admissionError('Another model could not be unloaded. Try again when it is idle.');
    }
    if (others.length) {
      // The router acknowledges /models/unload before the process has exited, so the listing can
      // still show the old model as loaded for a few seconds. Wait for it to actually leave
      // (bounded, with backoff) instead of failing the first switch and succeeding on retry.
      const timeoutMs = unloadWait.timeoutMs ?? 30000, sleep = unloadWait.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
      const deadline = Date.now() + timeoutMs;
      let delay = 100;
      for (;;) {
        const updated = await rawModels(signal);
        if (!updated.ok || !Array.isArray(updated.body?.data)) throw admissionError('Could not check loaded models after unloading. Try again.');
        if (!updated.body.data.some(m => m.id !== model && !keep.includes(m.id) && ['loaded', 'loading'].includes(m.status?.value))) break;
        if (Date.now() >= deadline) throw admissionError(`Another model was still unloading after ${Math.round(timeoutMs / 1000)} seconds. Try again when it is idle.`);
        signal?.throwIfAborted();
        await sleep(delay);
        delay = Math.min(delay * 2, 1000);
      }
    }
  }
  async function makeRoomFor(model, keep = keepAlongside(), signal) {
    return withAdmission(() => makeRoomForUnlocked(model, keep, signal), signal);
  }
  async function load(model, options = {}, signal) {
    if (Object.keys(options).length) return unsupported('Runtime option changes; configure a native model preset');
    const leave=maintenance.enter();
    try {
      return await withAdmission(async () => {
        signal?.throwIfAborted();
        try { await makeRoomForUnlocked(model, keepAlongside(), signal); }
        catch (error) {
          if (signal?.aborted) throw error;
          return {ok:false,status:error.status || 502,body:{error:error.publicMessage || 'Could not make room for the selected model.',...(error.code?{code:error.code}:{})}};
        }
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
      }, signal);
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
      // #697: a dry run of the same write, estimated before anything is committed.
      let section=null;
      try {const candidate=presets.prepare(body);section=require('./llamacpp-presets.cjs').parse(candidate.text).sections.get(body.model)?.options||null;} catch {}
      const refusal=section?await presetRefusal(body.model,section):null;
      if(refusal)return {ok:false,status:409,body:refusal};
      return applyUnlocked(body);
    });
  }
  // Caller must hold the maintenance gate (applyPreset or a calibration job).
  // writeOptions.backup:false is auto-tune's alone (#1003); request bodies cannot ask for it.
  async function applyUnlocked(body, writeOptions = {}) {
    const listing=await rawModels();
    if(!listing.ok) return listing;
    const models=listing.body?.data;
    if(!Array.isArray(models))throw Error('Invalid router model listing');
    if(!models.some(m=>m.id===body.model))return {ok:false,status:404,body:{error:'Choose an installed model'}};
    if(models.some(m=>!['unloaded'].includes(m.status?.value)))return {ok:false,status:409,body:{error:'Unload all router models and finish downloads before applying a profile. Other clients must remain stopped.'}};
    const candidate=presets.prepare(body);
    // #1003: auto-tune asks for one recovery copy per run (backup:false on its later writes).
    try {await presets.commit(candidate,writeOptions.backup===false?{backup:false}:undefined);}
    catch(e) {
      // A settled Model Loader outcome carries its own message; a 5xx would otherwise reach
      // the admin as "Internal error". Nothing was reloaded: the file is not ours to apply.
      if(e?.publicMessage&&e.status>=500)return {ok:false,status:e.status,body:{error:e.publicMessage,...(e.retryable?{retryable:true}:{})}};
      throw e;
    }
    try {
      const result=await routerReload(120000);
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
      try {await routerReload(120000);}catch {}
      return {ok:false,status:503,body:{error:'Reload failed or timed out. Previous preset file restored; check router health before retrying.'}};
    }
  }
  // Re-read models.ini after an edit made outside noevia's own preset editor. With a model
  // loaded this refuses unless the caller asked to unload it: the router must not swap the
  // settings under a running instance. #1012 (PRESET_RELOAD_IMPL=wasm): it may reload with models
  // loaded when the router cannot change them (see preset-reload.cjs); they stay loaded.
  async function reloadPresets({unload=false}={}) {
    const {liveIds}=require('./preset-reload.cjs');
    const refuse=(ids,reason)=>({ok:false,status:409,body:{error:'A model is loaded. Unload it to apply the new settings.',loaded:ids,...(reason&&reason!=='off'?{reason}:{})}});
    return maintenance.exclusive(async()=>{
      const listing=await rawModels();
      if(!listing.ok)return listing;
      const rows=Array.isArray(listing.body?.data)?listing.body.data:[];
      // Sleeping models are running too: a reload unloads them if their preset changed (#1038).
      const loaded=liveIds(rows);
      let kept=[],expectText=null;
      if(loaded.length&&!unload){
        let judged=null;try{judged=presets?.snapshot().text??null;}catch{}
        const verdict=reloadGuard.verdict(judged,rows,loaded);
        if(!verdict.safe)return refuse(loaded,verdict.reason);
        // Right before the call: list again; a model that started loading meanwhile, or a moved
        // router, refuses (#1040). The file itself is re-read inside routerReload.
        const again=await rawModels();
        if(!again.ok||!Array.isArray(again.body?.data))return refuse(loaded,'unknown');
        const now=liveIds(again.body.data);
        if(now.some(id=>!loaded.includes(id)))return refuse(now,'loaded_changed');
        const recheck=reloadGuard.verdict(judged,again.body.data,now);
        if(!recheck.safe)return refuse(now,recheck.reason);
        kept=now;expectText=judged;
      }
      if(!kept.length)for(const id of loaded)await post('/models/unload',{model:id},60000).catch(()=>null);
      const result=await routerReload(120000,{expectText});
      if(result.refused)return refuse(kept,result.refused);
      if(!result.ok)return {ok:false,status:502,body:{error:'The engine did not reload its settings. Check the Hardware tab.'}};
      return {ok:true,status:200,body:{reloaded:true,unloaded:kept.length?[]:loaded,...(kept.length?{kept}:{})}};
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
  // #545: a preset-sourced router row whose GGUF is not on the read-only models mount. Unknown
  // (no mount configured, or a path outside /models/) never counts as missing.
  function presetFileMissing(row) {
    if (!autoconfig.modelsPath || row?.source !== 'preset') return false;
    const args = row.status?.args || [];
    const i = args.findIndex(a => a === '--model' || a === '-m');
    const file = (i >= 0 ? args[i + 1] : undefined) || (presets ? presets.files(row.id).model : undefined);
    return typeof file === 'string' && file.startsWith('/models/') && !localFile(file);
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
  // #697: the budget autoconfig sizes against: the inference budget (an admin setting), lowered
  // only by an explicit LLAMACPP_AUTOCONFIG_MEMORY_GIB. The engine container's memory limit
  // (autoconfig.budgetGib's fallback source) does not count GTT, so it applies only without one.
  function sizingBudgetGib() {
    const inference = Number(inferenceBudget?.budgetGib?.());
    const explicit = Number(autoconfig.explicitBudgetGib);
    if (inference > 0) return explicit > 0 ? Math.min(inference, explicit) : inference;
    return Number(autoconfig.budgetGib) > 0 ? Number(autoconfig.budgetGib) : 0;
  }
  const footprints = new Map();
  // What loading `model` with its current preset would use, or null when it cannot be told
  // (no read-only model mount, file not visible, unreadable metadata). Cached per preset revision.
  async function footprint(model) {
    if (!presets || !autoconfig.modelsPath) return null;
    let profile;
    try { profile = presets.get(model); } catch { return null; }
    const hit = footprints.get(model);
    if (hit && hit.revision === profile.revision && Date.now() - hit.at < 60000) return hit.value;
    const read = await readModel(model).catch(() => ({ error: 'unreadable' }));
    const value = read.error ? null : require('./llamacpp-autoconfig.cjs').estimateFootprint({ meta: read.meta, modelBytes: read.modelFile.size,
      mmprojBytes: read.mmproj?.size || 0, options: { ...profile.defaults, ...profile.options }, model });
    footprints.set(model, { revision: profile.revision, at: Date.now(), value });
    if (footprints.size > 64) footprints.delete(footprints.keys().next().value);
    return value;
  }
  // #697: models the runtime watchdog unloaded, with the preset revision and budget they were
  // running under. They stay refused until one of the three changes (a different model is
  // simply a different key), so the next chat cannot reload the same overload straight away.
  const quarantined = new Map();
  function quarantine(model, budgetGib) {
    let revision = null;
    try { revision = presets ? presets.get(model).revision : null; } catch {}
    quarantined.set(model, { revision, budgetGib: Number(budgetGib), at: Date.now() });
    if (quarantined.size > 64) quarantined.delete(quarantined.keys().next().value);
  }
  function quarantineRefusal(model, budgetGib) {
    const q = quarantined.get(model);
    if (!q) return null;
    let revision = null;
    try { revision = presets ? presets.get(model).revision : null; } catch {}
    if (q.revision !== revision || q.budgetGib !== budgetGib) { quarantined.delete(model); return null; }
    const error = `${model} was unloaded by the memory safety net because measured inference memory ran more than the allowed margin over the ${budgetGib} GiB budget. It stays unloaded until its settings or the budget change: lower its context or prompt cache, or raise the budget, in Settings → Models & routing.`;
    return { body: { error, code: 'inference_budget_unloaded', budgetGib, unloadedAt: new Date(q.at).toISOString() } };
  }
  // The refusal for a load whose estimate is above the budget, or null (fits, no budget, or no
  // estimate: the runtime watchdog still covers what cannot be estimated).
  async function overBudget(model) {
    const budgetGib = Number(inferenceBudget?.budgetGib?.());
    if (!(budgetGib > 0)) return null;
    const held = quarantineRefusal(model, budgetGib);
    if (held) return held;
    const est = await footprint(model).catch(() => null);
    if (!est) return null;
    if (est.cacheRamUnbounded) {
      const error = `${model} has an unbounded prompt cache (cache-ram = -1), so it cannot be loaded within the ${budgetGib} GiB inference memory budget. Set its prompt cache in Settings → Models & routing.`;
      return { body: { error, code: 'inference_budget', budgetGib, estimate: est } };
    }
    if (est.totalGib <= budgetGib) return null;
    const error = `${model} needs about ${est.totalGib} GiB to load (weights ${est.modelGib}, context ${est.kvGib} at ${est.ctx.toLocaleString('en-US')} tokens, prompt cache ${est.cacheRamGib}, runtime ${est.extraGib}), above the ${budgetGib} GiB inference memory budget. Lower its context or prompt cache, use a smaller quantization, or raise the budget in Settings → Models & routing.`;
    return { body: { error, code: 'inference_budget', budgetGib, estimate: est } };
  }
  // #697: refuse to SAVE settings whose estimate is above the budget. Clients outside web (Diary,
  // Nextcloud Assistant) load presets straight from the router, so a preset that cannot fit must
  // not be written at all. `options` are the section's own options after the save; the global
  // section and the explicit prompt cache every write adds are applied here as the write would.
  async function presetRefusal(model, options) {
    const budgetGib = Number(inferenceBudget?.budgetGib?.());
    if (!(budgetGib > 0) || !presets || !autoconfig.modelsPath) return null;
    const read = await readModel(model).catch(() => ({ error: 'unreadable' }));
    if (read.error) return null;
    let defaults = {};
    try { defaults = presets.get(model).defaults || {}; } catch {}
    const opts = { ...defaults, ...options };
    if (opts['cache-ram'] === undefined || opts['cache-ram'] === '') opts['cache-ram'] = require('./llamacpp-autoconfig.cjs').isPromptCacheFree(model, opts) ? '0' : String((autoconfig.cacheRam || require('./inference-budget.cjs').cacheRamLimits()).capMib);
    const est = require('./llamacpp-autoconfig.cjs').estimateFootprint({ meta: read.meta, modelBytes: read.modelFile.size, mmprojBytes: read.mmproj?.size || 0, options: opts, model });
    if (!est.cacheRamUnbounded && est.totalGib <= budgetGib) return null;
    const error = est.cacheRamUnbounded
      ? `Not saved: an unbounded prompt cache (cache-ram = -1) cannot fit the ${budgetGib} GiB inference memory budget.`
      : `Not saved: with these settings ${model} needs about ${est.totalGib} GiB (weights ${est.modelGib}, context ${est.kvGib} at ${est.ctx.toLocaleString('en-US')} tokens, prompt cache ${est.cacheRamGib}, runtime ${est.extraGib}), above the ${budgetGib} GiB inference memory budget. Lower the context or prompt cache, or raise the budget.`;
    return { error, code: 'inference_budget', budgetGib, estimate: est };
  }
  // The Models page's per-model estimate against the budget. Read-only; loads nothing.
  async function inferenceEstimates() {
    const listing = await rawModels();
    if (!listing.ok) return listing;
    if (!Array.isArray(listing.body?.data)) throw Error('Invalid llama.cpp model listing');
    const budgetGib = Number(inferenceBudget?.budgetGib?.()) || null;
    const { isSystemModel, modelPathFromArgs } = require('./model-system.cjs');
    const rows = [];
    for (const m of listing.body.data) {
      const est = await footprint(m.id).catch(() => null);
      rows.push({ model: m.id, loaded: m.status?.value === 'loaded', labels: nativeLabels(m),
        system: isSystemModel(m.id, modelPathFromArgs(m.status?.args)), estimate: est,
        fits: est && budgetGib ? !est.cacheRamUnbounded && est.totalGib <= budgetGib : null });
    }
    return { ok: true, status: 200, body: { budgetGib, models: rows } };
  }
  // Size-based preset suggestion. Never writes; the admin applies it through applyPreset.
  async function suggestPreset(model) {
    if(!presets)return unsupported('Native preset suggestions; configure LLAMACPP_PRESET_PATH');
    const {modelsPath,cacheRamMaxMib}=autoconfig;const budgetGib=sizingBudgetGib();
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
    const budgetGib=sizingBudgetGib();
    return {ok:true,status:200,body:{model,budgetGib:budgetGib>0?budgetGib:null,...inputs}};
  }
  // Starting settings for calibration: structural values from the model file; the context
  // itself is measured, so an unconfigured memory budget is not an obstacle here.
  async function conservativeFor(model) {
    const read=await readModel(model);
    if(read.error)return null;
    const profile=presets.get(model);
    const result=require('./llamacpp-autoconfig.cjs').suggest({meta:read.meta,modelBytes:read.modelFile.size,mmprojBytes:read.mmproj?.size||0,budgetGib:sizingBudgetGib()||1e6,current:{...profile.defaults,...profile.options},cacheRamMaxMib:autoconfig.cacheRamMaxMib});
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
    const artifactHash=live?.identity?.artifact?importLib.artifactIdentityHash(live.identity.artifact):null;
    const external=importLib.deriveExternal(records,{model,artifactHash});
    const sampling=importLib.deriveSampling(records,{model,artifactHash});
    const recommendation=resolveSampling(model,sampling);
    return {ok:true,status:200,body:{model,tracked:!!evidenceStore,identityHash:live?.identityHash||null,
      categories:evidenceLib.CATEGORIES.map(category=>{const d=evidenceLib.derive(records,{model,category,liveHash:live?.identityHash||null});
        return {category,state:d.state,value:d.record?.value??null,result:d.record?.result??null,at:d.record?.at??null,suite:d.record?.suite??null,limitations:d.record?.limitations||[],limitationKeys:require('./evidence-limitations.cjs').limitationKeys(d.record?.limitations)};}),
      external:{category:'external_model_card',state:external.state,value:external.record?.value??null,at:external.record?.at??null,suite:external.record?.suite??null,
        provenance:external.record?.provenance??null,limitations:external.record?.limitations||[],limitationKeys:require('./evidence-limitations.cjs').limitationKeys(external.record?.limitations)},
      samplingRecommendation:{state:sampling.state,values:sampling.state==='reported'?sampling.record?.value??null:null,
        source:sampling.record?'generation_config.json':null,provenance:sampling.record?.provenance??null,
        limitations:sampling.record?.limitations||[]},
      // What auto-tune would apply, with its source tier (#308). Separate from the raw source
      // claim above so that claim's shape stays as #508 published it.
      samplingPlan:{tier:recommendation.tier,source:recommendation.source,sourceId:recommendation.sourceId,values:recommendation.values,family:recommendation.familyId,
        familyLabel:recommendation.familyLabel,presetId:recommendation.presetId??null,
        quirks:recommendation.quirks,note:recommendation.note,noteId:recommendation.noteId,provenance:recommendation.provenance}}};
  }
  // The recommendation the tuner applies and the pre-flight shows (#308). Only a current source
  // claim counts as tier 1; a stale or unverified one falls through to the family table.
  function resolveSampling(model,sampling){
    const current=sampling?.state==='reported'?sampling.record:null;
    return require('./sampling-recommendation.cjs').resolveSamplingRecommendation({model,sourceValues:current?.value??null,sourceProvenance:current?.provenance??null});
  }
  async function samplingFor(model){
    let sampling=null;
    if(evidenceStore){
      try{
        const importLib=require('./model-evidence-import.cjs'),live=await computeIdentity(model);
        const artifactHash=live?.identity?.artifact?importLib.artifactIdentityHash(live.identity.artifact):null;
        sampling=importLib.deriveSampling(evidenceStore.list(),{model,artifactHash});
      }catch{sampling=null;}
    }
    return resolveSampling(model,sampling);
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
  const tuneDeps={identityFor:tuneIdentity,stateFile:autotuneStatePath,memoryFloorGib:autoconfig.memoryFloorGib||2,...(calibrationOptions.readMemory?{readMemory:calibrationOptions.readMemory}:{}),...autotuneOptions};
  // Internal context checks run under the full tuner's per-model lease; standalone
  // calibration still acquires the real gate.
  const managedGate={hold:()=>()=>{}};
  const autotuner=presets&&autotuneStatePath?require('./llamacpp-full-autotune.cjs').createFullAutotuner({fileMissing:presetFileMissing,request,rawModels,presets,maintenance,applyUnlocked,identityFor:tuneDeps.identityFor,stateFile:autotuneStatePath,
      samplingFor,
      readMemory:tuneDeps.readMemory,memoryFloorGib:tuneDeps.memoryFloorGib,
      ...(autotuneOptions.betweenModelsMs!=null?{betweenModelsMs:autotuneOptions.betweenModelsMs}:{}),
      ...(autotuneOptions.idleTimeoutMs!=null?{idleTimeoutMs:autotuneOptions.idleTimeoutMs}:{}),
      // #1062: tests shorten the foreign-client wait and inject the decision.
      ...Object.fromEntries(['foreignWaitMs','foreignQuietMs','foreignPollMs','contention'].filter(k=>autotuneOptions[k]!=null).map(k=>[k,autotuneOptions[k]])),
      ...(autotuneOptions.sleep?{sleep:autotuneOptions.sleep}:{}),
      ...(autotuneOptions.servingChecks?{servingChecks:autotuneOptions.servingChecks}:{}),
      // #1003 AUTOTUNE_PLAN_IMPL=wasm: the planner reads the GGUF facts and the sizing budget.
      ...(autotuneOptions.planner?{planner:autotuneOptions.planner}:{}),
      planFacts:async model=>{const r=await readModel(model);return r.error?null:{meta:r.meta,modelBytes:r.modelFile.size,mmprojBytes:r.mmproj?.size||0};},
      budgetGib:()=>sizingBudgetGib()||require('./inference-budget.cjs').DEFAULT_BUDGET_GIB,
      ...(autotuneOptions.planFacts?{planFacts:autotuneOptions.planFacts}:{}),
      ...(autotuneOptions.budgetGib?{budgetGib:autotuneOptions.budgetGib}:{}),
      // #1004 LAYA_LOAD_ADVISOR: tests inject their own advisor (a fake decision service).
      ...(autotuneOptions.loadAdvisor?{loadAdvisor:autotuneOptions.loadAdvisor}:{}),
      onResult:async({model,result})=>{for(const [category,value] of [['context_capacity',{ctx:result.context,appliedCtx:result.context,slots:Number(presets.get(model).options.parallel)||1}],['throughput',{rate:result.generation}],...(result.acceptance==null?[]:[['mtp_acceptance',{rate:result.acceptance/100}]])])await recordEvidence(model,{category,result:'passed',value,suite:{name:'full-autotune',version:3},source:'autotune',limitations:['Three deterministic quality smoke probes, not a general quality benchmark','120 s default prompt budget; existing MTP head only',...(result.baseline?.skipped?.length?[`Probes not used (failed at the model's reference settings): ${result.baseline.skipped.map(s=>s.id).join(', ')}`]:[])]});},
      contextFactory:hooks=>require('./llamacpp-calibration.cjs').createCalibrator({request,rawModels,presets,applyUnlocked,conservativeFor,maintenance:managedGate,
        stream:(path,opts={})=>(fetchStream||fetch)(base+path,{...opts,headers:headers(opts.headers),redirect:'error'}),
        memoryFloorGib:autoconfig.memoryFloorGib||2,...calibrationOptions,stateFile:undefined,...hooks})}):null;
  return {
    kind: 'llamacpp', enabled: true, baseUrl: base, headers, request,
    capabilities: { routing: true, load: true, unload: true, download: true, deleteCached: true, runtimeOptions: false, hardware: false, presets: !!presets, autotune: !!autotuner },
    requireEnabled() {},
    listModels, health, load, downloads, makeRoomFor,
    // The admission lock itself, for callers that must check residency and send as one step (#702).
    withAdmission,
    close:tracker.close,
    enterInference: maintenance.enter,
    // #872: read-only views for writers outside this process's gate (the model folder sync):
    // the gate itself, or any calibration/auto-tune job still running (auto-tune releases the
    // gate between models but still restores settings by revision).
    maintenanceHeld: () => maintenance.held(),
    // #873: the throughput sweep runs outside this process; the proxy holds the gate while it runs.
    // Throws a 409 when requests are in flight or the gate is already held.
    holdMaintenance: reason => maintenance.hold(reason),
    tuningActive: () => maintenance.held() || calibrator?.status().body.job?.status === 'running' || autotuner?.status().body.job?.status === 'running',
    getPreset: model => presets ? Promise.resolve({ok:true,status:200,body:presets.get(model)}) : unsupported('Native preset editing'),
    applyPreset,
    suggestPreset,
    estimateMemory,
    inferenceEstimates,
    // #697: the load guard and the budget, for the proxied benchmark start and the watchdog.
    loadRefusal: model => overBudget(model).then(r => r ? r.body : null),
    presetRefusal: (model, options) => presetRefusal(model, require('./llamacpp-presets.cjs').canonicalOptions(options)),
    quarantine,
    sizingBudgetGib,
    reloadPresets,
    evidence, recordEvidence, importEvidence,
    calibration: calibrator ? { start: calibrator.start, cancel: calibrator.cancel, status: calibrator.status, recover: calibrator.recover } : null,
    autotune: autotuner ? { start: autotuner.start, resume: autotuner.resume, cancel: autotuner.cancel, status: autotuner.status, setSettings: autotuner.setSettings, recover: autotuner.recover, untuned: autotuner.untuned } : null,
    unload: model => mutate(()=>withAdmission(()=>post('/models/unload', { model }))),
    // #697 watchdog: unload without waiting behind admission or maintenance; memory is running out.
    emergencyUnload: model => post('/models/unload', { model }, 60000),
    pull: ({ checkpoint }) => mutate(async () => {
      if (!/^[\w.-]+\/[\w.-]+(?::[\w.-]+)?$/.test(checkpoint || '')) return { ok: false, status: 400, body: { error: 'Choose a Hugging Face repository and quantization' } };
      tracker.requested(checkpoint);
      const response = await post('/models', { model: checkpoint });
      if(!response.ok)tracker.rejected(checkpoint);
      return response.ok ? { ...response, body: { ...response.body, id: checkpoint, modelName: checkpoint } } : response;
    }),
    deleteModel: model => mutate(()=>withAdmission(async () => { const r = await request('/models?model=' + encodeURIComponent(model), { method: 'DELETE' }, 60000); if (r.ok) identityCache.delete(model); return r; })),
    // Hold web admission across unload and delete. The router can still receive a load from
    // another client outside this process, so retry once if deletion is refused.
    removeModel: model => mutate(()=>withAdmission(async () => {
      let unloaded = !!(await post('/models/unload', { model }).catch(() => null))?.ok;
      let del = await request('/models?model=' + encodeURIComponent(model), { method: 'DELETE' }, 60000);
      if (!del.ok) {
        if ((await post('/models/unload', { model }).catch(() => null))?.ok) unloaded = true;
        del = await request('/models?model=' + encodeURIComponent(model), { method: 'DELETE' }, 60000);
      }
      if (del.ok) identityCache.delete(model);
      return { ...del, unloaded };
    })),
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
module.exports = { createLlamaCppManager, keepAlongside };
