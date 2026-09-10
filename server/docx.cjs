'use strict';
const VERSION='docx-main-body-v1';
async function extract(bytes,{url=process.env.OCR_BASE_URL,fetchImpl=fetch}={}) {
  if(!url)throw Error('DOCX reader is unavailable. Re-upload after the document worker is configured.');
  const response=await fetchImpl(url.replace(/\/+$/,'')+'/extract-docx',{
    method:'POST',redirect:'error',headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},
    body:bytes,signal:AbortSignal.timeout(60000),
  });
  if(!response.ok)throw Error(response.status===503?'Document reader is busy. Re-upload or refresh connected storage to retry.':'DOCX could not be read; it may be malformed, encrypted, oversized, or the reader is unavailable.');
  const result=await response.json();
  if(typeof result.text!=='string' || result.text.length>200000 || typeof result.truncated!=='boolean')throw Error('Invalid DOCX reader response.');
  return result;
}
module.exports={VERSION,extract};
