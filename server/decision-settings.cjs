'use strict';
const {configuration,createDecisionEndpoint}=require('./decision-endpoint.cjs');
const {serviceFetch,decisionServiceFetch}=require('./service-endpoint.cjs');
const {createReread}=require('./shared-reread.cjs');
const KEY='decision:configuration';
const {PROFILES,profileFor}=require('./decision-models.cjs');
/** #1666: the decision model ids an administrator can choose. */
const DECISION_MODELS=Object.freeze(Object.keys(PROFILES));
// What the private decision service (services/laya/server.py validate + worker budget) accepts, so
// callers can shape a request it will not refuse with a 422 (#682). maxChoiceChars approximates the
// model's option-head token budget (192 tokens minus 32: 160 for question, ids and labels) at under three
// characters per token; the service still has the final word on the real token count.
const SERVICE_LIMITS=Object.freeze({maxOptions:8,maxLabelChars:120,maxChoiceChars:360,maxQuestionChars:500,maxStateChars:4000});
const SERVICE_KINDS=Object.freeze(['choice']);
const ID_RE=/^[a-z][a-z0-9_]{0,31}$/;
/** Option ids the service accepts, mapped one-to-one from the caller's ids (tool names may hold
 *  capitals, dots or dashes). Labels are cut to the service's limit. */
function serviceOptions(options) {
  const toService=new Map(), toCaller=new Map();
  for (const o of options) {
    let id=String(o.id).toLowerCase().replace(/[^a-z0-9_]/g,'_');
    if(!/^[a-z]/.test(id)) id=`o_${id}`;
    const base=id.slice(0,32); id=base;
    for (let n=2; toCaller.has(id) || !ID_RE.test(id); n++) id=`${base.slice(0,28)}_${n}`;
    toService.set(o.id,id); toCaller.set(id,o.id);
  }
  const shaped=options.map(o=>({id:toService.get(o.id),label:(String(o.label||'').replace(/\s+/g,' ').trim()||String(o.id)).slice(0,SERVICE_LIMITS.maxLabelChars)}));
  return {shaped,toCaller};
}
/** The lower-cased hostname of a decision-service URL, or '' (#1745). */
function hostOf(url) {
  try { return new URL(String(url||'').trim()).hostname.toLowerCase(); } catch { return ''; }
}
/** Startup warnings for a decision configuration that fails silently (#1745): a COWORK_DECISION_URL whose host
 *  is `kev` with a COWORK_DECISION_MODEL that is not a Kev id sends Laya-format requests to Ollaya, which
 *  answers every one of them with an invalid result. */
function startupWarnings(env=process.env) {
  const out=[];
  const {profileFor}=require('./decision-models.cjs');
  const {COMPACT}=require('./decision-wording.cjs');
  if(hostOf(env.COWORK_DECISION_URL)==='kev' && profileFor(env.COWORK_DECISION_MODEL).wording!==COMPACT)
    out.push(`[system-one] COWORK_DECISION_URL points at the host "kev", but COWORK_DECISION_MODEL (${env.COWORK_DECISION_MODEL ? JSON.stringify(String(env.COWORK_DECISION_MODEL).slice(0,64)) : 'unset'}) is not a Kev model; Laya-format requests will be sent and every decision will fail. Set COWORK_DECISION_MODEL=kev-0.8b.`);
  return out;
}
// #1755: fetchImpl defaults to the on-this-network fetch (service-endpoint.cjs), which resolves a name
// at connect time and refuses it unless every answer is on this network.
// #2190: the Rust front owns Settings -> Models -> Decision service (GET/PUT/DELETE and the connection
// test, noevia-rs decision_settings_routes.rs) and is the single writer of the `decision:configuration`
// row; this module only reads it. Every use re-reads the row's content fingerprint (shared-reread.cjs)
// and parses it again only when it changed, so Rust's latest save applies to the next decision with no
// restart. The per-URL backends below stay a cache keyed by what was read.
// #1638: `machineUrl` is the address of the machine Settings → Inference machines puts the decision service on
// (inference-machines.cjs urlFor('decision')), or null while it is on this machine. It wins over the URL saved here
// and COWORK_DECISION_URL; the deadline and the model chosen here still apply. A machine is another host, so the
// shared COWORK_DECISION_API_KEY is never sent there (backend()'s #1753 same-host rule).
// #1844: `sensitivityMachineUrl` is the same for the sensitivity check's own entry on that page
// (inference-machines.cjs urlFor('sensitivity')); see sensitivityBackend().
function createDecisionSettings({store,env=process.env,fetchImpl=decisionServiceFetch,sensitivityFetchImpl=(fetchImpl===decisionServiceFetch?serviceFetch:fetchImpl),kinds=SERVICE_KINDS,machineUrl=()=>null,sensitivityMachineUrl=()=>null}) {
  // A row that cannot be read or parsed is the same fallback as before #2190: an empty saved URL.
  const unreadable=()=>({url:'',timeoutMs:1500});
  let runtimeSource=null, observed=null;
  const saved=createReread({
    // One read gives the row and its fingerprint; a store without readFact (tests) is keyed by its raw value.
    signal:()=>{ runtimeSource=null; observed=typeof store.readFact==='function' ? store.readFact(KEY) : {value:store.get(KEY),source:null}; runtimeSource=observed.source; return observed.source ?? `raw:${String(observed.value)}`; },
    load:()=>{ try { return JSON.parse(observed.value||'null'); } catch { return unreadable(); } },
    fallback:()=>{ runtimeSource=null; return unreadable(); },
  });
  function loadRuntimeSource() { saved.invalidate(); saved.current(); return runtimeSource; }
  loadRuntimeSource();
  // #1666: `model` is the decision model the administrator chose in Settings, present only when one was chosen (absent =
  // automatic: the deployment's COWORK_DECISION_MODEL when the URL is the deployment's own, Laya otherwise, exactly as
  // before). The reply is otherwise unchanged (the recorded HTTP contract corpus); the choosable ids are on the admin's
  // Decision row of /api/models/assignments.
  const onMachine=()=>{ try { const u=machineUrl(); return typeof u==='string'&&u?u:null; } catch { return null; } };
  const sensitivityOnMachine=()=>{ try { const u=sensitivityMachineUrl(); return typeof u==='string'&&u?u:null; } catch { return null; } };
  const get=()=>{
    const current=saved.current();
    const base=current || {url:env.COWORK_DECISION_URL||'',timeoutMs:1500};
    const machine=onMachine();
    return {url:machine||base.url,timeoutMs:base.timeoutMs,...(typeof base.model==='string'&&base.model?{model:base.model}:{}),source:machine?'machine':current?'admin':'deployment'};
  };
  // #1639: the model behind the URL (decision-models.cjs) is the operator's COWORK_DECISION_MODEL, and
  // it belongs to COWORK_DECISION_URL: an administrator who saved another URL in Settings gets the
  // Laya profile there (unknown model), exactly as before #1639.
  const envUrl=()=>{ const c=configuration({COWORK_DECISION_URL:env.COWORK_DECISION_URL}); return c.reason?null:c.baseUrl; };
  const modelFor=(url)=>url && url===envUrl() ? env.COWORK_DECISION_MODEL : undefined;
  const cache=new Map();
  /** One backend per (url, model, key source), so its lane and the callers' decision layers survive between chats.
   *  `apiKey` is the bearer key for this URL only (#1745); none: no key is sent. */
  function backendFor(url,model,apiKey=env.COWORK_DECISION_API_KEY,keySource='shared',linkLocal=true) {
    const config=configuration({COWORK_DECISION_URL:url},{linkLocal});
    if(config.reason) return null;
    const key=JSON.stringify([config.baseUrl,model||'',apiKey?keySource:'',linkLocal]);
    if(cache.has(key)) return cache.get(key);
    if(cache.size>=8) cache.clear(); // an administrator trying URLs in Settings does not grow this without bound
    const endpoint=createDecisionEndpoint({env:{COWORK_DECISION_URL:config.baseUrl,
      ...(model?{COWORK_DECISION_MODEL:model}:{}),
      ...(apiKey?{COWORK_DECISION_API_KEY:apiKey}:{})},linkLocal,fetchImpl:linkLocal?fetchImpl:sensitivityFetchImpl});
    const made={id:'decision-service',healthHeaders:endpoint.healthHeaders,baseUrl:endpoint.baseUrl,supports:kind=>kinds.includes(kind),locality:'local',limits:SERVICE_LIMITS,
      model:endpoint.model,wording:endpoint.wording,
      async decide(request,opts) {
        const options=request.options||[];
        if(options.length<2 || options.length>SERVICE_LIMITS.maxOptions) throw Object.assign(Error('Option count outside the service limit'),{reason:'too-many-options'});
        const {shaped,toCaller}=serviceOptions(options);
        // #1437: the sensitivity check is served ahead of other decision calls in the Laya lane.
        const result=await endpoint.choice({state:String(request.context?.stateText||'').slice(0,SERVICE_LIMITS.maxStateChars),
          question:String(request.question||'').slice(0,SERVICE_LIMITS.maxQuestionChars),options:shaped},{...opts,urgent:request.purpose==='routing.sensitivity'});
        return {...result,selected:toCaller.get(result.selected),scores:Object.fromEntries(Object.entries(result.scores).map(([id,v])=>[toCaller.get(id),v]))};
      },
      supervise:(...args)=>endpoint.decide(...args)};
    cache.set(key,made);
    return made;
  }
  // The backend for every decision purpose except the sensitivity check: route, tool gate, supervision, framing.
  // #1753: the shared COWORK_DECISION_API_KEY belongs to COWORK_DECISION_URL. A URL an administrator saved in
  // Settings gets it only when it is on the same host (the #1745 hostOf rule); another host gets no key.
  // #1845: an address that comes from an Inference machine is connected to with link-local refused (linkLocal=false), so a
  // DNS re-point of the machine's name to 169.254.x fails at connect time. The saved URL and env paths keep linkLocal=true.
  function backend() {
    const current=get();
    const config=configuration({COWORK_DECISION_URL:current.url});
    if(config.reason) return null;
    const sameHost=!!hostOf(config.baseUrl) && hostOf(config.baseUrl)===hostOf(env.COWORK_DECISION_URL);
    // #1666: a model chosen in Settings wins; automatic keeps the #1639 rule (modelFor).
    return backendFor(config.baseUrl,current.model||modelFor(config.baseUrl),sameHost?env.COWORK_DECISION_API_KEY:null,'shared',current.source!=='machine');
  }
  // #1639: the sensitivity check's backend. COWORK_SENSITIVITY_DECISION_URL unset or empty: backend(),
  // as before. Set: that service only (its model COWORK_SENSITIVITY_DECISION_MODEL, unset: Laya), so it
  // can stay on a model it was measured on while the others move. Set but not a private decision-service
  // URL: none, so the check is unavailable and the turn stays local; it never falls back to the other service.
  // #1745: its key is COWORK_SENSITIVITY_DECISION_API_KEY. Unset, the shared COWORK_DECISION_API_KEY is sent only
  // when the sensitivity URL is on the same host as COWORK_DECISION_URL; another host gets no key at all.
  // #1844: an address from Settings → Inference machines wins over COWORK_SENSITIVITY_DECISION_URL and over sharing.
  // It is connected to with link-local refused (like every machine address, #1845) and gets a key only for its own
  // host: the sensitivity key if that is the host of COWORK_SENSITIVITY_DECISION_URL, else the shared key if that is
  // the host of COWORK_DECISION_URL, else none. The model is COWORK_SENSITIVITY_DECISION_MODEL (unset: Laya).
  function sensitivityBackend() {
    const machine=sensitivityOnMachine();
    if(machine) {
      const config=configuration({COWORK_DECISION_URL:machine},{linkLocal:false});
      if(config.reason) return null;
      const host=hostOf(config.baseUrl);
      const ownUrl=typeof env.COWORK_SENSITIVITY_DECISION_URL==='string' ? env.COWORK_SENSITIVITY_DECISION_URL.trim() : '';
      const own=typeof env.COWORK_SENSITIVITY_DECISION_API_KEY==='string' ? env.COWORK_SENSITIVITY_DECISION_API_KEY.trim() : '';
      if(own && ownUrl && host===hostOf(ownUrl)) return backendFor(config.baseUrl,env.COWORK_SENSITIVITY_DECISION_MODEL||undefined,own,'sensitivity',false);
      const sameHost=!!host && host===hostOf(env.COWORK_DECISION_URL);
      return backendFor(config.baseUrl,env.COWORK_SENSITIVITY_DECISION_MODEL||undefined,sameHost?env.COWORK_DECISION_API_KEY:null,'shared',false);
    }
    const url=typeof env.COWORK_SENSITIVITY_DECISION_URL==='string' ? env.COWORK_SENSITIVITY_DECISION_URL.trim() : '';
    if(!url) return backend();
    const own=typeof env.COWORK_SENSITIVITY_DECISION_API_KEY==='string' ? env.COWORK_SENSITIVITY_DECISION_API_KEY.trim() : '';
    if(own) return backendFor(url,env.COWORK_SENSITIVITY_DECISION_MODEL||undefined,own,'sensitivity',false);
    const sameHost=!!hostOf(url) && hostOf(url)===hostOf(env.COWORK_DECISION_URL);
    return backendFor(url,env.COWORK_SENSITIVITY_DECISION_MODEL||undefined,sameHost?env.COWORK_DECISION_API_KEY:null,'shared',false);
  }
  return {
    get, backend, sensitivityBackend,
    // A known malformed row may produce the existing fallback; a failed read has no provenance.
    // The fingerprint of the row the last use parsed (feature-runtime.cjs compares it with the store's).
    runtimeContextSource:()=>runtimeSource,
    refreshRuntimeContextSource:loadRuntimeSource,
    /** Why an experiment that needs `kind` decisions cannot run, or null. Without a kind: only
     *  whether a service is configured. */
    unavailable:(kind)=>{
      if(configuration({COWORK_DECISION_URL:get().url}).reason) return 'Set up the decision service below before enabling this experiment.';
      if(typeof kind==='string' && !kinds.includes(kind)) return `The configured decision service does not support ${kind} decisions, so this experiment cannot run.`;
      return null;
    },
    /** #1796: what Settings → Models shows for the decision service and the sensitivity check: the model id
     *  each one is sent as (decision-models.cjs), whether it is set up, and where the shared URL comes from.
     *  Never an address or a key, so members may see it. */
    describe() { return describeDecision(env,get(),sensitivityOnMachine()); },
  };
}
/** #1796: the decision rows of Settings → Models, from the shared configuration `current` ({url, source})
 *  and the environment. `model` is the id the requests are shaped for: COWORK_DECISION_MODEL when the URL
 *  is the deployment's own, the Laya profile otherwise (exactly what backend() sends). The sensitivity
 *  check is `shared` unless COWORK_SENSITIVITY_DECISION_URL names its own service. */
function describeDecision(env=process.env,current=null,sensitivityMachine=null) {
  const cur=current || {url:env.COWORK_DECISION_URL||'',source:'deployment'};
  const modelName=(id)=>{ const raw=typeof id==='string'?id.trim():''; return raw && raw.length<=64 ? raw : profileFor(raw).id; };
  const shared=configuration({COWORK_DECISION_URL:cur.url});
  const envConfig=configuration({COWORK_DECISION_URL:env.COWORK_DECISION_URL});
  const sameAsEnv=!shared.reason && !envConfig.reason && shared.baseUrl===envConfig.baseUrl;
  // #1666: a model chosen in Settings (cur.model) is what backend() sends, so it is what the row names.
  const chosen=typeof cur.model==='string' && cur.model ? cur.model : '';
  const decision=shared.reason ? {model:null,state:'off',source:cur.source}
    : {model:chosen?profileFor(chosen).id:modelName(sameAsEnv?env.COWORK_DECISION_MODEL:undefined),state:'active',source:cur.source,...(chosen?{modelSource:'admin'}:{})};
  const ownUrl=typeof env.COWORK_SENSITIVITY_DECISION_URL==='string' ? env.COWORK_SENSITIVITY_DECISION_URL.trim() : '';
  let sensitivity;
  if(sensitivityMachine) {
    const own=configuration({COWORK_DECISION_URL:sensitivityMachine},{linkLocal:false});
    sensitivity=own.reason ? {model:null,state:'off',shared:false} : {model:modelName(env.COWORK_SENSITIVITY_DECISION_MODEL),state:'active',shared:false};
  } else if(!ownUrl) sensitivity={model:decision.model,state:decision.state,shared:true};
  else {
    const own=configuration({COWORK_DECISION_URL:ownUrl},{linkLocal:false});
    sensitivity=own.reason ? {model:null,state:'off',shared:false} : {model:modelName(env.COWORK_SENSITIVITY_DECISION_MODEL),state:'active',shared:false};
  }
  return {decision,sensitivity};
}
module.exports={createDecisionSettings,describeDecision,serviceOptions,startupWarnings,hostOf,SERVICE_LIMITS,DECISION_MODELS};
