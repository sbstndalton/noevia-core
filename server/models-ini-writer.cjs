'use strict';
// Who writes models.ini (#295, spec M3). 'web' keeps the historical in-process atomic write;
// 'model-loader' sends the prepared whole-file text to the sidecar's compare-and-swap endpoint
// so the sidecar is the single writer. Web still reads the file directly in both modes.
const crypto=require('node:crypto');
// publicMessage: written for people, so routes may show it even on a 5xx (routes/models.cjs).
const error=(status,message,extra={})=>Object.assign(Error(message),{status,publicMessage:message,...extra});
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
// Confirmed refusals: the sidecar answered before writing anything.
const MISSING='Model Loader could not save models.ini; nothing was changed. Check that the model-loader service is running and up to date, then retry.';
const REJECTED='Model Loader rejected the token; check MODEL_LOADER_TOKEN. Nothing was changed.';
// Transport loss, timeout, 5xx or a malformed reply (#339): the PUT may have committed.
const UNCERTAIN='Model Loader did not confirm whether models.ini was saved. Reload the presets to see the current file before retrying.';
const NOT_SAVED='Model Loader did not confirm the save, and models.ini still holds the previous settings, so the preset was not applied. Check that the model-loader service is running, then retry.';
const THIRD_PARTY='Model Loader did not confirm the save, and models.ini now holds changes from somewhere else. They were left untouched; reload the presets before retrying.';
const UNREADABLE='Model Loader did not confirm the save, and models.ini could not be read back to check. Reload the presets before retrying.';
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
      } catch {throw error(503,UNCERTAIN,{uncertain:true});}
      if(result?.ok&&result.body?.ok===true)return {revision:result.body.revision};
      // 401/403: token mismatch, told apart from an outage (the token itself is never echoed).
      if(result?.status===401||result?.status===403)throw error(503,REJECTED);
      // 404/405: a sidecar released before this endpoint; it never reached a writer.
      if(result?.status===404||result?.status===405)throw error(503,MISSING);
      if(result?.status===409)throw error(409,'Presets changed while applying. Reload before retrying.');
      if(result?.status===400||result?.status===413)throw error(result.status,'Model Loader rejected the preset file: '+String(result.body?.detail||'invalid text').slice(0,200));
      // 5xx, a proxy error or an unexpected body: the sidecar may have renamed the file already.
      throw error(503,UNCERTAIN,{uncertain:true});
    },
  };
}
// Commit through a preset store, settling an uncertain write by reading the shared file back
// (#339). Committed: resolves as a normal success, so the caller runs its usual guarded reload.
// Still the base: an accurate, retryable 503. Anything else: a 409 that never overwrites it.
async function commitReconciled(store,candidate) {
  try {return await store.commit(candidate);}
  catch(e) {
    if(!e?.uncertain)throw e;
    let current;
    try {current=store.snapshot();}catch {throw error(503,UNREADABLE,{uncertain:true});}
    if(current.revision===sha(candidate.text))return {revision:current.revision,reconciled:true};
    if(current.revision===candidate.baseRevision)throw error(503,NOT_SAVED,{retryable:true});
    throw error(409,THIRD_PARTY);
  }
}
module.exports={createModelsIniWriter,commitReconciled};
