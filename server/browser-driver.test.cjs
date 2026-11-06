'use strict';
const{test}=require('node:test');const assert=require('node:assert/strict');const{EventEmitter}=require('node:events');const{PassThrough}=require('node:stream');const{createDriver,serve}=require('./browser-driver.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function fixture(){
 const calls=[],events=[],requests=[];let route,websocket;
 const element={evaluate:async(fn)=>fn.toString().includes('isConnected')?true:fn.toString().includes('activeElement')?true:{tag:'button',text:'Send',frameOrigin:'https://synthetic.invalid'},dispose:async()=>calls.push('dispose')};
 for(const name of ['click','hover','fill','selectOption','press','setInputFiles'])element[name]=async(...args)=>{calls.push([name,...args]);};
 const page=Object.assign(new EventEmitter(),{isClosed:()=>false,url:()=> 'https://synthetic.invalid/path',locator:()=>({first:()=>({elementHandle:async()=>element,innerText:async()=> 'synthetic text'}),innerText:async()=> 'synthetic text'}),evaluateHandle:async()=>element,screenshot:async()=>Buffer.from('synthetic png'),goto:async(...a)=>calls.push(['goto',...a]),goBack:async()=>calls.push('back'),keyboard:{press:async(...a)=>calls.push(['keyboard',...a])},mouse:{wheel:async(...a)=>calls.push(['wheel',...a])},waitForTimeout:async(...a)=>calls.push(['wait',...a]),waitForLoadState:async()=>{}});
 const context=Object.assign(new EventEmitter(),{route:async(pattern,cb)=>{route=cb;},routeWebSocket:async(pattern,cb)=>{websocket=cb;},newPage:async()=>{context.emit('page',page);return page;},pages:()=>[page],close:async()=>calls.push('context.close')});
 const browser={newContext:async options=>{calls.push(['context',options]);return context;},close:async()=>calls.push('browser.close')};
 const driver=createDriver({launch:async()=>browser,request:async(method,params)=>{requests.push([method,params]);return {allow:params.url.includes('synthetic.invalid')};},notify:(...args)=>events.push(args)});
 return{calls,events,requests,driver,browser,context,page,element,route:()=>route,websocket:()=>websocket};
}
test('private driver exposes only fixed primitives and real DOM handles',async()=>{
 const f=fixture(),d=f.driver;await d('launch');await d('context',{proxy:{server:'http://synthetic.invalid',username:'task',password:'synthetic-token'}});const{page}=await d('page');const{element}=await d('inspect',{selector:'#send'});
 assert.equal((await d('recheck',{page,element,focus:true})).connected,true);
 for(const kind of ['navigate','click','hover','type','select','press','upload','submit','scroll','wait'])await d('dispatch',{page,element,kind,url:'https://synthetic.invalid',text:'synthetic',values:'one',key:'Enter',files:[],dy:600,ms:500});
 assert.equal((await d('extract',{page})).text,'synthetic text');assert.equal((await d('screenshot',{page})).png,Buffer.from('synthetic png').toString('base64'));
 assert.ok(f.calls.some(v=>Array.isArray(v)&&v[0]==='fill'));await assert.rejects(d('evaluate',{script:'bad'}));await assert.rejects(d('start'));await assert.rejects(d('approve'));
 await d('dispose',{element});await assert.rejects(d('recheck',{page,element}));await d('closeContext');assert.deepEqual(await d('close'),{confirmed:true});
});
test('every HTTP and websocket request waits for the native policy answer',async()=>{
 const f=fixture();await f.driver('launch');await f.driver('context');await f.driver('page');
 for(const url of ['https://synthetic.invalid/a','https://blocked.invalid/a']){
  let continued=false,aborted=false;await f.route()({request:()=>({url:()=>url,isNavigationRequest:()=>false}),continue:async()=>{continued=true;},abort:async()=>{aborted=true;}});assert.equal(continued,url.includes('synthetic.invalid'));assert.equal(aborted,!continued);
  let connected=false,closed=false;await f.websocket()({url:()=>url,connectToServer:()=>{connected=true;},close:()=>{closed=true;}});assert.equal(connected,url.includes('synthetic.invalid'));assert.equal(closed,!connected);
 }
 assert.equal(f.requests.length,4);await f.driver('close');
});
test('close retains an in-flight engine creation until its actual close receipt',async()=>{
 const launch=deferred(),created=deferred();let closed=0;
 const d=createDriver({launch:()=>launch.promise,request:async()=>({allow:false})});const opening=d('launch');const closing=d('close');launch.resolve({close:async()=>{closed++;}});await opening;await closing;assert.equal(closed,1);
 const f=fixture();f.browser.newContext=()=>created.promise;await f.driver('launch');const ctx=f.driver('context');const close=f.driver('close');created.resolve(f.context);await ctx;await close;assert.ok(f.calls.includes('browser.close'));
});
test('stdio protocol multiplexes native callbacks and hides reflected engine errors',async()=>{
 const input=new PassThrough(),output=new PassThrough();const lines=[];let buffer='';output.on('data',data=>{buffer+=data;while(buffer.includes('\n')){const n=buffer.indexOf('\n');lines.push(JSON.parse(buffer.slice(0,n)));buffer=buffer.slice(n+1);}});
 const f=fixture();f.browser.newContext=async()=>{throw Error('reflected synthetic-token');};const done=serve({input,output,launch:async()=>f.browser});
 input.write(JSON.stringify({id:1,method:'launch'})+'\n');await new Promise(setImmediate);input.write(JSON.stringify({id:2,method:'context'})+'\n');await new Promise(setImmediate);
 assert.deepEqual(lines.find(r=>r.id===2),{id:2,error:{code:'engine_failure'}});assert.ok(!JSON.stringify(lines).includes('synthetic-token'));input.end();await done;assert.ok(f.calls.includes('browser.close'));
});
