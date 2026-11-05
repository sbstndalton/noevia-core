'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createLeases}=require('./model-maintenance-lease.cjs');
const {createMaintenanceGate}=require('./inference-maintenance.cjs');
const {createSweepGuard}=require('./benchmark-sweep-guard.cjs');
test('cancelled pending ticket survives saturation and elapsed tombstone lifetime',async()=>{
 let resolve,returned=0,now=0;
 const l=createLeases({hold:()=>new Promise(r=>{resolve=r;}),now:()=>now,ticketTombstones:2,ticketTombstoneMs:10});
 const taking=l.acquire(undefined,'a');const refused=assert.rejects(taking,e=>e.status===410);
 l.releaseTicket('a');for(const t of ['b','c','d'])l.releaseTicket(t);now=100;
 resolve(()=>returned++);await refused;assert.equal(returned,1);assert.equal(l.size(),0);
});
test('delayed POST stays cancelled after cancellation retention saturates',async()=>{
 const l=createLeases({hold:()=>()=>{},ticketTombstones:2});
 l.releaseTicket('a');l.releaseTicket('b');l.releaseTicket('c');
 await assert.rejects(l.acquire(undefined,'a'),e=>e.status===410);
 await assert.rejects(l.acquire(undefined,'new'),e=>e.status===503);
});
test('expired front latch transfers to recovery barrier, fresh repair can hold through it',async()=>{
 const gate=createMaintenanceGate();let finish;
 const l=createLeases({hold:()=>gate.holdLocal(),barrier:()=>gate.barrier('recovery',{recovery:true}),ttlMs:10});
 const grant=await l.acquire(undefined,'a');await new Promise(r=>setTimeout(r,25));
 assert.equal(l.size(),0);assert.throws(()=>gate.enter(),e=>e.status===503);
 assert.throws(()=>gate.holdLocal(),e=>e.status===409);
 finish=await gate.holdLocal(undefined,{recovery:true});finish();assert.throws(()=>gate.enter(),e=>e.status===503);
 l.completeRecovery();gate.enter()();
});
test('sweep loss plus progress outage and local deadline never proves external termination',async()=>{
 const gate=createMaintenanceGate();let tick,now=0,terminal=false;
 const controller=new AbortController();const release=gate.holdLocal();release.signal=controller.signal;
 const guard=createSweepGuard({hold:()=>release,progress:async()=>terminal?{ok:true,body:{job:{active:false}}}:{ok:false},now:()=>now,
 setTimer:f=>{tick=f;return 1;},clearTimer:()=>{},perModelMs:1,slackMs:1,unreachableMs:1});
 guard.watch(release,1);controller.abort();now=1000;await tick();
 assert.throws(()=>gate.enter(),e=>e.status===503);assert.equal(guard.active(),true);
 terminal=true;await tick();gate.enter()();
});

test('late recovery barrier acknowledgement cannot resurrect a completed incident',()=>{
 const gate=createMaintenanceGate();const l=createLeases({hold:()=>gate.holdLocal(),barrier:()=>gate.barrier('repair',{recovery:true})});
 l.requireRecovery('old');l.completeRecovery('old');l.requireRecovery('old');gate.enter()();
 l.requireRecovery('new');assert.throws(()=>gate.enter(),e=>e.status===503);
 l.completeRecovery('new');gate.enter()();
});
