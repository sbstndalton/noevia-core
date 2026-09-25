'use strict';
// Who writes models.ini (#295, spec M3). 'web' keeps the historical in-process atomic write;
// 'model-loader' sends the prepared whole-file text to the sidecar's compare-and-swap endpoint
// so the sidecar is the single writer. Web still reads the file directly in both modes.
const error=(status,message)=>Object.assign(Error(message),{status});
const UNAVAILABLE='Model Loader could not save models.ini; nothing was changed. Check that the model-loader service is running and up to date, then retry.';
const REJECTED='Model Loader rejected the token; check MODEL_LOADER_TOKEN. Nothing was changed.';
function createModelsIniWriter({mode,url,token,fetchJson}) {
  const kind=String(mode||'web').toLowerCase();
  if(kind==='web')return null;
  if(kind!=='model-loader')throw Error(`unsupported MODELS_INI_WRITER: ${kind}`);
  if(!url)throw Error('MODELS_INI_WRITER=model-loader requires MODEL_LOADER_URL');
  const endpoint=String(url).replace(/\/+$/,'')+'/api/v1/models-ini';
  return {
    kind,
    async write({baseRevision,text}) {
      let result;
      try {
        result=await fetchJson(endpoint,{method:'PUT',headers:{'Content-Type':'application/json',...(token?{'X-Model-Loader-Token':token}:{})},body:JSON.stringify({baseRevision,text})},30000);
      } catch {throw error(503,UNAVAILABLE);}
      if(result?.ok&&result.body?.ok===true)return {revision:result.body.revision};
      // 401/403: token mismatch, told apart from an outage (the token itself is never echoed).
      if(result?.status===401||result?.status===403)throw error(503,REJECTED);
      // 404/405: a sidecar released before this endpoint. 5xx/no response: unavailable.
      if(result?.status===409)throw error(409,'Presets changed while applying. Reload before retrying.');
      if(result?.status===400||result?.status===413)throw error(result.status,'Model Loader rejected the preset file: '+String(result.body?.detail||'invalid text').slice(0,200));
      throw error(503,UNAVAILABLE);
    },
  };
}
module.exports={createModelsIniWriter};
