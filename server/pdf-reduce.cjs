'use strict';
const INPUT_CAP=60*1024*1024, OUTPUT_CAP=25*1024*1024;
async function prepare(name,bytes,{progress=()=>{},url=process.env.OCR_BASE_URL,fetchImpl=fetch}={}){
 if(bytes.length<=OUTPUT_CAP)return {name,bytes};
 if(!/\.pdf$/i.test(name) || bytes.length>INPUT_CAP)throw Object.assign(Error('Files are limited to 25 MB; PDFs up to 60 MB can be reduced automatically.'),{status:413});
 if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw Object.assign(Error('This file is not a PDF.'),{status:400});
 if(!url)throw Object.assign(Error('PDF compression is unavailable. Compress or split this PDF locally and retry.'),{status:503});
 progress('Extracting PDF text and compressing images to fit 25 MB');
 const response=await fetchImpl(url.replace(/\/+$/,'')+'/reduce-pdf',{method:'POST',redirect:'error',headers:{'Content-Type':'application/pdf'},body:bytes,signal:AbortSignal.timeout(180000)});
 if(!response.ok)throw Object.assign(Error(response.status===503?'Document processor is busy; retry shortly.':'PDF could not fit 25 MB after compression or text extraction. Split or compress it locally and retry.'),{status:response.status===503?503:422});
 const result=await response.json();let output,outputName;
 if(result.kind==='pdf' && typeof result.dataBase64==='string' && result.dataBase64.length<=Math.ceil(OUTPUT_CAP/3)*4){output=Buffer.from(result.dataBase64,'base64');outputName=name.slice(0,-4).slice(0,175)+'.compressed.pdf';if(!output.subarray(0,5).equals(Buffer.from('%PDF-')))throw Error('Invalid reduced PDF');}
 else if(result.kind==='text' && typeof result.text==='string' && result.text.length<=200000){output=Buffer.from(result.text);outputName=name.slice(0,-4).slice(0,175)+'.extracted.txt';}
 if(!output?.length || output.length>OUTPUT_CAP)throw Error('Invalid PDF reduction response');
 const note=result.kind==='pdf'?'Compressed PDF; image quality or interactive features may change. Original remains on your computer.':'Text-only extraction; images, scanned-page text and layout omitted. Original remains on your computer.';
 return {name:outputName,bytes:output,reduction:{originalName:name,originalBytes:bytes.length,kind:result.kind,note}};
}
module.exports={prepare,INPUT_CAP};
