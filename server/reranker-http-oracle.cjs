'use strict';
// Run against the base checkout: Node's actual auth, CSRF helpers and original model route.
// The small gate is copied from index.cjs; no engines or application startup are invoked.
const path=require('node:path');const {Readable}=require('node:stream');
async function capture(root,dataDir) {
 const load=p=>require(path.join(root,'server',p));
 const {createAuth,digest}=load('auth.cjs');const {createRequestAuth}=load('device-auth.cjs');
 const {readJson,readBody,unauthorized}=load('http.cjs');
 const auth=createAuth({dataDir,publicOrigin:'http://synthetic.invalid',rpId:'synthetic.invalid'});
 const db=new (load('node_modules/better-sqlite3'))(path.join(dataDir,'cowork.db'));
 const now=Date.now();
 for(const [id,role,token] of [['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','admin','admin-token'],['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','member','member-token']]) {
  db.prepare("INSERT OR IGNORE INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,'Synthetic',?,'x',?,1,1)").run(id,id,id,role,id);
  db.prepare("INSERT OR REPLACE INTO sessions(id_hash,user_id,csrf_hash,created_at,last_seen_at,expires_at,user_agent,ip) VALUES(?,?,?,?,?,?,'ua','127.0.0.1')").run(digest(token),id,digest('csrf'),now,now,now+86400000);
 }
 const requestAuth=createRequestAuth({enabled:()=>false,deviceAuth:null,authService:auth});
 const inputs=[
  {name:'signed-out',method:'GET',role:null}, {name:'member',method:'GET',role:'member'},
  {name:'csrf',method:'PUT',role:'admin',raw:'{}',csrf:false},
  {name:'get',method:'GET',role:'admin'}, {name:'invalid',method:'PUT',role:'admin',raw:'null'},
  {name:'malformed',method:'PUT',role:'admin',raw:'{'},
  {name:'enable',method:'PUT',role:'admin',raw:'{"enabled":true,"choice":"tei"}'},
  {name:'reset',method:'PUT',role:'admin',raw:'{"reset":true}',seed:{enabled:true,choice:'tei'}},
  {name:'delete',method:'DELETE',role:'admin',seed:{enabled:true,choice:'tei'}},
  {name:'catalogue-unreachable',method:'PUT',role:'admin',raw:'{"enabled":true,"choice":"llamacpp:synthetic"}'},
  {name:'overflow-unused',method:'PUT',role:'admin',raw:'{"enabled":false,"unused":1e999}'},
  {name:'surrogate-unused',method:'PUT',role:'admin',raw:'{"enabled":false,"unused":"\\ud800"}'},
 ];
 const output=[];
 for(const input of inputs) {
  const settings=load('rerank-settings.cjs');const store=new Map(input.seed?[[settings.KEY,JSON.stringify(input.seed)]]:[]);
  const owner=settings.createRerankSettings({store,env:{RERANK_BACKEND:'tei',NOEVIA_FEATURE_RAG_RERANK:'false'}});
  let response;const json=(_res,status,body)=>{response={status,body};};
  const route=load('routes/models.cjs').createModelRoutes({json,readJson,readBody,env:{},modelManager:{},service:{modelScanCache:{clear(){}},modelsInstalled:async()=>{throw Error('synthetic engine unreachable');}},rerankSettings:owner});
  const req=Readable.from(input.raw?[input.raw]:[]);req.method=input.method;req.url='/api/models/reranker';req.socket={remoteAddress:'127.0.0.1'};
  req.headers={origin:'http://synthetic.invalid',...(input.role?{cookie:`cowork_session=${input.role}-token; cowork_csrf=csrf`}:{}),...(input.csrf===false?{}:{'x-csrf-token':'csrf'})};
  const res={writeHead(status){this.status=status;},end(body){response={status:this.status,body:JSON.parse(body)};}};
  const authn=requestAuth.authenticate(req);
  if(!authn) unauthorized(res);
  else if(!['GET','HEAD','OPTIONS'].includes(req.method)&&(!auth.originValid(req)||!requestAuth.csrfValid(req,authn))) json(res,403,{error:'invalid CSRF token'});
  else await route(req,res,{path:req.url,url:new URL(req.url,'http://synthetic.invalid'),authn});
  output.push({...input,...response,stored:store.get(settings.KEY)||null});
 }
 db.close();auth.db.close();return output;
}
module.exports={capture};
if(require.main===module)capture(path.resolve(process.argv[2]),path.resolve(process.argv[3])).then(v=>process.stdout.write(JSON.stringify(v,null,2)+'\n')).catch(e=>{console.error(e);process.exitCode=1;});
