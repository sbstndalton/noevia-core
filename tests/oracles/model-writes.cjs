'use strict';
// Historical Node 22 oracle at Core 3521cdc2; synthetic inputs only.
const { Readable } = require('node:stream');
const { createModelRoutes } = require('./models.cjs');
const { createIdleUnloadSetting } = require('./idle-unload-setting.cjs');
const fs = require('node:fs');
function routes({ installed, sections, reload = { ok: true, status: 200, body: { reloaded: true } }, scan = null, cache = new Map(), manager = {}, unreachable = false, scanFailure = false }) {
  const sent = [], fetched = [], reloads = [];
  let presets = sections.map((s) => ({ ...s }));
  // The router lists a preset until it re-reads models.ini (the #1695 regression).
  let routerRows = installed.map((m) => ({ ...m }));
  const listedAt = [];
  // The loader's folder scan: by default one file per model that is not missing.
  const scanFiles = () => scan || installed.filter((m) => !m.missingFile).map((m) => ({ modelId: m.name, sections: [m.name] }));
  const modelManager = { enabled: true, kind: 'other', capabilities: {}, unload: async () => ({ ok: true }),
    deleteModel: async () => ({ ok: false, status: 404 }),
    reloadPresets: async (opts) => { reloads.push(opts); if (reload.ok) routerRows = routerRows.filter((m) => presets.some((p) => p.name === m.name)); return reload; }, ...manager };
  const handle = createModelRoutes({
    servedEmbeddingModels: async () => null,
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    fetchJson: async (url, init) => {
      fetched.push(`${init.method} ${url.replace('http://loader.invalid/api/v1/', '')}`);
      if (url.endsWith('/api/v1/models') && init.method === 'GET' && scanFailure) return {ok:false,status:500,body:{}};
      if (url.endsWith('/api/v1/models') && init.method === 'GET') return { ok: true, status: 200, body: { models: scanFiles() } };
      if (url.endsWith('/sections') && init.method === 'GET') return { ok: true, status: 200, body: { revision: `r${presets.length}`, sections: presets } };
      const m = /sections\/([^?]+)\?baseRevision=r(\d+)$/.exec(url);
      if (m && init.method === 'DELETE' && Number(m[2]) === presets.length) { presets = presets.filter((x) => x.name !== decodeURIComponent(m[1])); return { ok: true, status: 200, body: {} }; }
      return { ok: false, status: 409, body: {} };
    },
    idleUnload: createIdleUnloadSetting({env:{}}),
    env: { MODEL_LOADER_URL: 'http://loader.invalid', RERANK_MODEL: 'tiny-reranker' }, modelManager,
    getProvider: () => ({}), providerHeaders: () => ({}), DEFAULT_PROVIDER_ID: 'default',
    createVisionProbe: () => async () => ({ supported: true }),
    missingRoles: () => null, currentWorkspace: () => ({ userId: 'u1' }),
    service: { modelScanCache: cache, refreshModelScan: () => {}, autoRoles: () => null, setAutoRoles: () => {}, ensureRolesLoaded: () => {},
      servedCatalogue: async () => [], modelsInstalled: async () => { listedAt.push(cache.has('models')); if(unreachable)throw Error('synthetic unavailable'); return routerRows; }, deriveUserModelName: (c) => c,
      lastLoadedModel: () => null, clearLastLoadedModel: () => {}, clearRoleReferences: () => [] },
  });
  const call = async (method, p, body, role = 'admin', rawText) => {
    const req = Readable.from(rawText !== undefined ? [Buffer.from(rawText)] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    await handle(req, { setHeader() {} }, { path: p, authn: { user: { id: 'u1', role } }, url: new URL('http://localhost' + p) });
    return sent.pop();
  };
  return { call, fetched, reloads, listedAt, presets: () => presets.map((p) => p.name), rows: () => routerRows.map((m) => m.name) };
}

async function main() {
  const output = { idle: [], prune: [], gates: [], malformed: [] };
  const defaults = { seconds:1800,source:'default',fallbackSeconds:1800,fallbackSource:'default',preset:'written' };
  const idleCases = [
    ...[{},null,[],{seconds:true},{seconds:'300'},{seconds:299},{seconds:86401},{seconds:1.5}].map((body,i)=>({name:`invalid-${i}`,body})),
    ...[0,300,86400,null].map(seconds=>({name:`valid-${seconds}`,body:{seconds}})),
    ...[404,405,400,503,500].map(status=>({name:`loader-${status}`,body:{seconds:900},status})),
    {name:'unreachable',body:{seconds:900},status:0},
    {name:'unexpected',body:{seconds:900},unexpected:true},
    {name:'busy',body:{seconds:900},busy:true},
    {name:'preset-failed',body:{seconds:900},preset:'failed'},
    {name:'pending',body:{seconds:900},pending:true},
    {name:'applied-mismatch',body:{seconds:900},mismatch:true},
    {name:'ignored-deep',rawBody:'{"seconds":900,"ignored":'+ '['.repeat(512)+'0'+']'.repeat(512)+'}'},
    {name:'ignored-overflow',rawBody:'{"seconds":900,"ignored":1e400}'},
    {name:'ignored-surrogate',rawBody:'{"seconds":900,"ignored":"\\ud800"}'},
    {name:'ignored-private-use',rawBody:JSON.stringify({seconds:900,ignored:String.fromCodePoint(0x100000)})},
  ];
  for (const spec of idleCases) {
    let chosen=1800;
    const calls=[];
    const setting=createIdleUnloadSetting({env:{MODEL_LOADER_URL:'http://loader.invalid'},
      fetchJson:async (_url,init)=>{
        calls.push(init.method);
        if(spec.status===0)throw Error('synthetic');
        if(init.method==='PUT')chosen=JSON.parse(init.body).seconds ?? 1800;
        const status=spec.status||200;
        return {ok:status>=200&&status<300,status,body:spec.unexpected?{}:{...defaults,seconds:chosen,source:init.method==='PUT'&&JSON.parse(init.body).seconds!==null?'setting':'default',preset:spec.preset||'written'}};
      },
      writePresets:async (write,reloadIf)=>{if(spec.busy)throw Object.assign(Error('busy'),{holdRefused:true});const written=await write();return {written,reload:reloadIf(written)?{ok:!spec.pending,body:{loaded:['active',7]}}:null};},
      presetsInRouter:async()=>`[*]\nsleep-idle-seconds = ${spec.mismatch?300:chosen}\n`,
    });
    let status=200,body;
    try{body=await setting.save(spec.rawBody===undefined?spec.body:JSON.parse(spec.rawBody),'synthetic');}
    catch(e){status=e.status||500;body={error:e.status?e.message:'Could not change the idle unload time',...(e.errorId?{errorId:e.errorId}:{}),...(e.minSeconds?{minSeconds:e.minSeconds,maxSeconds:e.maxSeconds}:{})};}
    output.idle.push({spec,status,body,calls});
  }
  const specs=[
    {name:'engine-unreachable',unreachable:true,installed:[{name:'ok'}],sections:[]},
    {name:'scan-failure',scanFailure:true,installed:[{name:'ok'}],sections:[]},
    {name:'none',installed:[{name:'ok'}],sections:[{name:'ok',hasFile:true}]},
    {name:'empty',installed:[{name:'gone',missingFile:true}],sections:[{name:'gone',hasFile:false}],scan:[]},
    {name:'majority',installed:[{name:'gone',missingFile:true},{name:'gone2',missingFile:true},{name:'ok'}],sections:[]},
    {name:'success',installed:[{name:'gone',missingFile:true},{name:'ok'}],sections:[{name:'gone',hasFile:false},{name:'ok',hasFile:true}]},
    {name:'kept',installed:[{name:'gone',missingFile:true},{name:'ok'}],sections:[{name:'gone',hasFile:true},{name:'ok',hasFile:true}]},
    {name:'busy',installed:[{name:'gone',missingFile:true},{name:'ok'}],sections:[{name:'gone',hasFile:false},{name:'ok',hasFile:true}],busy:true},
    {name:'pending',installed:[{name:'gone',missingFile:true},{name:'ok'}],sections:[{name:'gone',hasFile:false},{name:'ok',hasFile:true}],pending:true},
    {name:'protected',installed:[{name:'laya',missingFile:true,system:true},{name:'elsewhere',servedElsewhere:true,missingFile:true},{name:'other',source:'remote',missingFile:true},{name:'ok'}],sections:[]},
  ];
  for(const spec of specs){
    const f=routes({...spec,reload:{ok:!spec.pending},manager:spec.busy?{writePresets:async()=>{throw Object.assign(Error('busy'),{holdRefused:true});}}:{}});
    output.prune.push({spec,...await f.call('POST','/api/models/prune-missing')});
  }
  const {gate,csrfValid,digest}=require('./model-write-auth-gate.cjs');
  const {unauthorized}=require('../../server/http.cjs');
  for(const [method,path] of [['PUT','/api/models/idle-unload'],['POST','/api/models/prune-missing']]){
    for(const spec of [{role:'none',csrf:true},{role:'member',csrf:true},{role:'admin',csrf:false},{role:'admin',csrf:true,origin:'http://wrong.invalid'}]){
      let result=null;
      const req={method,headers:{cookie:'cowork_csrf=csrf',...(spec.csrf?{'x-csrf-token':'csrf'}:{})}};
      const res={writeHead(status){result={status};},end(body){result.body=JSON.parse(body);}};
      const authn=spec.role==='none'?null:{legacy:false,user:{id:'u1',role:spec.role},session:{csrf_hash:digest('csrf')}};
      gate(req,res,path,{authenticate:()=>authn,csrfValid},{originValid:()=>!spec.origin},new Set(),unauthorized,(_res,status,body)=>{result={status,body};});
      if(!result){const f=routes({installed:[],sections:[]});result=await f.call(method,path,{},spec.role);}
      output.gates.push({method,path,spec,...result});
    }
    const f=routes({installed:[{name:'ok'}],sections:[{name:'ok',hasFile:true}]});
    for(const rawText of ['{','',' ']){
      const result=await f.call(method,path,{},'admin',rawText);
      output.malformed.push({method,path,rawText,...result});
    }
  }
  fs.writeFileSync(process.argv[2],JSON.stringify(output,null,2)+'\n');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
