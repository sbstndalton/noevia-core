'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const{createAdmission}=require('./inference-admission-lease.cjs');
test('maintenance and chat share exclusion; only chat uses model budget and load',async()=>{
 let held=0,loads=0,budgets=0;const controller=new AbortController();
 const admit=createAdmission({modelManager:{enterInference(){held++;return()=>{held--;};},async acquireLease(){loads++;budgets++;return{release:async()=>{}};}},admitEngineModel:async()=>{throw Error('unexpected load');}});
 const task=await admit({maintenance:true},controller.signal);assert.equal(held,1);assert.equal(loads,0);assert.equal(budgets,0);
 const chat=await admit({model:'synthetic-model'},new AbortController().signal);assert.equal(held,2);assert.equal(loads,1);assert.equal(budgets,1);
 controller.abort();assert.equal(held,2,'caller cancellation cannot release the effect owner');
 chat.release();assert.equal(held,1);task.release();task.release();assert.equal(held,0);
});
test('maintenance refuses mixed asks, paused gate, absent authority and already-cancelled entry',async()=>{
 let entered=0;const admit=createAdmission({modelManager:{enterInference(){entered++;return()=>{};}},admitEngineModel:async()=>{throw Error('unexpected');}});
 for(const body of [{maintenance:false},{maintenance:true,model:'m'},{maintenance:true,embedding:true},{maintenance:true,diaryExchange:{user:'x'}}])assert.throws(()=>admit(body),e=>e.status===400);
 const cancelled=new AbortController();cancelled.abort();assert.throws(()=>admit({maintenance:true},cancelled.signal));assert.equal(entered,0);
 const missing=createAdmission({modelManager:{},admitEngineModel:async()=>{}});assert.throws(()=>missing({maintenance:true}),e=>e.status===503);
 const paused=createAdmission({modelManager:{enterInference(){throw Object.assign(Error('busy'),{status:503});}},admitEngineModel:async()=>{}});assert.throws(()=>paused({maintenance:true}),e=>e.status===503);
});
