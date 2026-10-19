'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const native=require('./completeness-report.cjs');
const old=require('../tests/reference/completeness-report-oracle.cjs');
const {executePolicy}=require('./completeness-policy-host.cjs');
function capture(fn){try{return {value:fn()};}catch(error){return {error:{name:error.name,message:error.message,status:error.status,reason:error.reason}};}}
function quiet(fn){const warn=console.warn;console.warn=()=>{};try{return fn();}finally{console.warn=warn;}}
// Compare graph/own-property shape without executing report evidence getters again or
// requiring separately constructed oracle factories to share function identities.
function sourceReferences(value,refs=new Map(),path='input'){
  if(!value||!['object','function'].includes(typeof value)||refs.has(value))return refs;
  refs.set(value,path);
  // A test must not trigger an opaque Proxy trap merely to label evidence references.
  if(require('node:util').types.isProxy(value))return refs;
  for(const key of Reflect.ownKeys(value)){
    const d=Object.getOwnPropertyDescriptor(value,key),next=path+'.'+String(key);
    if(Object.hasOwn(d,'value'))sourceReferences(d.value,refs,next);
    else{sourceReferences(d.get,refs,next+'.get');sourceReferences(d.set,refs,next+'.set');}
  }
  return refs;
}
function graph(value,seen=new Map(),sources=new Map()){
  if(sources.has(value))return {$source:sources.get(value)};
  if(typeof value==='function')return {$function:Object.getOwnPropertyDescriptor(value,'name')?.value||''};
  if(!value||typeof value!=='object')return value;
  if(seen.has(value))return {$reference:seen.get(value)};
  const id=seen.size;seen.set(value,id);const properties=[];
  for(const key of Reflect.ownKeys(value)){
    const d=Object.getOwnPropertyDescriptor(value,key);
    properties.push([key,{enumerable:d.enumerable,configurable:d.configurable,...(Object.hasOwn(d,'value')?{writable:d.writable,value:graph(d.value,seen,sources)}:{get:!!d.get,set:!!d.set})}]);
  }
  return {$id:id,array:Array.isArray(value),properties};
}
function compare(factory,label){
  const run=(implementation)=>{const {input,trace=[],verify}=factory(implementation);const result=capture(()=>implementation.buildCompletenessReport(input));if(result.value&&verify)verify(result.value,input);const recordedTrace=[...trace],sources=sourceReferences(input);return {result:graph(result,new Map(),sources),trace:graph(recordedTrace,new Map(),sources)};};
  assert.deepStrictEqual(quiet(()=>run(native)),quiet(()=>run(old)),label);
}
function job(){return {id:'synthetic',steps:[{id:'tests',status:'completed'}],artifacts:[{name:'qa.diff',kind:'test-report',passed:true}],plan:{status:'proposed'},uncertain:[],pendingApproval:null,checkpoint:{sha:'a'.repeat(40)}};}
function sequence(trace,name,values){let n=0;return ()=>{trace.push(`${name}:${n}`);const value=values[Math.min(n++,values.length-1)];if(value instanceof Error)throw value;return value;};}
test('Rust metadata is the read model and production exports no JS report policy',()=>{
  assert.equal(Object.hasOwn(native,'buildCompletenessReportJs'),false);
  assert.deepStrictEqual(native.CHECK_NAMES,old.CHECK_NAMES);
  assert.deepStrictEqual([...native.TEST_STEP_IDS],[...old.TEST_STEP_IDS]);
  assert.equal(native.TEST_ARTIFACT_KIND,old.TEST_ARTIFACT_KIND);
});
test('opaque cyclic/BigInt/large and strict legacy refusal inputs keep their full useful reports and raw evidence',()=>{
  const huge='x'.repeat(8*1024*1024+128);
  const factories=[
    ()=>{const j=job();j.extra=huge;return {input:{job:j,expectedArtifacts:['qa.diff']}};},
    ()=>{const j=job();j.extra=1n;return {input:{job:j}};},
    ()=>{const j=job();j.self=j;return {input:{job:j}};},
    ()=>{const j=job();j.steps[0].self=j.steps[0];return {input:{job:j}};},
    ()=>{const j=job();j.steps.push({id:1n,status:'running'});return {input:{job:j}};},
    ()=>({input:{job:job(),expectedArtifacts:[huge]}}),
    ()=>({input:{job:{...job(),uncertain:'opaque'}}}),
    ()=>({input:{job:{...job(),uncertain:{length:1n}}}}),
    ()=>({input:{job:{...job(),uncertain:{length:{toString(){return 'one';}}}}}}),
    ()=>({input:{job:job(),expectedArtifacts:'qa.diff'}}),
    ()=>({input:{job:job(),expectedArtifacts:[null,undefined,7,{},['missing']]}}),
    ()=>{const j=job();j.plan.self=j.plan;j.checkpoint.self=j.checkpoint;return {input:{job:j}};},
    ()=>{const j=job();j.steps.push({id:'duplicate',status:'completed'},{id:'duplicate',status:'completed'});j.artifacts.push({...j.artifacts[0]});return {input:{job:j},verify(report){assert.strictEqual(report.checks[2].evidence.steps,j.steps);assert.strictEqual(report.checks[2].evidence.plan,j.plan);assert.strictEqual(report.checks[4].evidence.checkpoint,j.checkpoint);assert.strictEqual(report.checks[0].evidence.steps[0],j.steps[0]);assert.strictEqual(report.checks[0].evidence.artifacts[0],j.artifacts[0]);assert.strictEqual(report.checks[0].evidence.artifacts[1],j.artifacts[1]);assert.notStrictEqual(report.checks[0].evidence.artifacts[0],report.checks[0].evidence.artifacts[1]);}};},
  ];
  for(const make of factories)compare(make,'opaque reference report');
});
test('custom collection methods and iterators remain mechanical, including callback returns and ordering',()=>{
  compare(()=>{
    const trace=[],first={id:'tests',status:'completed'},second={id:'other',status:'running'};
    const steps={length:2,filter(callback){trace.push('steps.filter');return [first,second].filter((value)=>{const answer=callback(value);trace.push(['step.callback',answer]);return answer;});}};
    const artifacts={filter(callback){trace.push('artifacts.filter');const values=[null,0,{name:'qa.diff',kind:'test-report',passed:true}];return values.filter(value=>{const answer=callback(value);trace.push(['artifact.callback',answer]);return answer;});},map(callback){trace.push('artifacts.map');return [null,{name:'qa.diff'}].map(callback);}};
    const expected={*[Symbol.iterator](){trace.push('iterator.start');yield 'qa.diff';trace.push('iterator.middle');yield 'missing';trace.push('iterator.end');}};
    return {input:{job:{...job(),steps,artifacts},expectedArtifacts:expected},trace,verify(report){assert.strictEqual(report.checks[2].evidence.steps,steps);assert.strictEqual(report.checks[0].evidence.steps[0],first);assert.strictEqual(report.checks[2].evidence.open[0],second);}};
  },'custom methods, truthy callback values and iterable');
  compare(()=>{
    const trace=[],length=sequence(trace,'uncertain.length',[1,0,9]);
    return {input:{job:{...job(),uncertain:{get length(){return length();}}}},trace};
  },'changing uncertainty length retains empty detail parts and evidence reread');
});
test('getter and coercion traces preserve first-failure order and exact detail values',()=>{
  compare(()=>{
    const trace=[],id={toString(){trace.push('id.toString');return 'raw-id';}},status={toString(){trace.push('status.toString');return 'raw-status';}};
    const step={get id(){trace.push('step.id');return id;},get status(){trace.push('step.status');return status;}};
    return {input:{job:{...job(),steps:[step]}},trace};
  },'open-step id coercion precedes status getter');
  for(const values of [['abcdef0','abcdef0',1234567],['abcdef0','abcdef0',1n],['abcdef0','abcdef0',Symbol('sha')],['abcdef0',new TypeError('second sha getter')]]){
    compare(()=>{const trace=[],sha=sequence(trace,'sha',values);return {input:{job:{...job(),checkpoint:{get sha(){return sha();}}}},trace};},'checkpoint lazy re-read and coercion');
  }
  compare(()=>{const trace=[],j=job();return {input:{get job(){trace.push('input.job');return j;},get expectedArtifacts(){trace.push('input.expected');return ['qa.diff'];}},trace};},'input destructuring and legacy confirmation re-reads');
  compare(()=>({input:{get job(){return null;},get expectedArtifacts(){throw new TypeError('expected getter before job validation');}}}),'destructuring before validation');
  compare(()=>{const j=job();Object.defineProperty(j,'artifacts',{get(){throw new TypeError('first check getter');}});j.checkpoint={self:null};j.checkpoint.self=j.checkpoint;return {input:{job:j}};},'first check error precedes later opaque evidence');
});
test('reentrant raw getters use independent invocation continuations',()=>{
  compare((implementation)=>{
    const trace=[],j=job();let count=0;
    Object.defineProperty(j,'steps',{enumerable:true,get(){trace.push('outer.steps');if(count++===0){const inner=implementation.buildCompletenessReport({job:{}});trace.push(['inner',inner.overall]);}return [{id:'tests',status:'completed'}];}});
    return {input:{job:j},trace};
  },'nested report does not corrupt outer state/registers');
});
test('invalid input retains old exception classes and messages instead of making a fabricated report',()=>{
  for(const make of [()=>null,()=>({job:null}),()=>({job:'x'}),()=>({job:{steps:1}}),()=>({job:{steps:[null]}}),()=>({job:{artifacts:1}}),()=>({job:{},expectedArtifacts:1})]){
    compare(()=>({input:make()}),'original input error');
  }
});
test('review guard remains raw-reference/lazy and Rust-owned',()=>{
  const run=(implementation,make)=>{const {report,trace=[]}=make();return {result:capture(()=>implementation.canEnterReviewing(report)),trace};};
  const cases=[()=>({report:null}),()=>({report:{checks:[]}}),()=>({report:{checks:[{status:'pass'}]}}),()=>({report:{unverified:null,checks:[{status:'pass'}]}}),()=>({report:{checks:[{status:'fail'}]}}),()=>({report:{checks:Array(3)}}),()=>{
    const trace=[],checks=sequence(trace,'checks',[[{status:'pass'}],[{status:'pass'}],{every(callback){trace.push('custom.every');assert.equal(callback({status:'pass'}),true);return 'raw-accepted';}}]);
    return {report:{get checks(){return checks();}},trace};
  }];
  for(const make of cases)assert.deepStrictEqual(run(native,make),run(old,make));
});
test('malformed/native-policy replies fail closed without a JS business fallback',()=>{
  for(const reply of [null,{},[],{request:{operation:'unknown'},continuation:{program:0,pc:1,destination:0,registers:Array(32).fill(null)}},{done:{ref:999999}}]){
    assert.throws(()=>executePolicy({completenessPolicy(){return reply;}},0,[{job:job()}]),{reason:'reply'});
  }
});

test('custom collection failures retain exact original native TypeError text',()=>{
  const factories=[
    ()=>({job:{...job(),steps:{filter:0}}}),
    ()=>({job:{...job(),steps:{filter(){return {length:1,some:null};}}}}),
    ()=>({job:{...job(),artifacts:{filter(){return {length:1,some:null};}}}}),
    ()=>({job:{...job(),artifacts:{filter(){return [];},map(){return {};}}}}),
    ()=>{let n=0;return {job:{...job(),steps:{length:1,filter(){return n++?{length:1,map:null}:[];}}}};},
    ()=>{let n=0;return {job:{...job(),steps:{length:1,filter(){return n++?{length:1,map(){return {};}}:[];}}}};},
  ];
  for(const make of factories)compare(()=>({input:make()}),'custom collection failure');
});

test('read traces preserve changing collection getters and length coercion before map',()=>{
  compare(()=>{const trace=[],steps=sequence(trace,'job.steps',[[{id:'tests',status:'completed'}],[{id:'other',status:'running'}],[]]);return {input:{job:{...job(),get steps(){return steps();}}},trace};},'changing job.steps');
  compare(()=>{
    const trace=[];let first=true,coerced=false;
    const length=sequence(trace,'open.length',[1,{toString(){trace.push('length.toString');coerced=true;return 'one';}}]);
    const open={get length(){return length();},get map(){trace.push('open.map');assert.equal(coerced,true,'length converted before map getter');return ()=>['synthetic'];}};
    const steps={length:1,filter(){trace.push('steps.filter');if(first){first=false;return [];}return open;}};
    return {input:{job:{...job(),steps}},trace,verify(report){assert.strictEqual(report.checks[2].evidence.open,open);}};
  },'open length ToString precedes map lookup');
});
test('incremental requests have bounded frames and linear callback work without prefix replay',()=>{
  const wasm=require('./dav-parse-wasm.cjs'),original=wasm.completenessPolicy;
  function measure(count){let calls=0,maxFrame=0;wasm.completenessPolicy=(frame)=>{calls++;maxFrame=Math.max(maxFrame,Buffer.byteLength(JSON.stringify(frame)));return original(frame);};
    try{const steps=Array.from({length:count},(_,i)=>({id:i===0?'tests':'other',status:'completed'}));const report=native.buildCompletenessReport({job:{...job(),steps},expectedArtifacts:['qa.diff']});assert.equal(report.overall,'pass');return {calls,maxFrame};}finally{wasm.completenessPolicy=original;}}
  const small=measure(64),large=measure(128);assert.ok(large.calls>small.calls);assert.ok(large.calls<small.calls*2.1,'no repeated prefix/history work');assert.ok(large.maxFrame<=64*1024);assert.ok(small.maxFrame<=64*1024);
});

test('runtime malformed policy cannot fabricate a report or revive legacy JS authority',()=>{
  const wasm=require('./dav-parse-wasm.cjs'),real=wasm.completenessPolicy;
  for(const reply of [null,{}, {done:{ref:0}}, {request:{operation:'literal',value:true},continuation:{program:0,pc:0,destination:0,registers:Array(32).fill(null)}}]){
    wasm.completenessPolicy=()=>reply;
    try{assert.throws(()=>native.buildCompletenessReport({job:job()}),{status:502,reason:'reply'});}
    finally{wasm.completenessPolicy=real;}
  }
  assert.throws(()=>wasm.completenessPolicy({oversized:'x'.repeat(64*1024)}),{reason:'too_large'});
});
