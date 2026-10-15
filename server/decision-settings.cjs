'use strict';
const {configuration,createDecisionEndpoint}=require('./decision-endpoint.cjs');
const {checkServiceEndpoint,serviceFetch,decisionServiceFetch}=require('./service-endpoint.cjs');
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
  if(hostOf(env.COWORK_DECISION_URL)==='kev' && profileFor(env.COWORK_DECISION_MODEL).wording!=='kev')
    out.push(`[system-one] COWORK_DECISION_URL points at the host "kev", but COWORK_DECISION_MODEL (${env.COWORK_DECISION_MODEL ? JSON.stringify(String(env.COWORK_DECISION_MODEL).slice(0,64)) : 'unset'}) is not a Kev model; Laya-format requests will be sent and every decision will fail. Set COWORK_DECISION_MODEL=kev-0.8b.`);
  return out;
}
// #1755: fetchImpl defaults to the on-this-network fetch (service-endpoint.cjs), which resolves a name
// at connect time and refuses it unless every answer is on this network; `lookup` is the resolver the
// connection test's up-front check uses (tests stub it).
const invalidUrl=()=>Object.assign(Error('Use a private HTTP address such as http://192.168.1.20:8040, with no path, login or query string.'),{status:400,messageId:'invalidUrl'});
function createDecisionSettings({store,env=process.env,fetchImpl=decisionServiceFetch,sensitivityFetchImpl=(fetchImpl===decisionServiceFetch?serviceFetch:fetchImpl),lookup=undefined,audit=()=>{},kinds=SERVICE_KINDS}) {
  let saved;
  try { saved=JSON.parse(store.get(KEY)||'null'); } catch { saved={url:'',timeoutMs:1500}; }
  // #1666: `model` is the decision model the administrator chose in Settings, present only when one was chosen (absent =
  // automatic: the deployment's COWORK_DECISION_MODEL when the URL is the deployment's own, Laya otherwise, exactly as
  // before). The reply is otherwise unchanged (the recorded HTTP contract corpus); the choosable ids are on the admin's
  // Decision row of /api/models/assignments.
  const get=()=>{
    const base=saved || {url:env.COWORK_DECISION_URL||'',timeoutMs:1500};
    return {url:base.url,timeoutMs:base.timeoutMs,...(typeof base.model==='string'&&base.model?{model:base.model}:{}),source:saved?'admin':'deployment'};
  };
  function validate(value) {
    if(!value || typeof value.url!=='string' || !Number.isInteger(value.timeoutMs) || value.timeoutMs<100 || value.timeoutMs>2000)
      throw Object.assign(Error('Enter a private decision-service URL and a deadline from 100 to 2000 ms.'),{status:400,messageId:'invalidInput'});
    const parsed=configuration({COWORK_DECISION_URL:value.url.trim()});
    if(parsed.reason) throw invalidUrl();
    // #1666: '' / absent = automatic. Anything else must name a known profile: a typo is refused here rather than
    // silently sent as Laya (unknown ids in COWORK_DECISION_MODEL keep falling back to Laya, as before).
    // #1816: a PUT without `model` keeps the saved one (an older tab or a script sending {url,timeoutMs}); only '' / null clear it.
    const raw=value.model===undefined ? (typeof saved?.model==='string' ? saved.model : '') : value.model===null ? '' : value.model;
    const model=typeof raw==='string' ? raw.trim().toLowerCase() : null;
    if(model===null || (model && !Object.prototype.hasOwnProperty.call(PROFILES,model)))
      throw Object.assign(Error('Choose a decision model from the list, or automatic.'),{status:400,messageId:'invalidModel'});
    return {url:parsed.baseUrl,timeoutMs:value.timeoutMs,...(model?{model}:{})};
  }
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
    const made={id:'decision-service',supports:kind=>kinds.includes(kind),locality:'local',limits:SERVICE_LIMITS,
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
  function backend() {
    const current=get();
    const config=configuration({COWORK_DECISION_URL:current.url});
    if(config.reason) return null;
    const sameHost=!!hostOf(config.baseUrl) && hostOf(config.baseUrl)===hostOf(env.COWORK_DECISION_URL);
    // #1666: a model chosen in Settings wins; automatic keeps the #1639 rule (modelFor).
    return backendFor(config.baseUrl,current.model||modelFor(config.baseUrl),sameHost?env.COWORK_DECISION_API_KEY:null,'shared');
  }
  // #1639: the sensitivity check's backend. COWORK_SENSITIVITY_DECISION_URL unset or empty: backend(),
  // as before. Set: that service only (its model COWORK_SENSITIVITY_DECISION_MODEL, unset: Laya), so it
  // can stay on a model it was measured on while the others move. Set but not a private decision-service
  // URL: none, so the check is unavailable and the turn stays local; it never falls back to the other service.
  // #1745: its key is COWORK_SENSITIVITY_DECISION_API_KEY. Unset, the shared COWORK_DECISION_API_KEY is sent only
  // when the sensitivity URL is on the same host as COWORK_DECISION_URL; another host gets no key at all.
  function sensitivityBackend() {
    const url=typeof env.COWORK_SENSITIVITY_DECISION_URL==='string' ? env.COWORK_SENSITIVITY_DECISION_URL.trim() : '';
    if(!url) return backend();
    const own=typeof env.COWORK_SENSITIVITY_DECISION_API_KEY==='string' ? env.COWORK_SENSITIVITY_DECISION_API_KEY.trim() : '';
    if(own) return backendFor(url,env.COWORK_SENSITIVITY_DECISION_MODEL||undefined,own,'sensitivity',false);
    const sameHost=!!hostOf(url) && hostOf(url)===hostOf(env.COWORK_DECISION_URL);
    return backendFor(url,env.COWORK_SENSITIVITY_DECISION_MODEL||undefined,sameHost?env.COWORK_DECISION_API_KEY:null,'shared',false);
  }
  return {
    get, backend, sensitivityBackend,
    /** Why an experiment that needs `kind` decisions cannot run, or null. Without a kind: only
     *  whether a service is configured. */
    unavailable:(kind)=>{
      if(configuration({COWORK_DECISION_URL:get().url}).reason) return 'Set up the decision service below before enabling this experiment.';
      if(typeof kind==='string' && !kinds.includes(kind)) return `The configured decision service does not support ${kind} decisions, so this experiment cannot run.`;
      return null;
    },
    save(value,actor) {const next=validate(value);store.set(KEY,JSON.stringify(next));saved=next;audit('decision.configure',actor,{url:next.url,timeoutMs:next.timeoutMs,model:next.model||'auto'});return get();},
    /** #1765: forgets the URL and deadline saved in Settings, so COWORK_DECISION_URL (and its key and model)
     *  applies again. Audited, also when nothing was saved, so the log shows every attempt. */
    reset(actor) {
      const had=!!saved;
      if(typeof store.delete==='function') store.delete(KEY); else store.set(KEY,'null');
      saved=null;
      audit('decision.reset',actor,{hadSaved:had});
      return get();
    },
    /** #1796: what Settings → Models shows for the decision service and the sensitivity check: the model id
     *  each one is sent as (decision-models.cjs), whether it is set up, and where the shared URL comes from.
     *  Never an address or a key, so members may see it. */
    describe() { return describeDecision(env,get()); },
    async test(value) {
      const next=validate(value);
      // #1755: a name is accepted only if every address it resolves to is on this network; say so plainly
      // here instead of as "not ready". The request below is checked again at connect time.
      const where=await checkServiceEndpoint(next.url,{linkLocal:true,...(lookup?{lookup}:{})});
      if(!where.ok && !where.transient) throw invalidUrl();
      try {
        const response=await fetchImpl(next.url+'/health',{signal:AbortSignal.timeout(3000),redirect:'error'});
        if(!response.ok) throw Error();
        const reader=response.body.getReader();let size=0;const chunks=[];
        try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096)throw Error();chunks.push(Buffer.from(value));}}
        finally {await reader.cancel();}
        if(JSON.parse(Buffer.concat(chunks).toString()).ready!==true)throw Error();
        return {ok:true,message:'Decision service is ready. No inference was run.',messageId:'ready'};
      } catch {throw Object.assign(Error('The decision service is not ready or could not be reached. Check the URL and service status.'),{status:502,messageId:'notReady'});}
    },
  };
}
/** #1796: the decision rows of Settings → Models, from the shared configuration `current` ({url, source})
 *  and the environment. `model` is the id the requests are shaped for: COWORK_DECISION_MODEL when the URL
 *  is the deployment's own, the Laya profile otherwise (exactly what backend() sends). The sensitivity
 *  check is `shared` unless COWORK_SENSITIVITY_DECISION_URL names its own service. */
function describeDecision(env=process.env,current=null) {
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
  if(!ownUrl) sensitivity={model:decision.model,state:decision.state,shared:true};
  else {
    const own=configuration({COWORK_DECISION_URL:ownUrl},{linkLocal:false});
    sensitivity=own.reason ? {model:null,state:'off',shared:false} : {model:modelName(env.COWORK_SENSITIVITY_DECISION_MODEL),state:'active',shared:false};
  }
  return {decision,sensitivity};
}
module.exports={createDecisionSettings,describeDecision,serviceOptions,startupWarnings,hostOf,SERVICE_LIMITS,DECISION_MODELS};
