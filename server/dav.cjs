'use strict';
const crypto = require('node:crypto');
const { createRateLimiter } = require('./auth.cjs');
const xml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const ALLOW = 'OPTIONS, HEAD, GET, PROPFIND, PUT';
const MAX_BODY = 512 * 1024;
const fail = (status, message) => Object.assign(Error(message), { status });
// Restricted, bounded XML reader for property selection only. No DTD/entities,
// content values, processing instructions or external resources are supported.
function properties(body) {
  if (!body.trim()) return null;
  const input = body.replace(/^\s*<\?xml\s+[^?]*\?>/, '');
  if (input.length > 8192 || /<!|<\?|&/.test(input)) throw fail(400, 'Unsupported property XML');
  const stack = [], nodes = []; let root;
  const tokens=input.match(/<[^>]*>|[^<]+/g)||[];
  if(tokens.join('')!==input)throw fail(400,'Malformed property XML');
  for (const part of tokens) {
    if (!part.startsWith('<')) { if (part.trim()) throw fail(400,'Unexpected property text'); continue; }
    if (part.startsWith('</')) {
      if (!stack.length || part !== `</${stack.pop().tag}>`) throw fail(400,'Malformed property XML');
      continue;
    }
    const m = /^<([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:\s+[^<>]*?)?)\s*(\/?)>$/.exec(part);
    if (!m || nodes.length >= 128 || stack.length >= 8) throw fail(400,'Malformed property XML');
    const ns = { ...(stack.at(-1)?.ns || {}) };
    let attrs = m[2];
    attrs = attrs.replace(/\s+xmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/g, (_, prefix, a, b) => { ns[prefix || ''] = a ?? b; return ''; });
    if (attrs.trim()) throw fail(400,'Unsupported property attributes');
    const parts = m[1].split(':'), local = parts.at(-1), uri = ns[parts.length === 2 ? parts[0] : ''];
    if (!uri) throw fail(400,'Missing property namespace');
    const node = { tag:m[1], local, uri, ns, children:[] }; nodes.push(node);
    if (stack.length) stack.at(-1).children.push(node); else { if (root) throw fail(400,'Multiple property roots'); root=node; }
    if (!m[3]) stack.push(node);
  }
  if (stack.length || !root || root.uri !== 'DAV:' || root.local !== 'propfind' || root.children.length !== 1) throw fail(400,'Invalid propfind');
  const selection=root.children[0];
  if (selection.uri !== 'DAV:') throw fail(400,'Invalid property selection');
  if (selection.local==='allprop' && !selection.children.length) return null;
  if (selection.local!=='prop' || selection.children.some(p=>p.children.length)) throw fail(400,'Only allprop or named properties are supported');
  return selection.children.map(p=>({local:p.local,uri:p.uri}));
}
async function readBody(req, limit) {
  const chunks=[];let size=0;
  for await(const chunk of req) { size+=chunk.length; if(size>limit)throw fail(413,'Request too large');chunks.push(chunk); }
  try { return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)); } catch { throw fail(400,'UTF-8 text required'); }
}
function createDavHandler({ auth, settings, config, files }) {
  const rate=createRateLimiter(); let active=0;
  return async function handleDav(req,res) {
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const send=(status,text='',type='text/plain; charset=utf-8')=>{res.statusCode=status;res.setHeader('Content-Type',type);res.setHeader('Content-Length',Buffer.byteLength(text));res.end(req.method==='HEAD'?'':text);};
    try {
      if (!config.available) return send(404,'Sharing is off');
      if (String(req.headers.host||'').toLowerCase()!==config.host.toLowerCase()) return send(421,'Wrong sharing authority');
      if (!config.cleartext) {
        const token=String(req.headers['x-cowork-dav-proxy-token']||'');
        const a=Buffer.from(token),b=Buffer.from(config.proxyToken);
        if (a.length!==b.length || !crypto.timingSafeEqual(a,b) || req.headers['x-forwarded-proto']!=='https') return send(403,'HTTPS proxy verification required');
      }
      const raw=String(req.url||'');
      if (!raw.startsWith('/dav/') || raw.includes('?') || raw.includes('#') || /[\\\x00-\x1f]/.test(raw)) return send(404,'Unknown sharing path');
      let segments;try{segments=raw.slice(5).split('/').map(decodeURIComponent);}catch{return send(400,'Invalid path encoding');}
      const username=segments.shift();if(segments.at(-1)==='')segments.pop();
      if (!username || segments.some(s=>!s||s.startsWith('.')||/[\\/%\x00-\x1f\x7f]/.test(s)) || raw.length>2000) return send(400,'Invalid path');
      const path=segments.join('/');if(path.length>500)return send(414,'Path too long');
      // Bound work before expensive Argon2. Socket identity cannot be spoofed
      // with forwarded headers; proxies intentionally share this budget.
      if(rate.rateLimited(`dav:${req.socket?.remoteAddress||'unknown'}`,120,60000))return send(429,'Try later');
      if(active>=4)return send(503,'Sharing is busy');
      const header=String(req.headers.authorization||'');
      const challenge=()=>{res.setHeader('WWW-Authenticate','Basic realm="noevia diary files", charset="UTF-8"');return send(401,'Device app password required');};
      if(header.length>512 || !/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(header))return challenge();
      const decoded=Buffer.from(header.slice(6),'base64').toString('utf8'),colon=decoded.indexOf(':');
      if(colon<1 || decoded.slice(0,colon).toLowerCase()!==username.toLowerCase())return challenge();
      active++;
      try {
        const identity=await auth.appPasswords.verifyDav(decoded.slice(0,colon),decoded.slice(colon+1),config.scope);
        if(!identity)return challenge();
        const allowed=()=>auth.appPasswords.list(identity.userId).some(p=>p.id===identity.credentialId) && !!auth.db.prepare('SELECT id FROM users WHERE id=? AND disabled_at IS NULL').get(identity.userId) && settings.scope(identity.userId)===config.scope && auth.diaryEnabled(identity.userId) && auth.getStorage(identity.userId).kind==='local';
        if(!allowed())return send(403,'Sharing is off for this account or storage');
        if(!ALLOW.split(', ').includes(req.method)){res.setHeader('Allow',ALLOW);return send(405,'This Markdown endpoint does not support that operation');}
        if(req.method==='OPTIONS'){res.setHeader('Allow',ALLOW);return send(200);}
        const base='/dav/'+encodeURIComponent(username)+'/';
        const href=(p,dir)=>base+p.split('/').filter(Boolean).map(encodeURIComponent).join('/')+(dir&&p?'/':'');
        const lookup=async p=>{
          if(!p)return {path:'',name:username,isDir:true};
          const parent=p.includes('/')?p.slice(0,p.lastIndexOf('/')):'';
          return (await files.list(identity.userId,parent)).find(x=>x.path===p)||null;
        };
        if(req.method==='PUT'){
          if(!path.toLowerCase().endsWith('.md') || raw.endsWith('/'))return send(415,'Only Markdown files can be written');
          if(req.headers['content-encoding'] && req.headers['content-encoding']!=='identity')return send(415,'Encoded bodies are unsupported');
          if(req.headers['if'] || req.headers['if-unmodified-since'])return send(400,'Use If-Match or If-None-Match');
          const match=req.headers['if-match'],none=req.headers['if-none-match'];
          if(!match && !none)return send(428,'Read the ETag and use If-Match; create with If-None-Match: *');
          if((match&&none) || (none&&none!=='*') || (match&&!/^"[a-f0-9]{64}"$/.test(match)))return send(400,'A single strong ETag or create-only condition is required');
          const parent=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
          if(!(await lookup(parent))?.isDir)return send(409,'Parent folder does not exist');
          const content=await readBody(req,MAX_BODY);
          if(!allowed())return send(403,'Sharing was disabled');
          const result=await files.write(identity.userId,{path,content,version:match?match.slice(1,-1):null});
          res.setHeader('ETag',`"${result.version}"`);
          auth.audit('dav.write',identity.userId,identity.userId,{credentialId:identity.credentialId,path,bytes:Buffer.byteLength(content)});
          return send(none?201:204);
        }
        const item=await lookup(path);if(!item)return send(404,'File or folder not found');
        if(req.method==='GET'||req.method==='HEAD'){
          if(item.isDir)return send(405,'Use PROPFIND to list this folder');
          const result=await files.read(identity.userId,path);if(result.content===null)return send(404,'File not found');
          const tag=`"${result.version}"`;res.setHeader('ETag',tag);
          if(req.headers['if-none-match']===tag||req.headers['if-none-match']==='*')return send(304);
          return send(200,result.content,'text/markdown; charset=utf-8');
        }
        const depth=req.headers.depth ?? 'infinity';
        if(!['0','1'].includes(depth))return send(403,'Only Depth 0 and 1 are supported');
        const selected=properties(await readBody(req,8192));
        const items=[item,...(item.isDir&&depth==='1'?await files.list(identity.userId,path):[])];
        // Avoid turning property reads into unbounded bulk corpus downloads.
        if(items.length>101)return send(413,'Folder exceeds the 100-child sharing limit');
        const rows=[], deadline=Date.now()+45000;
        for(const entry of items){
          if(Date.now()>deadline || res.destroyed)throw fail(504,'Property read timed out');
          if(!allowed())return send(403,'Sharing was disabled or credential revoked');
          const props={displayname:xml(entry.name),resourcetype:entry.isDir?'<d:collection/>':'',getcontenttype:entry.isDir?'httpd/unix-directory':'text/markdown; charset=utf-8'};
          if(!entry.isDir && (!selected||selected.some(p=>p.uri==='DAV:'&&['getetag','getcontentlength'].includes(p.local)))){
            const r=await files.read(identity.userId,entry.path);
            if(r.content===null)continue;
            props.getetag=xml(`"${r.version}"`);props.getcontentlength=String(Buffer.byteLength(r.content));
          }
          const wanted=selected||Object.keys(props).map(local=>({local,uri:'DAV:'}));
          let ok='',missing='';
          for(const p of wanted){
            if(p.uri==='DAV:'&&Object.hasOwn(props,p.local))ok+=`<d:${p.local}>${props[p.local]}</d:${p.local}>`;
            else missing+=`<x:${p.local} xmlns:x="${xml(p.uri)}"/>`;
          }
          const stat=(code,value)=>value?`<d:propstat><d:prop>${value}</d:prop><d:status>HTTP/1.1 ${code}</d:status></d:propstat>`:'';
          rows.push(`<d:response><d:href>${xml(href(entry.path,entry.isDir))}</d:href>${stat('200 OK',ok)}${stat('404 Not Found',missing)}</d:response>`);
        }
        return send(207,`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${rows.join('')}</d:multistatus>`,'application/xml; charset=utf-8');
      } finally { active--; }
    } catch(e) { return send(e.status===409?412:e.status||502,e.status?e.message:'Diary storage is unavailable'); }
  };
}
module.exports={createDavHandler,properties};
