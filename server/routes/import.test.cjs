'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createWorkspaceStore}=require('../workspace.cjs'),{createProjectStore}=require('../projects.cjs'),{createImportRoutes}=require('./import.cjs'),{persistedChatIds}=require('../conversation-import.cjs'),{FORMAT}=require('../chat-export.cjs'),lists=require('../chat-lists.cjs');
const uid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const payload={format:FORMAT,chats:[{id:'c-free',title:'Free',history:[{role:'user',content:'Synthetic free'}]},{id:'c-existing',title:'Existing',project:{name:'Existing'},history:[{role:'user',content:'Synthetic existing'}]},{id:'c-new',title:'New',project:{name:'New'},history:[{role:'user',content:'Synthetic new'}]}]};
function fixture(root,user=uid){
 const w=createWorkspaceStore(root,{id:'default'}).get(user);
 const proxy=field=>new Proxy([],{get(_t,k){const v=w[field][k];return typeof v==='function'?v.bind(w[field]):v;},set(_t,k,v){w[field][k]=v;return true;}});
 const store=createProjectStore({fs,path,currentWorkspace:()=>w,PROJECTS:proxy('projects'),FREE_CHATS:proxy('freeChats'),reasoningEffort:{validEffort:()=>true},projectAppearance:()=>({}),rag:{},storageClient:{isBrowsable:()=>false},documentSources:{},authService:{getStorage:()=>({kind:'local'})},sanitizeToolboxes:x=>x,defaultToolboxes:()=>['core'],PROJECT_ROOT_FOLDER:'projects',createProjectFolder:async()=>'',projectSweep:{}});
 let serial=0;const audited=[],failures={};
 const context=()=>({directory:w.dir,historyPath:id=>w.historyPath(id),persistedChatIds:()=>persistedChatIds(w.dir),projects:()=>w.projects.map(p=>({id:p.id,name:p.name})),existingChatIds:()=>new Set([...w.freeChats,...w.projects.flatMap(p=>p.chats||[])].map(c=>c.id)),tombstones:()=>lists.readTombstones(w.dir),addFreeChats:chats=>store.saveFreeChats(lists.mergeChats(w.freeChats,chats,lists.readTombstones(w.dir))),addProjectChats:(id,chats)=>store.saveChats(id,chats),createProject:body=>store.createProject(body)});
 const route=createImportRoutes({json:(res,status,body)=>Object.assign(res,{status,body}),readBody:async req=>JSON.stringify(req.data),context,newId:()=>`c-generated-${++serial}`,audit:(...args)=>{if(failures.audit)throw Error('Synthetic audit interruption');audited.push(args);}});
 return {w,store,audited,failures,request:async(data=payload)=>{const res={};await route({method:'POST',data},res,{path:'/api/import/conversations',authn:{user:{id:user}}});return res;}};
}
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'noevia-import-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function historyIds(w){return fs.readdirSync(w.dir).filter(n=>/^history-c-.*\.json$/.test(n)).map(n=>n.slice(8,-5)).sort();}
function assertComplete(f){assert.deepEqual([...persistedChatIds(f.w.dir)].sort(),['c-existing','c-free','c-new']);assert.deepEqual(historyIds(f.w),['c-existing','c-free','c-new']);assert.deepEqual(fs.readdirSync(path.join(f.w.dir,'conversation-imports')),[]);}
for(const fault of ['free','existing','create','attach'])test(`import recovers real ${fault} persistence failure after restart`,async t=>{
 const root=temporary(t),f=fixture(root);await f.store.createProject({name:'Existing',toolboxes:[]});
 const save=f.w.saveProjects.bind(f.w),free=f.w.saveFreeChats.bind(f.w);let calls=0;
 f.w.saveProjects=()=>{if(++calls===({existing:1,create:2,attach:3}[fault]))throw Error('Synthetic disk full');save();};f.w.saveFreeChats=()=>{if(fault==='free')throw Error('Synthetic disk full');free();};
 const failed=await f.request();assert.equal(failed.status,503);assert.match(failed.body.error,/Retry the same file/);assert.equal(f.audited.length,0);
 const pending=fs.readdirSync(path.join(f.w.dir,'conversation-imports'));assert.equal(pending.length,1);assert.ok(fs.existsSync(path.join(f.w.dir,'conversation-imports',pending[0],'manifest.json')));
 const restarted=fixture(root);const success=await restarted.request();assert.equal(success.status,200);assert.equal(success.body.imported,3);assertComplete(restarted);
 const again=await restarted.request();assert.equal(again.body.imported,0);assertComplete(restarted);
});
test('same-process retry persists metadata already mutated in cache',async t=>{
 const f=fixture(temporary(t));await f.store.createProject({name:'Existing',toolboxes:[]});const save=f.w.saveFreeChats.bind(f.w);f.w.saveFreeChats=()=>{throw Error('disk');};
 assert.equal((await f.request()).status,503);assert.equal(f.w.freeChats.length,1);assert.equal(persistedChatIds(f.w.dir).size,0);f.w.saveFreeChats=save;assert.equal((await f.request()).status,200);assertComplete(f);
});
test('retry preserves unrelated edits, tombstones and pre-existing transcript paths',async t=>{
 const root=temporary(t),f=fixture(root);await f.store.createProject({name:'Existing',toolboxes:[]});f.store.writeHistory('c-new',[{role:'user',content:'Pre-existing unlisted transcript'}]);
 f.w.saveProjects=()=>{throw Error('disk');};assert.equal((await f.request()).status,503);
 const next=fixture(root);next.store.deleteFreeChat('c-free');next.store.writeHistory('c-other',[{role:'user',content:'Other concurrent conversation'}]);next.store.saveFreeChats([{id:'c-other',title:'Unrelated',updatedAt:1}]);
 const existing=next.w.projects.find(p=>p.name==='Existing');existing.goal='Concurrent edit';next.w.saveProjects();
 const r=await next.request();assert.equal(r.status,200);assert.equal(r.body.imported,2);assert.match(r.body.skipped[0].reason,/deleted/);assert.equal(next.w.projects.find(p=>p.name==='Existing').goal,'Concurrent edit');assert.ok(persistedChatIds(next.w.dir).has('c-other'));assert.ok(!persistedChatIds(next.w.dir).has('c-free'));
 assert.equal(next.store.readHistory('c-new')[0].content,'Pre-existing unlisted transcript');const generated=[...persistedChatIds(next.w.dir)].find(id=>id.startsWith('c-generated-'));assert.ok(generated);assert.equal(next.store.readHistory(generated)[0].content,'Synthetic new');
});
test('serialized imports are idempotent and tenants remain independent',async t=>{
 const root=temporary(t),a=fixture(root),b=fixture(root,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');const results=await Promise.all([a.request(),a.request(),b.request()]);assert.deepEqual(results.map(r=>r.status),[200,200,200]);assert.deepEqual(results.map(r=>r.body.imported),[3,0,3]);assertComplete(a);assertComplete(b);
});
test('incomplete staging is discarded before promotion; invalid input makes no journal',async t=>{
 const f=fixture(temporary(t));assert.equal((await f.request({format:'wrong'})).status,400);assert.ok(!fs.existsSync(path.join(f.w.dir,'conversation-imports')));
 const staging=path.join(f.w.dir,'conversation-imports','0'.repeat(64));fs.mkdirSync(staging,{recursive:true});fs.writeFileSync(path.join(staging,'0.json'),'unfinished');assert.equal((await f.request()).status,200);assertComplete(f);
});

test('restart after metadata commit preserves later transcript edits and finishes journal cleanup',async t=>{
 const root=temporary(t),f=fixture(root);f.failures.audit=true;assert.equal((await f.request()).status,503);
 assert.deepEqual([...persistedChatIds(f.w.dir)].sort(),['c-existing','c-free','c-new']);
 const next=fixture(root);next.store.writeHistory('c-free',[{role:'user',content:'Edited after partial response'}]);
 assert.equal((await next.request()).status,200);assertComplete(next);assert.equal(next.store.readHistory('c-free')[0].content,'Edited after partial response');
});
test('another valid import request recovers pending work before planning its own additions',async t=>{
 const root=temporary(t),f=fixture(root);f.w.saveFreeChats=()=>{throw Error('disk');};assert.equal((await f.request()).status,503);
 const next=fixture(root);const result=await next.request({format:FORMAT,chats:[{id:'c-other',title:'Other',history:[]}]});
 assert.equal(result.status,200);assert.equal(result.body.imported,1);assert.deepEqual([...persistedChatIds(next.w.dir)].sort(),['c-existing','c-free','c-new','c-other']);assert.equal(next.audited.length,2);
});
test('a chat dropped by the list cap is skipped and cannot block later imports',async t=>{
 const f=fixture(temporary(t)),existing=Array.from({length:lists.LIST_CAP},(_,i)=>({id:`c-kept-${i}`,title:`Kept ${i}`,updatedAt:i+1}));
 f.store.saveFreeChats(existing);
 const overflow={format:FORMAT,chats:[{id:'c-overflow',title:'Too old',updatedAt:0,history:[{role:'user',content:'Must not become orphaned'}]}]};
 const first=await f.request(overflow);assert.equal(first.status,200);assert.equal(first.body.imported,0);assert.match(first.body.skipped[0].reason,/list is full/);
 assert.equal(fs.existsSync(f.w.historyPath('c-overflow')),false);assert.deepEqual(fs.readdirSync(path.join(f.w.dir,'conversation-imports')),[]);
 const second=await f.request({format:FORMAT,chats:[{id:'c-later',title:'Later',updatedAt:2000,history:[]}]});
 assert.equal(second.status,200);assert.equal(second.body.imported,1);assert.ok(persistedChatIds(f.w.dir).has('c-later'));
});
test('project and free groups classify their own list-cap results independently',async t=>{
 const f=fixture(temporary(t)),project=await f.store.createProject({name:'Full project',toolboxes:[]});
 f.store.saveChats(project.id,Array.from({length:lists.LIST_CAP},(_,i)=>({id:`c-project-kept-${i}`,title:`Kept ${i}`,updatedAt:i+1})));
 const result=await f.request({format:FORMAT,chats:[
  {id:'c-free-room',title:'Free room',updatedAt:0,history:[]},
  {id:'c-project-overflow',title:'Project overflow',updatedAt:0,project:{name:'Full project'},history:[]},
 ]});
 assert.equal(result.status,200);assert.equal(result.body.imported,1);assert.equal(result.body.skipped.length,1);
 assert.match(result.body.skipped[0].reason,/list is full/);assert.ok(persistedChatIds(f.w.dir).has('c-free-room'));
 assert.equal(persistedChatIds(f.w.dir).has('c-project-overflow'),false);assert.equal(fs.existsSync(f.w.historyPath('c-project-overflow')),false);
});
test('unsupported hard links fail before journaling and do not block a later import',async t=>{
 const f=fixture(temporary(t)),link=fs.linkSync;
 fs.linkSync=()=>{const error=Error('synthetic unsupported hard link');error.code='EPERM';throw error;};
 const failed=await f.request({format:FORMAT,chats:[{id:'c-copy',title:'Copied',history:[{role:'user',content:'Synthetic'}]}]});
 assert.equal(failed.status,503);assert.match(failed.body.error,/storage does not support safe file promotion/);
 assert.equal(fs.existsSync(path.join(f.w.dir,'conversation-imports')),false);assert.equal(fs.existsSync(f.w.historyPath('c-copy')),false);
 fs.linkSync=link;t.after(()=>{fs.linkSync=link;});
 const retry=await f.request({format:FORMAT,chats:[{id:'c-copy',title:'Copied',history:[{role:'user',content:'Synthetic'}]}]});
 assert.equal(retry.status,200);assert.equal(retry.body.imported,1);assert.equal(f.store.readHistory('c-copy')[0].content,'Synthetic');
});
