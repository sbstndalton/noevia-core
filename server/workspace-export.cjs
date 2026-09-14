const {Readable, Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
async function proxyWorkspaceExport(res,url,headers) {
  const controller=new AbortController();
  const close=()=>{if(!res.writableEnded)controller.abort();};
  res.on('close',close);
  const deadline=setTimeout(()=>controller.abort(),300000);
  try {
    const upstream=await fetch(url,{headers,signal:controller.signal});
    if(!upstream.ok){
      const body=await upstream.json().catch(()=>({}));
      res.writeHead(upstream.status,{'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify({error:typeof body.detail==='string'?body.detail:'Workspace export failed. Retry after checking storage.'}));
    }
    if(!upstream.body || !upstream.headers.get('content-type')?.startsWith('application/zip'))throw Error('Invalid export response');
    let bytes=0;
    const bound=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;callback(bytes>272*1024*1024?Error('Export exceeds download limit'):null,chunk);}});
    res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="noevia-workspace.zip"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    await pipeline(Readable.fromWeb(upstream.body),bound,res);
  } catch {
    if(res.headersSent)res.destroy();
    else {res.writeHead(502,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'Workspace export could not finish. Retry when storage is available.'}));}
  } finally {clearTimeout(deadline);res.off('close',close);controller.abort();}
}
module.exports={proxyWorkspaceExport};
