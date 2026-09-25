'use strict';
// The model routes (models.cjs holds what they compute):
//   /api/stats                  engine and system statistics
//   /api/auto-roles             the Fast/Smart/Vision/Code role→model config
//   /api/model-manager/*        proxy to the model management service, administrators only,
//                               with the folder scan served from the last result
//   /api/models/*               presets, evidence, autotune, calibration, hardware, the
//                               installed list, pull/delete/load/unload, downloads
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.
// Every write under /api/models/ is administrator-only (the gate at the top), and any
// write there also drops the cached folder scan. Blocks keep their original order; an
// unmatched method falls through as it did inline. /api/auto-roles is not under
// /api/models/, so its own PUT handler carries the narrower member-vs-admin split: any
// member may save their workspace's roles, but only an admin's save also warms models
// up on the shared engine (ensureRolesLoaded).

const PASS = Symbol('unhandled');
const { isSystemModel, modelPathFromArgs, SYSTEM_MODEL_DELETE_REASON } = require('../model-system.cjs');

// A client sees e.message only when it was written for people (publicMessage, or a 4xx status).
// Everything else is logged here and replaced by a fixed sentence.
function clientMessage(e, fallback) {
  if (e?.publicMessage) return String(e.publicMessage);
  if (Number.isInteger(e?.status) && e.status < 500 && e.message) return e.message;
  console.error('[models]', e?.stack || e);
  return fallback;
}

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req, limit?:number) => Promise<string>} deps.readBody
 * @param {(req) => Promise<any>} deps.readJson
 * @param {(url:string, init:object, timeoutMs?:number) => Promise<{ok:boolean,status:number,body:any}>} deps.fetchJson
 * @param {object} deps.env                       process.env, read at call time
 * @param {object} deps.modelManager
 * @param {(id:string) => object|null} deps.getProvider
 * @param {(provider:object, extra?:object) => object} deps.providerHeaders
 * @param {string} deps.DEFAULT_PROVIDER_ID
 * @param {() => Function} deps.createVisionProbe
 * @param {(stats:object) => number|null} deps.reportedTokenRate
 * @param {(roles:object|null, catalogue:object[]|null) => any} deps.missingRoles
 * @param {() => object} deps.currentWorkspace
 * @param {object} deps.service   models.cjs
 */
function createModelRoutes({ json, readBody, readJson, fetchJson, env, modelManager, getProvider, providerHeaders, DEFAULT_PROVIDER_ID, createVisionProbe, reportedTokenRate, missingRoles, currentWorkspace, service }) {
  const { modelScanCache, refreshModelScan, autoRoles, setAutoRoles, ensureRolesLoaded, servedCatalogue, modelsInstalled, deriveUserModelName, lastLoadedModel, clearLastLoadedModel, clearRoleReferences } = service;

  async function handle(req, res, { path: p, authn, url }) {
    if (p.startsWith('/api/models/') && !['GET', 'HEAD'].includes(req.method || 'GET') && authn.user.role !== 'admin') {
      return json(res, 403, { error: 'administrator required' });
    }

    // ── Optional model-manager statistics.
    if (p === '/api/stats') {
      const [gen, sys, mtpHealth, mtpMetrics, mtpModels] = await Promise.allSettled([
        modelManager.enabled ? modelManager.stats() : Promise.resolve({ ok: false }),
        modelManager.enabled ? modelManager.systemStats() : Promise.resolve({ ok: false }),
        modelManager.enabled ? modelManager.health() : Promise.resolve({ok:false}),
        modelManager.enabled ? modelManager.metrics() : Promise.resolve({ok:false}),
        modelManager.enabled ? modelManager.listModels() : Promise.resolve({ok:false}),
      ]);
      const g = gen.status === 'fulfilled' && gen.value.ok ? gen.value.body : {};
      const s = sys.status === 'fulfilled' && sys.value.ok ? sys.value.body : {};
      return json(res, 200, {
        up: gen.status === 'fulfilled' && gen.value.ok,
        telemetryScope: g.scope || null,
        mtp: modelManager.kind === 'llamacpp' ? (g.mtp || []) : require('../mtp.cjs').acceptance(mtpMetrics.status === 'fulfilled' && mtpMetrics.value.ok ? mtpMetrics.value.body : '', mtpHealth.status === 'fulfilled' && mtpHealth.value.ok ? mtpHealth.value.body.all_models_loaded : [], mtpModels.status === 'fulfilled' && mtpModels.value.ok ? mtpModels.value.body.data : [], currentWorkspace().userId),
        tokensPerSecond: reportedTokenRate(g),
        timeToFirstToken: typeof g.time_to_first_token === 'number' ? g.time_to_first_token : null,
        inputTokens: typeof g.input_tokens === 'number' ? g.input_tokens : null,
        outputTokens: typeof g.output_tokens === 'number' ? g.output_tokens : null,
        inputTokensTotal: typeof g.input_tokens_total === 'number' ? g.input_tokens_total : null,
        outputTokensTotal: typeof g.output_tokens_total === 'number' ? g.output_tokens_total : null,
        requestCount: typeof g.request_count_total === 'number' ? g.request_count_total : null,
        cpuPercent: typeof s.cpu_percent === 'number' ? s.cpu_percent : null,
        gpuPercent: typeof s.gpu_percent === 'number' ? s.gpu_percent : null,
        vramGb: typeof s.vram_gb === 'number' ? s.vram_gb : null,
        memoryGb: typeof s.memory_gb === 'number' ? s.memory_gb : null,
      });
    }

    // The default mode new projects start in, and (on request) a one-off switch of every existing
    // project of this user to it. Per workspace, so tenants never touch each other's projects.
    if (p === '/api/routing-default') {
      const ws = currentWorkspace();
      if (req.method === 'GET') return json(res, 200, { routing: ws.preferences?.defaultRouting === 'manual' ? 'manual' : 'auto' });
      if (req.method === 'PUT') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid JSON' }); }
        if (body?.routing !== 'auto' && body?.routing !== 'manual') return json(res, 400, { error: "routing must be 'auto' or 'manual'" });
        ws.preferences = { ...(ws.preferences || {}), defaultRouting: body.routing };
        ws.savePreferences();
        let updated = 0;
        if (body.applyToExisting === true) {
          for (const project of ws.projects) if (project.routing !== body.routing) { project.routing = body.routing; project.updatedAt = Date.now(); updated++; }
          if (updated) ws.saveProjects();
        }
        return json(res, 200, { routing: body.routing, updated });
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    if (p === '/api/auto-roles') {
      if (req.method === 'GET') {
        const roles = autoRoles();
        return json(res, 200, { configured: !!roles, roles: roles || null, missing: missingRoles(roles, await servedCatalogue()) });
      }
      if (req.method === 'PUT') {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: 'invalid JSON' });
        }
        const fast = typeof body.fast === 'string' ? body.fast.trim() : '';
        const smart = typeof body.smart === 'string' ? body.smart.trim() : '';
        const vision = typeof body.vision === 'string' ? body.vision.trim() : '';
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        if (!fast || !smart) return json(res, 400, { error: 'both fast and smart model names are required' });
        // Names must resolve to installed models, or a bad id would keep producing repeated
        // load-warning log lines forever (ensureRolesLoaded retries every save/warm-up). Skip
        // the check only when the catalogue itself cannot be read (engine unreachable): saving
        // is still allowed, since the alternative is a member/admin locked out of the page.
        const catalogue = await servedCatalogue();
        if (Array.isArray(catalogue)) {
          const known = new Set(catalogue.map((m) => m.name));
          const named = { fast, smart, ...(vision ? { vision } : {}), ...(code ? { code } : {}) };
          const bad = Object.entries(named).filter(([, name]) => !known.has(name)).map(([, name]) => name);
          if (bad.length) return json(res, 400, { error: `unknown model(s): ${bad.join(', ')}` });
        }
        setAutoRoles({ fast, smart, vision, code });
        // Loading models for the shared engine is an administrative action: a member's save is
        // stored per workspace like anyone else's, but only an admin's save may warm models up
        // (native routing stays on demand either way; see ensureRolesLoaded above it).
        if (authn.user.role === 'admin') ensureRolesLoaded();
        return json(res, 200, { configured: true, roles: autoRoles() });
      }
    }

    // A change to the models anywhere else (load, unload, download, delete) also invalidates the scan.
    if (p.startsWith('/api/models/') && !['GET','HEAD','OPTIONS'].includes(req.method || 'GET')) modelScanCache.clear();
    // Model manager (folded-in Model Loader) JSON API, administrators only.
    if (p.startsWith('/api/model-manager/')) {
      if(authn.user.role!=='admin')return json(res,403,{error:'Administrator required for model management'});
      if(!env.MODEL_LOADER_URL)return json(res,404,{error:'Model management service is not configured'});
      const rest=p.slice('/api/model-manager/'.length);
      if(!/^[\w./%:+@-]*$/.test(rest)||rest.includes('..'))return json(res,400,{error:'Invalid path'});
      const method=req.method||'GET';
      const body=['GET','HEAD','DELETE'].includes(method)?undefined:await readBody(req,1024*1024);
      // The file scan reads every model header from disk (~2 s on daserver). Serve the last scan at
      // once and refresh it behind the response; any change through this API drops it.
      // The prompt suite is chat generation: refuse embedding, reranking and routing models here too,
      // so the picker is not the only gate (#206). An unreadable catalogue falls back to names.
      if(method==='POST'&&rest==='benchmark/start'){
        let payload; try{payload=JSON.parse(body||'{}');}catch{payload={};}
        const bad=require('../chat-model-kind.cjs').nonChatAliases(Array.isArray(payload.aliases)?payload.aliases:[],await servedCatalogue());
        if(bad.length)return json(res,400,{error:`The prompt suite needs chat models; ${bad.join(', ')} ${bad.length===1?'is':'are'} an embedding, reranking or routing model.`});
      }
      // Set only for POST models/delete, and read again once the forwarded delete has
      // succeeded (below): the folder-scan proxy deletes files directly through the model
      // management service, bypassing modelManager entirely — the only way to unload a model
      // deleted this way, and to clear the roles/last-loaded default that named it, is to
      // resolve the deleted keys back to the engine model id(s) (a scanned entry's modelId and
      // every models.ini section it backed) using the SAME scan this guard already reads.
      let deleteKeys=null, deleteScanned=null;
      if(method==='POST'&&rest==='models/delete'){
        let payload; try{payload=JSON.parse(body||'{}');}catch{payload={};}
        const keys=Array.isArray(payload.models)?payload.models:[];
        let scanned=modelScanCache.get('models')?.body?.models;
        // An empty cache (cold start, or any write just cleared it) must not skip the guard: scan first.
        if(keys.length&&!Array.isArray(scanned)){
          const fresh=await fetchJson(`${env.MODEL_LOADER_URL.replace(/\/+$/,'')}/api/v1/models`,{method:'GET',headers:{'Content-Type':'application/json',...(env.MODEL_LOADER_TOKEN?{'X-Model-Loader-Token':env.MODEL_LOADER_TOKEN}:{})}},60*1000).catch(()=>null);
          scanned=fresh?.ok&&fresh.body&&typeof fresh.body==='object'?fresh.body.models:undefined;
          if(!Array.isArray(scanned))return json(res,409,{error:'Could not confirm these files are not system models. Refresh the model list and try again.'});
          modelScanCache.set('models',{at:Date.now(),body:fresh.body});
        }
        if(keys.length){
          const blocked=keys.some(key=>{const entry=scanned.find(f=>f.key===key);return entry&&(isSystemModel(entry.modelId)||(entry.sections||[]).some(s=>isSystemModel(s)));});
          if(blocked)return json(res,400,{error:SYSTEM_MODEL_DELETE_REASON});
        }
        deleteKeys=keys; deleteScanned=scanned;
      }
      // sections/<name> (and its /rename variant) can delete or rename a models.ini section directly;
      // block that for Laya's section the same way models/delete is blocked above.
      const sectionMatch = /^sections\/([^/]+)(?:\/rename)?$/.exec(rest);
      if (sectionMatch && ['DELETE','POST','PUT'].includes(method)) {
        const name = decodeURIComponent(sectionMatch[1]);
        const scanned = modelScanCache.get('models')?.body?.models;
        const cachedEntry = Array.isArray(scanned) ? scanned.find(f => (f.sections||[]).includes(name)) : null;
        if (isSystemModel(name) || (cachedEntry && isSystemModel(cachedEntry.modelId))) {
          return json(res,400,{error:SYSTEM_MODEL_DELETE_REASON});
        }
      }
      if(method!=='GET')modelScanCache.clear();
      if(method==='GET'&&rest==='models'&&!url.search){
        const hit=modelScanCache.get('models');
        if(hit){res.setHeader('Cache-Control','no-store');res.setHeader('X-Model-Scan','cached');if(Date.now()-hit.at>5000)refreshModelScan();return json(res,200,hit.body);}
      }
      const result=await fetchJson(`${env.MODEL_LOADER_URL.replace(/\/+$/,'')}/api/v1/${rest}${url.search}`,{method,headers:{'Content-Type':'application/json',...(env.MODEL_LOADER_TOKEN?{'X-Model-Loader-Token':env.MODEL_LOADER_TOKEN}:{})},body},10*60*1000).catch(()=>null);
      res.setHeader('Cache-Control','no-store');
      if(!result)return json(res,502,{error:'The model management service is not responding.'});
      const detail=result.body&&typeof result.body==='object'?result.body:{error:String(result.body||'')};
      // A finished benchmark run viewed in the manager becomes throughput evidence (best-effort, throttled).
      if(result.ok&&method==='GET'&&/^benchmark\/runs\/\d+$/.test(rest)&&modelManager.recordEvidence){
        for(const {model,record} of require('../benchmark-evidence.cjs').throughputRecords(detail))modelManager.recordEvidence(model,record).catch(()=>undefined);
      }
      if(result.ok&&method==='GET'&&rest==='models'&&!url.search)modelScanCache.set('models',{at:Date.now(),body:detail});
      // #302: the folder-scan delete above only removed files through the model management
      // service — it never touched the live engine or the auto-router roles. Run the same
      // cleanup /api/models/delete runs, for every engine id the deleted files backed.
      if(result.ok&&deleteKeys&&deleteKeys.length){
        const ids=new Set();
        for(const key of deleteKeys){
          const entry=Array.isArray(deleteScanned)?deleteScanned.find(f=>f.key===key):null;
          if(!entry)continue;
          if(entry.modelId)ids.add(entry.modelId);
          for(const section of entry.sections||[])ids.add(section);
        }
        let unloaded=false; const rolesCleared=new Set();
        for(const id of ids){
          if(typeof modelManager.unload==='function'){
            const u=await modelManager.unload(id).catch(()=>null);
            if(u?.ok)unloaded=true;
          }
          for(const role of clearRoleReferences(id))rolesCleared.add(role);
          if(lastLoadedModel()===id)clearLastLoadedModel(id);
          if(typeof modelManager.forgetIdentity==='function')modelManager.forgetIdentity(id);
        }
        modelScanCache.clear();
        return json(res,result.status,{...detail,unloaded,rolesCleared:[...rolesCleared]});
      }
      return json(res,result.status,result.ok?detail:{error:detail.detail||detail.error||'Model management request failed.'});
    }

    if (p === '/api/models/presets/reload') {
      if(authn.user.role!=='admin')return json(res,403,{error:'Administrator required for shared model profiles'});
      if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
      if(!modelManager.reloadPresets)return json(res,404,{error:'This engine does not use a preset file'});
      try { const result=await modelManager.reloadPresets({unload:(await readJson(req))?.unload===true}); return json(res,result.status,result.body); }
      catch(e){ return json(res,e.status||500,{error:e.status===409?'Requests are in progress. Try again when chats finish.':clientMessage(e,'Could not reload model profiles.')}); }
    }

    if (p === '/api/models/evidence' && req.method === 'GET') {
      if (!modelManager.evidence) return json(res, 404, { error: 'Qualification evidence needs the native engine' });
      const model = url.searchParams.get('model') || '';
      if (!model || model.length > 200) return json(res, 400, { error: 'Choose a model' });
      const result = await modelManager.evidence(model);
      res.setHeader('Cache-Control', 'no-store');
      return json(res, result.status, result.body);
    }

    // Re-run the cheap image probe for one model and record the result. It may load the model.
    if (p === '/api/models/evidence/recheck') {
      if(authn.user.role!=='admin')return json(res,403,{error:'Administrator required for shared model evidence'});
      if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
      if(!modelManager.recordEvidence)return json(res,404,{error:'Qualification evidence needs the native engine'});
      const body=await readJson(req).catch(()=>null);
      const model=typeof body?.model==='string'?body.model:'';
      if(!model||model.length>200)return json(res,400,{error:'Choose a model'});
      if(body.category!=='vision')return json(res,400,{error:'Only image input can be rechecked here; use Measure context for context capacity.'});
      const provider=getProvider(DEFAULT_PROVIDER_ID);
      const vision=await createVisionProbe()(provider.baseUrl,providerHeaders(provider),model);
      if(!vision.supported&&!/projector|mmproj/i.test(vision.reason||''))return json(res,503,{error:vision.reason||'The engine could not run the image probe.'});
      await modelManager.recordEvidence(model,{category:'vision',result:vision.supported?'passed':'failed',value:null,suite:{name:'vision-probe',version:1},source:'recheck',limitations:vision.supported?['1×1 image accepted; not an accuracy test']:[String(vision.reason||'').slice(0,200)]});
      return json(res,200,(await modelManager.evidence(model)).body);
    }

    // Explicit "fetch evidence" action (#266): re-import attributable model-card evidence
    // for one model from its source. Offline/failed lookups never surface as an error here —
    // they return the same shape as "nothing to show" — since this must never look like the
    // model itself is broken.
    if (p === '/api/models/evidence/import') {
      if(authn.user.role!=='admin')return json(res,403,{error:'Administrator required for shared model evidence'});
      if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
      if(!modelManager.importEvidence)return json(res,404,{error:'Model evidence import needs the native engine'});
      const body=await readJson(req).catch(()=>null);
      const model=typeof body?.model==='string'?body.model:'';
      if(!model||model.length>200)return json(res,400,{error:'Choose a model'});
      const checkpoint=typeof body?.checkpoint==='string'?body.checkpoint:undefined;
      await modelManager.importEvidence(model,{checkpoint}).catch(()=>null);
      return json(res,200,(await modelManager.evidence(model)).body);
    }

    if (p === '/api/models/autotune' || p === '/api/models/autotune/cancel' || p === '/api/models/autotune/resume' || p === '/api/models/autotune/untuned') {
      if(authn.user.role!=='admin')return json(res,403,{error:'Administrator required for shared model profiles'});
      if(!modelManager.autotune)return json(res,404,{error:'Auto-tune is unavailable'});
      let result;
      if(p.endsWith('/cancel')){if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});result=modelManager.autotune.cancel();}
      else if(p.endsWith('/resume')){if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});if(!modelManager.autotune.resume)return json(res,404,{error:'Resume is unavailable'});const body=await readJson(req);result=await modelManager.autotune.resume({confirmPause:body?.confirmPause});}
      else if(p.endsWith('/untuned')){if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});result=await modelManager.autotune.untuned();}
      else if(req.method==='GET')result=modelManager.autotune.status(url.searchParams.get('model')||'');
      else if(req.method==='POST'){const body=await readJson(req);result=await modelManager.autotune.start(String(body?.model||''),{confirmPause:body?.confirmPause,promptBudgetSeconds:body?.promptBudgetSeconds,untuned:body?.untuned===true});}
      else return json(res,405,{error:'Method not allowed'});
      res.setHeader('Cache-Control','no-store');
      return json(res,result.status,result.body);
    }
    if (p === '/api/models/calibration' || p === '/api/models/calibration/cancel') {
      if(authn.user.role!=='admin')return json(res,403,{error:'Administrator required for shared model profiles'});
      if(!modelManager.calibration)return json(res,404,{error:'Native calibration is unavailable'});
      let result;
      if(p.endsWith('/cancel')){if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});result=modelManager.calibration.cancel();}
      else if(req.method==='GET')result=modelManager.calibration.status(url.searchParams.get('model')||'');
      else if(req.method==='POST'){const body=await readJson(req);result=await modelManager.calibration.start(String(body?.model||''),{promptBudgetSeconds:body?.promptBudgetSeconds,confirmPause:body?.confirmPause});}
      else return json(res,405,{error:'Method not allowed'});
      res.setHeader('Cache-Control','no-store');
      return json(res,result.status,result.body);
    }

    if (p === '/api/models/preset/suggest') {
      if(authn.user.role!=='admin')return json(res,403,{error:'Administrator required for shared model profiles'});
      if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
      if(!modelManager.suggestPreset)return json(res,404,{error:'Native preset suggestions are unavailable'});
      const result=await modelManager.suggestPreset(url.searchParams.get('model') || '');
      return json(res,result.status,result.body);
    }

    // Read-only memory estimate inputs (#204): file metadata and sizes, never a load or a write.
    if (p === '/api/models/estimate') {
      if(authn.user.role!=='admin')return json(res,403,{error:'Administrator required for shared model profiles'});
      if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
      if(!modelManager.estimateMemory)return json(res,404,{error:'Memory estimates need the native engine'});
      const model=url.searchParams.get('model')||'';
      if(!model||model.length>200)return json(res,400,{error:'Choose a model'});
      try{const result=await modelManager.estimateMemory(model);res.setHeader('Cache-Control','no-store');return json(res,result.status,result.body);}
      catch(e){return json(res,500,{error:clientMessage(e,'Could not estimate memory for this model.')});}
    }

    if (p === '/api/models/preset') {
      if(authn.user.role!=='admin')return json(res,403,{error:'Administrator required for shared model profiles'});
      if(!modelManager.getPreset)return json(res,404,{error:'Native presets are unavailable'});
      if(!['GET','PUT'].includes(req.method))return json(res,405,{error:'Method not allowed'});
      const result=req.method==='GET' ? await modelManager.getPreset(url.searchParams.get('model') || '') : await modelManager.applyPreset(await readJson(req));
      return json(res,result.status,result.body);
    }

    if (p === '/api/models/capabilities' && req.method === 'GET') {
      return json(res,200,{kind:modelManager.kind,enabled:modelManager.enabled,admin:authn.user.role==='admin',...modelManager.capabilities,modelManagement:!!env.MODEL_LOADER_URL&&authn.user.role==='admin'});
    }

    if (p === '/api/models/hardware') {
      if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
      if(!modelManager.enabled)return json(res,404,{error:'Model manager is disabled. Enter a memory plan manually.'});
      try {
        const result=await modelManager.systemInfo();
        if(!result.ok)return json(res,502,{error:'Inference hardware is unavailable. Enter a memory plan manually or retry.'});
        return json(res,200,require('../model-hardware.cjs').modelHardware(result.body));
      } catch { return json(res,502,{error:'Could not read inference hardware. Enter a memory plan manually or retry.'}); }
    }

    if (p === '/api/models/installed') {
      try {
        return json(res, 200, await modelsInstalled());
      } catch (err) {
        return json(res, 502, { error: clientMessage(err, 'Could not list installed models.') });
      }
    }

    if (p === '/api/models/mtp-artifact' && req.method === 'GET') {
      const repo = url.searchParams.get('repo') || '';
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json(res,400,{error:'Invalid repository'});
      const result = await modelManager.variants(repo);
      if (!result.ok) return json(res,502,{error:'Could not resolve selected files'});
      const variant = (result.body?.variants || []).find(v=>v.name === url.searchParams.get('variant'));
      if (!variant) return json(res,404,{error:'Variant no longer available'});
      return json(res,200,await require('../mtp-artifact.cjs').check(repo,variant.files || [variant.primary_file]));
    }

    if (p === '/api/models/pull' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (!body.checkpoint) return json(res, 400, { error: 'checkpoint required' });
      if (!modelManager.enabled) return json(res, 404, { error: 'model management is disabled' });
      const modelName = body.modelName || deriveUserModelName(body.checkpoint);
      const r = await modelManager.pull({ modelName, checkpoint: body.checkpoint, recipe: body.recipe || 'llamacpp' });
      return json(
        res,
        r.ok ? 200 : 502,
        r.ok ? { jobId: r.body?.id || r.body?.job_id || 'pull', modelName: r.body?.modelName || modelName } : { error: r.body?.error || `pull failed: ${r.status}` },
      );
    }

    if (p === '/api/models/delete' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (!body.name) return json(res, 400, { error: 'name required' });
      if (isSystemModel(body.name)) return json(res, 400, { error: SYSTEM_MODEL_DELETE_REASON });
      if (!modelManager.enabled) return json(res, 404, { error: 'model management is disabled' });
      // A neutral id can still point at Laya's weights: check the router's --model path as well.
      if (modelManager.kind === 'llamacpp' && typeof modelManager.request === 'function') {
        const listing = await modelManager.request('/models').catch(() => null);
        if (!listing?.ok || !Array.isArray(listing.body?.data)) return json(res, 409, { error: 'Could not confirm this is not a system model. Try again.' });
        const row = listing.body.data.find(m => m.id === body.name);
        if (row && isSystemModel(row.id, modelPathFromArgs(row.status?.args || []))) return json(res, 400, { error: SYSTEM_MODEL_DELETE_REASON });
      }
      // Confirm the model is known before touching it: an unknown name 404s instead of
      // forwarding a delete the manager might silently accept for anything. When the
      // installed list cannot be read (engine unreachable) this check is skipped and the
      // delete below is attempted anyway, same as before this existence check existed.
      let installed = null;
      try { installed = await modelsInstalled(); } catch { installed = null; }
      const entry = Array.isArray(installed) ? installed.find((m) => m.name === body.name) : null;
      if (Array.isArray(installed) && !entry) return json(res, 404, { error: `model not found: ${body.name}` });
      // Unload first: a loaded model can refuse deletion or leave its file locked. Tolerate
      // the manager reporting "not loaded" (or being momentarily unreachable) — the delete
      // below still goes ahead either way. removeModel (llama.cpp) holds a single mutate()
      // gate across both calls and retries the unload once if the delete is refused, so an
      // on-demand load cannot slip in between; other manager kinds fall back to the two calls.
      let unloaded = false, r;
      if (typeof modelManager.removeModel === 'function') {
        r = await modelManager.removeModel(body.name);
        unloaded = !!r.unloaded;
      } else {
        if (!entry || entry.loaded) {
          const u = await modelManager.unload(body.name).catch(() => null);
          unloaded = !!u?.ok;
        }
        r = await modelManager.deleteModel(body.name);
      }
      if (!r.ok) return json(res, 502, { error: `delete failed: ${r.status}`, unloaded });
      // The model is gone: drop every auto-role that pointed at it, the shared "last loaded
      // model" default if it was this one, and the cached folder scan, so nothing still
      // served by this route can hand the deleted name back out.
      const rolesCleared = clearRoleReferences(body.name);
      if (lastLoadedModel() === body.name) clearLastLoadedModel(body.name);
      modelScanCache.clear();
      return json(res, 200, { ok: true, unloaded, rolesCleared });
    }

    for (const verb of ['load', 'unload']) {
      if (p === `/api/models/${verb}` && req.method === 'POST') {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: 'invalid JSON' });
        }
        if (!body.name) return json(res, 400, { error: 'name required' });
        if (!modelManager.enabled) return json(res, 404, { error: 'model management is disabled' });
        if (verb === 'load' && body.mtp !== undefined && modelManager.kind === 'llamacpp') return json(res,400,{error:'Use the native preset editor to configure speculative decoding.'});
        if (verb === 'load' && body.mtp !== undefined) {
          const listing = await modelManager.listModels();
          if (!listing.ok) return json(res,502,{error:'Could not verify MTP support'});
          const model = (listing.body.data || []).find(m=>(m.id || m.model_name)===body.name);
          if (!model) return json(res,404,{error:'Model not installed'});
          let options;
          try { options = require('../mtp.cjs').loadOptions(model,body.mtp); }
          catch(error) { return json(res,400,{error:error.message}); }
          const loaded = await modelManager.load(body.name,options);
          if (!loaded.ok) return json(res,502,{error:'Model could not load with that MTP setting. Previous saved settings were kept.'});
          const saved = await modelManager.load(body.name,{...options,save_options:true});
          return json(res,saved.ok?200:502,saved.ok?{ok:true}:{error:'Model loaded, but its MTP preference could not be saved. Check before reloading.'});
        }
        const r = await modelManager[verb](body.name);
        return json(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { error: `${verb} failed: ${r.status}` });
      }
    }

    if (p === '/api/models/downloads') {
      if (!modelManager.enabled) return json(res, 200, []);
      const r = await modelManager.downloads();
      if (!r.ok) return json(res, 502, {error:'Download status unavailable'});
      const arr = Array.isArray(r.body) ? r.body : r.body?.jobs || r.body?.downloads || [];
      // Lemonade reports `percent` as 0-100; the UI expects a 0-1 fraction.
      return json(res, 200, arr.map((j) => ({
        id: j.id || j.job_id || '',
        model: j.model_name || j.model || j.checkpoint || '',
        progress: typeof j.percent === 'number' ? j.percent / 100 : typeof j.progress === 'number' ? j.progress : null,
        status: j.status || j.state || '',
      })));
    }

    return PASS;
  }

  return async function modelRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createModelRoutes };
