'use strict';
const {configuration,createDecisionEndpoint}=require('./decision-endpoint.cjs');
const KEY='decision:configuration';
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
function createDecisionSettings({store,env=process.env,fetchImpl=globalThis.fetch,audit=()=>{},kinds=SERVICE_KINDS}) {
  let saved;
  try { saved=JSON.parse(store.get(KEY)||'null'); } catch { saved={url:'',timeoutMs:1500}; }
  const get=()=>({...saved || {url:env.COWORK_DECISION_URL||'',timeoutMs:1500},source:saved?'admin':'deployment'});
  function validate(value) {
    if(!value || typeof value.url!=='string' || !Number.isInteger(value.timeoutMs) || value.timeoutMs<100 || value.timeoutMs>2000)
      throw Object.assign(Error('Enter a private decision-service URL and a deadline from 100 to 2000 ms.'),{status:400,messageId:'invalidInput'});
    const parsed=configuration({COWORK_DECISION_URL:value.url.trim()});
    if(parsed.reason) throw Object.assign(Error('Use a private HTTP address such as http://192.168.1.20:8040, with no path, login or query string.'),{status:400,messageId:'invalidUrl'});
    return {url:parsed.baseUrl,timeoutMs:value.timeoutMs};
  }
  // #1639: the model behind the URL (decision-models.cjs) is the operator's COWORK_DECISION_MODEL, and
  // it belongs to COWORK_DECISION_URL: an administrator who saved another URL in Settings gets the
  // Laya profile there (unknown model), exactly as before #1639.
  const envUrl=()=>{ const c=configuration({COWORK_DECISION_URL:env.COWORK_DECISION_URL}); return c.reason?null:c.baseUrl; };
  const modelFor=(url)=>url && url===envUrl() ? env.COWORK_DECISION_MODEL : undefined;
  const cache=new Map();
  /** One backend per (url, model), so its lane and the callers' decision layers survive between chats. */
  function backendFor(url,model) {
    const config=configuration({COWORK_DECISION_URL:url});
    if(config.reason) return null;
    const key=JSON.stringify([config.baseUrl,model||'']);
    if(cache.has(key)) return cache.get(key);
    if(cache.size>=8) cache.clear(); // an administrator trying URLs in Settings does not grow this without bound
    const endpoint=createDecisionEndpoint({env:{COWORK_DECISION_URL:config.baseUrl,
      ...(model?{COWORK_DECISION_MODEL:model}:{}),
      ...(env.COWORK_DECISION_API_KEY?{COWORK_DECISION_API_KEY:env.COWORK_DECISION_API_KEY}:{})},fetchImpl});
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
  function backend() {
    const current=get();
    const config=configuration({COWORK_DECISION_URL:current.url});
    return config.reason ? null : backendFor(config.baseUrl,modelFor(config.baseUrl));
  }
  // #1639: the sensitivity check's backend. COWORK_SENSITIVITY_DECISION_URL unset or empty: backend(),
  // as before. Set: that service only (its model COWORK_SENSITIVITY_DECISION_MODEL, unset: Laya), so it
  // can stay on a model it was measured on while the others move. Set but not a private decision-service
  // URL: none, so the check is unavailable and the turn stays local; it never falls back to the other service.
  function sensitivityBackend() {
    const url=typeof env.COWORK_SENSITIVITY_DECISION_URL==='string' ? env.COWORK_SENSITIVITY_DECISION_URL.trim() : '';
    if(!url) return backend();
    return backendFor(url,env.COWORK_SENSITIVITY_DECISION_MODEL||undefined);
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
    save(value,actor) {const next=validate(value);store.set(KEY,JSON.stringify(next));saved=next;audit('decision.configure',actor,{url:next.url,timeoutMs:next.timeoutMs});return get();},
    async test(value) {
      const next=validate(value);
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
module.exports={createDecisionSettings,serviceOptions,SERVICE_LIMITS};
