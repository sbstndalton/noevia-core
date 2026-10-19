
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const modulePath=process.env.NOEVIA_KV_CANDIDATE_MODULE || path.join(__dirname,'llamacpp-autoconfig.cjs');
const ac=require(modulePath),host=require(path.join(path.dirname(modulePath),'llamacpp-autoconfig-host.cjs'));
const wasm=require(path.join(path.dirname(modulePath),'dav-parse-wasm.cjs'));
const old=require(process.env.NOEVIA_FROZEN_CORE_ROOT ? path.join(process.env.NOEVIA_FROZEN_CORE_ROOT,'server/llamacpp-autoconfig.cjs') : '../tests/reference/llamacpp-autoconfig-js.cjs');
const bits=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex');};
function nativeMode(values){const counts=new Map();for(const value of values)counts.set(value,(counts.get(value)||0)+1);return [...counts].sort((a,b)=>b[1]-a[1])[0][0];}
function directMode(values){
  const counts={},frames=[];
  const outcome=host.invokeOutcome('kvHeadsOf',[values,77],()=>({llamacppAutoconfig(op,args){
    if(op===12 && args.state.sum?.kind==='heads'){
      assert.ok(args.state.sum.bins.length<=128);
      frames.push(JSON.stringify(args).length);
    }
    const result=wasm.llamacppAutoconfig(op,args);
    for(const operation of result.reply.batch || [])counts[operation.request.op]=(counts[operation.request.op]||0)+1;
    return result;
  }}));
  assert.equal(outcome.fault,undefined);return {value:outcome.value,counts,frames};
}
test('numeric mode uses Rust SameValueZero keys and stable insertion ties with bit-preserving results',()=>{
  const nan=Buffer.from('7ff8000000000001','hex').readDoubleBE();
  for(const values of [[2,3,3,2],[3,2,2,3],[-0,0,2],[nan,NaN,4],[Infinity,-Infinity,-Infinity,Infinity],[4,8,4,8,8]]){
    const result=directMode(values);
    assert.equal(bits(result.value),bits(nativeMode(values)));
    assert.ok(result.counts.numberChunk>0);
    assert.equal(result.counts.iterator,undefined,'pure dense mode must avoid the original VM iterator');
    const meta={blockCount:4,headCount:4,embeddingLength:16,headCountKv:values};
    assert.ok(Object.is(ac.kvCacheBytes(meta,4),old.kvCacheBytes(meta,4)));
  }
});
test('numeric mode consumes unbounded total input in fixed chunks and falls back at distinct-register overflow',()=>{
  for(const values of [Array.from({length:10000},(_,i)=>i%4+1),Array.from({length:129},(_,i)=>i+1).concat([129,129])]){
    const result=directMode(values);
    assert.equal(bits(result.value),bits(nativeMode(values)));
    assert.ok(result.frames.length>0);
    assert.ok(Math.max(...result.frames)<16384,'continuation remains fixed and bounded');
    if(values.length===10000){assert.equal(result.counts.iterator,undefined);assert.ok(result.counts.numberChunk>=79);}
    else assert.equal(result.counts.iterator,1,'capacity overflow is the original full VM, not input rejection');
  }
});
test('a changed globalThis alias cannot redirect current evaluator intrinsic eligibility',()=>{
  ac.kvCacheBytes({blockCount:4,headCount:4,embeddingLength:16,headCountKv:[2,3,3]},4);
  const original=globalThis,descriptor=Object.getOwnPropertyDescriptor(original,'globalThis');
  let reads=0;
  const fake=Object.create(null);Object.defineProperty(fake,'Map',{get(){reads++;throw new Error('wrong global alias');}});
  Object.defineProperty(original,'globalThis',{configurable:true,writable:true,value:fake});
  let result;
  try{result=directMode([2,3,3]);}finally{Object.defineProperty(original,'globalThis',descriptor);}
  assert.equal(result.value,3);assert.equal(reads,0);
});


test('numeric eligibility preserves current constructor/method/accessor/Proxy hooks through exact fallback',()=>{
  const originalGlobal=globalThis,ArrayCtor=Array,MapCtor=Map,apply=Reflect.apply,construct=Reflect.construct;
  const own=Object.getOwnPropertyDescriptor,define=Object.defineProperty,push=Array.prototype.push;
  const arrayIterator=Array.prototype[Symbol.iterator],mapIterator=Map.prototype[Symbol.iterator];
  const arrayCursorPrototype=Object.getPrototypeOf(apply(arrayIterator,[],[]));
  const mapCursorPrototype=Object.getPrototypeOf(apply(mapIterator,new MapCtor(),[]));
  const cases=[
    ['global Array getter',(hook,log)=>hook(originalGlobal,'Array',{get(){log('global Array');return ArrayCtor;}})],
    ['global Map Proxy constructor',(hook,log)=>hook(originalGlobal,'Map',{value:new Proxy(MapCtor,{construct(target,args,newTarget){log('Map construct');return construct(target,args,newTarget);}}),writable:true})],
    ['global Array Proxy lookup',(hook,log)=>hook(originalGlobal,'Array',{value:new Proxy(ArrayCtor,{get(target,key,receiver){log('Array get '+String(key));return Reflect.get(target,key,receiver);}}),writable:true})],
    ['Map get accessor',(hook,log)=>{const fn=MapCtor.prototype.get;hook(MapCtor.prototype,'get',{get(){log('Map get accessor');return fn;}});}],
    ['Map set Proxy',(hook,log)=>{const fn=MapCtor.prototype.set;hook(MapCtor.prototype,'set',{value:new Proxy(fn,{apply(target,receiver,args){log('Map set Proxy');return apply(target,receiver,args);}}),writable:true});}],
    ['Map iterator accessor',(hook,log)=>hook(MapCtor.prototype,Symbol.iterator,{get(){log('Map iterator accessor');return mapIterator;}})],
    ['Map entries accessor',(hook,log)=>{const fn=MapCtor.prototype.entries;hook(MapCtor.prototype,'entries',{get(){log('unused entries accessor');return fn;}});}],
    ['Array sort accessor',(hook,log)=>{const fn=ArrayCtor.prototype.sort;hook(ArrayCtor.prototype,'sort',{get(){log('Array sort accessor');return fn;}});}],
    ['Array iterator accessor',(hook,log)=>hook(ArrayCtor.prototype,Symbol.iterator,{get(){log('Array iterator accessor');return arrayIterator;}})],
    ['Array values accessor',(hook,log)=>{const fn=ArrayCtor.prototype.values;hook(ArrayCtor.prototype,'values',{get(){log('unused values accessor');return fn;}});}],
    ['Map iterator next accessor',(hook,log)=>{const fn=mapCursorPrototype.next;hook(mapCursorPrototype,'next',{get(){log('Map iterator next accessor');return fn;}});}],
    ['Array iterator next Proxy',(hook,log)=>{const fn=arrayCursorPrototype.next;hook(arrayCursorPrototype,'next',{value:new Proxy(fn,{apply(target,receiver,args){log('Array iterator next Proxy');return apply(target,receiver,args);}}),writable:true});}],
  ];
  const run=(api,change)=>{
    const trace=[],restore=[];
    const log=value=>apply(push,trace,[value]);
    const hook=(object,key,descriptor)=>{apply(push,restore,[{object,key,before:own(object,key)}]);define(object,key,{configurable:true,enumerable:own(object,key)?.enumerable||false,...descriptor});};
    const meta={blockCount:4,headCount:4,embeddingLength:16,headCountKv:[2,3,3]};
    let value,error;
    try{change(hook,log);value=api.kvCacheBytes(meta,4);}
    catch(thrown){error={name:thrown.name,message:thrown.message};}
    finally{for(let i=restore.length-1;i>=0;i--){const item=restore[i];define(item.object,item.key,item.before);}}
    return {value,error,trace};
  };
  for(const [name,change] of cases)assert.deepEqual(run(ac,change),run(old,change),name);
});

