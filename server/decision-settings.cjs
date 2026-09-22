'use strict';
const {configuration,createDecisionEndpoint}=require('./decision-endpoint.cjs');
const KEY='decision:configuration';
function createDecisionSettings({store,env=process.env,fetchImpl=globalThis.fetch,audit=()=>{}}) {
  let saved;
  try { saved=JSON.parse(store.get(KEY)||'null'); } catch { saved={url:'',timeoutMs:1500}; }
  let cachedKey, cachedBackend;
  const get=()=>({...saved || {url:env.COWORK_DECISION_URL||'',timeoutMs:1500},source:saved?'admin':'deployment'});
  function validate(value) {
    if(!value || typeof value.url!=='string' || !Number.isInteger(value.timeoutMs) || value.timeoutMs<100 || value.timeoutMs>1500)
      throw Object.assign(Error('Enter a private decision-service URL and a deadline from 100 to 1500 ms.'),{status:400});
    const parsed=configuration({COWORK_DECISION_URL:value.url.trim()});
    if(parsed.reason) throw Object.assign(Error('Use a private HTTP origin such as http://laya:8040, without a path, credentials or query string.'),{status:400});
    return {url:parsed.baseUrl,timeoutMs:value.timeoutMs};
  }
  function backend() {
    const current=get();
    if(configuration({COWORK_DECISION_URL:current.url}).reason) return null;
    const key=JSON.stringify(current);
    if(key!==cachedKey) {
      const endpoint=createDecisionEndpoint({env:{COWORK_DECISION_URL:current.url},fetchImpl});
      cachedBackend={supports:kind=>kind==='choice',locality:'local',
        decide:(request,opts)=>endpoint.choice({state:request.context.stateText,question:request.question,options:request.options},opts),
        supervise:(...args)=>endpoint.decide(...args)};
      cachedKey=key;
    }
    return cachedBackend;
  }
  return {
    get, backend,
    unavailable:()=>configuration({COWORK_DECISION_URL:get().url}).reason ? 'Set up the decision service below before enabling this experiment.' : null,
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
        return {ok:true,message:'Decision service is ready. No inference was run.'};
      } catch {throw Object.assign(Error('The decision service is not ready or could not be reached. Check the URL and service status.'),{status:502});}
    },
  };
}
module.exports={createDecisionSettings};
