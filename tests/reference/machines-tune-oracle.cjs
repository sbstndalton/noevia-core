'use strict';
const {createMachineTune}=require('./machine-tune.node.cjs');
(async()=>{
 const rows=new Map(),requests=[];
 const target={role:'fast',service:'chatFast',machine:{id:'synthetic-machine',name:'Synthetic',address:'http://127.0.0.1'},port:9999,model:'synthetic-model',baseUrl:'http://127.0.0.1:9999'};
 const tune=createMachineTune({machines:{chatTarget:()=>target,machine:()=>target.machine},store:{get:k=>rows.get(k),set:(k,v)=>rows.set(k,v)},now:()=>1800000000000,log:()=>{},chatMachines:{busy:()=>false,ready:async()=>({ok:true}),onTurn:()=>()=>{},fetch:async(url,options)=>{requests.push({path:new URL(url).pathname,method:options.method,body:options.body?JSON.parse(options.body):null});return new Response(JSON.stringify(url.includes('/props')?{default_generation_settings:{n_ctx:8192}}:{timings:{predicted_per_second:40,prompt_per_second:20,prompt_n:4096,draft_n:10,draft_n_accepted:4},usage:{completion_tokens:10}}),{status:200,headers:{'content-type':'application/json'}});}}});
 const start=await tune.start({service:'chatFast',confirm:true,actor:'synthetic-admin'});start.id='<run>';start.startedAt='<time>';await tune.settled();
 const result=tune.resultFor('synthetic-machine','synthetic-model');delete result.measuredAt;
 for(const request of requests)if(request.body?.messages)request.body.messages[0].content=request.body.messages[0].content.replace(/^Measurement [^.]+\./,'Measurement <run>.');
 process.stdout.write(JSON.stringify({start,result,requests},null,2)+'\n');
})().catch(e=>{console.error(e);process.exitCode=1;});
