'use strict';
const { readCappedJson } = require('./http.cjs');
const workers=require('./document-workers.cjs');
const VERSION='docx-main-body-v1';
// The text is limited to 200000 characters below; 2 MB holds that even fully JSON-escaped (#920).
const DOCX_REPLY_CAP=2*1024*1024;
async function extract(bytes,options={}) {
  // #1841: the machine OCR is assigned to, else OCR_BASE_URL (document-workers.cjs).
  const target=workers.resolve('ocr');
  const url=options.url===undefined?target.url:options.url;
  const fetchImpl=options.fetchImpl||(options.url===undefined?target.fetch:fetch);
  if(!url)throw Error('DOCX reader is unavailable. Re-upload after the document worker is configured.');
  const response=await fetchImpl(url.replace(/\/+$/,'')+'/extract-docx',{
    method:'POST',redirect:'error',headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},
    body:bytes,signal:AbortSignal.timeout(60000),
  });
  if(!response.ok)throw Error(response.status===503?'Document reader is busy. Re-upload or refresh connected storage to retry.':'DOCX could not be read; it may be malformed, encrypted, oversized, or the reader is unavailable.');
  const result=await readCappedJson(response,DOCX_REPLY_CAP).catch(e=>{throw e?.code==='too_large'?Error('Invalid DOCX reader response.'):e;});
  if(typeof result.text!=='string' || result.text.length>200000 || typeof result.truncated!=='boolean')throw Error('Invalid DOCX reader response.');
  return result;
}
module.exports={VERSION,extract};
