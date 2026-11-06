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
 const l=createLeases({hold:({recovery}={})=>gate.holdLocal(undefined,{recovery}),barrier:()=>gate.barrier('recovery',{recovery:true}),ttlMs:10});
 const grant=await l.acquire(undefined,'a');await new Promise(r=>setTimeout(r,25));
 assert.equal(l.size(),0);assert.throws(()=>gate.enter(),e=>e.status===503);
 assert.throws(()=>gate.holdLocal(),e=>e.status===409);
 finish=await gate.holdLocal(undefined,{recovery:true});finish();assert.throws(()=>gate.enter(),e=>e.status===503);
 const repair=await l.acquire(undefined,'repair',true);l.completeRecovery('a',repair);l.release(repair.lease);gate.enter()();
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

test('late recovery barrier acknowledgement cannot resurrect a completed incident',async()=>{
 const gate=createMaintenanceGate();const l=createLeases({hold:({recovery}={})=>gate.holdLocal(undefined,{recovery}),barrier:()=>gate.barrier('repair',{recovery:true})});
 l.requireRecovery('old');const old=await l.acquire(undefined,'repair-old',true);l.completeRecovery('old',old);l.release(old.lease);l.requireRecovery('old');gate.enter()();
 l.requireRecovery('new');assert.throws(()=>gate.enter(),e=>e.status===503);
 const next=await l.acquire(undefined,'repair-new',true);l.completeRecovery('new',next);l.release(next.lease);gate.enter()();
});

test('recovery cancellation retention is bounded and fails closed at capacity',async()=>{
 const gate=createMaintenanceGate();const l=createLeases({hold:({recovery}={})=>gate.holdLocal(undefined,{recovery}),barrier:()=>gate.barrier('repair',{recovery:true}),ticketTombstones:2});
 for(const t of ['a','b']){l.requireRecovery(t);const repair=await l.acquire(undefined,t,true);l.completeRecovery(t,repair);l.release(repair.lease);}l.requireRecovery('c');
 assert.throws(()=>gate.enter(),e=>e.status===503);
});

test('late completion of incident A cannot clear or retire newer incident B', async()=>{
 const gate=createMaintenanceGate();const l=createLeases({hold:({recovery}={})=>gate.holdLocal(undefined,{recovery}),barrier:()=>gate.barrier('repair',{recovery:true})});
 const A='a'.repeat(32),B='b'.repeat(32);
 l.requireRecovery(A);
 const repairA=await l.acquire(undefined,'1'.repeat(32),true);
 l.completeRecovery(A,repairA);l.release(repairA.lease);
 l.requireRecovery(B);
 l.completeRecovery(A,repairA);
 assert.throws(()=>gate.enter(),e=>e.status===503,'B must survive delayed completion for A');
 l.requireRecovery(B);
 assert.throws(()=>gate.enter(),e=>e.status===503,'stale completion must not retire B');
 const repairB=await l.acquire(undefined,'2'.repeat(32),true);
 l.completeRecovery(B,repairB);l.release(repairB.lease);gate.enter()();
});

test('repair completion clears only its captured incident set and exact active generation',async()=>{
 const gate=createMaintenanceGate();const l=createLeases({hold:({recovery}={})=>gate.holdLocal(undefined,{recovery}),barrier:()=>gate.barrier('repair',{recovery:true})});
 const A='a'.repeat(32),B='b'.repeat(32);
 l.requireRecovery(A);const repair=await l.acquire(undefined,'1'.repeat(32),true);
 l.requireRecovery(B);
 l.completeRecovery(A,repair);
 l.release(repair.lease);
 assert.throws(()=>gate.enter(),e=>e.status===503,'B arrived after this repair began');
 const next=await l.acquire(undefined,'2'.repeat(32),true);
 assert.equal(l.completeRecovery(B,{...next,generation:(next.generation||0)+1}),false);
 l.release(next.lease);
 assert.throws(()=>gate.enter(),e=>e.status===503,'wrong generation never completes B');
 const last=await l.acquire(undefined,'3'.repeat(32),true);
 assert.equal(l.completeRecovery(B,last),true);l.release(last.lease);gate.enter()();
});
