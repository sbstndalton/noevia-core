'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {startProjectStore,syntheticFrontBin}=require('./project-store-server.cjs');
const SERVER=path.resolve(__dirname,'../../server/index.cjs');
for(const entry of ['main','ready','handler']) for(const paired of [false,true]) {
  test(`auto-roles real boot ${entry}: ${paired?'paired':'half-pair refused'}`,{timeout:30000},async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'roles-boot-')),data=path.join(root,'data');fs.mkdirSync(data);
    const store=await startProjectStore(data); if(!paired) store.failNext(404,{error:'not found'},{url:'/v1/auto-roles/proof',times:100});
    const ini=path.join(root,'models.ini');fs.writeFileSync(ini,'version = 1\n');
    const env={PATH:process.env.PATH,NODE_ENV:'test',UI_HOST:'127.0.0.1',UI_PORT:'0',UI_DATA_DIR:data,PUBLIC_ORIGIN:'http://localhost',
      NOEVIA_PROJECT_STORE_PORT:String(store.port),NOEVIA_PROJECT_STORE_TOKEN:store.token,NOEVIA_START_ID:'ab'.repeat(16),NOEVIA_SERVER_BIN:syntheticFrontBin(root),
      INFERENCE_BASE_URL:'http://127.0.0.1:9',MODEL_MANAGER_KIND:'llamacpp',MODEL_MANAGER_BASE_URL:'http://127.0.0.1:9',LLAMACPP_PRESET_PATH:ini,
      MODEL_LOADER_URL:'',MCP_SERVERS:'',DIARY_BASE_URL:'http://127.0.0.1:9',DAV_PARSE_WASM:process.env.DAV_PARSE_WASM,DAV_PARSE_WASM_REQUIRED:process.env.DAV_PARSE_WASM_REQUIRED};
    const code=entry==='ready'?`require(${JSON.stringify(SERVER)}).readyFeatures().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})`:
      `const i=require(${JSON.stringify(SERVER)}),{Readable,Writable}=require('node:stream');const req=Object.assign(Readable.from([]),{url:'/api/unknown',method:'GET',headers:{host:'localhost'},socket:{remoteAddress:'127.0.0.1'}});const res=new Writable({write(c,e,cb){cb()}});res.setHeader=()=>{};res.writeHead=()=>{};i.handleRequest(req,res).then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})`;
    const child=spawn(process.execPath,entry==='main'?[SERVER]:['-e',code],{env,stdio:['ignore','pipe','pipe']});
    let log='';child.stdout.on('data',b=>{log+=b;});child.stderr.on('data',b=>{log+=b;});
    t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await store.close();fs.rmSync(root,{recursive:true,force:true});});
    const outcome=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error(log));},20000);child.once('exit',code=>{clearTimeout(timer);resolve(code);});
      if(entry==='main'&&paired)child.stdout.on('data',()=>{if(log.includes('listening on')){clearTimeout(timer);child.kill('SIGTERM');resolve(0);}});
    });
    // handleRequest maps a startup refusal to 503; it must still log the pairing refusal.
    if(!paired){assert.match(log,entry==='main'?/readiness or initialisation failed/:/Native auto-roles write pairing is required/);if(entry!=='handler')assert.notEqual(outcome,0);}
    else assert.equal(outcome,0,log);
  });
}
