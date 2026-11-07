'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Readable} = require('node:stream');
const {createOwner} = require('./rust-embedding-background.cjs');
const {RUST_INDEX_OUTBOX_OWNED} = require('./rust-index-outbox.cjs');
for (const removed of ['file', 'project', 'account', 'none']) {
  test(`delayed media consumer rechecks ${removed} after body await`, async () => {
    const body = {start:'synthetic-start',user:'11111111-1111-4111-8111-111111111111',project:'p',file:'source.md'};
    const state = {active:true,projects:[{id:'p',files:[{name:'source.md'}]}]};
    const calls=[], replies=[], checked=[];
    const sourceMember = (user,project,file) => {
      checked.push([user,project,file]);
      return user===body.user && state.active && state.projects.some(p=>p.id===project && p.files.some(f=>f.name===file));
    };
    // Represents the already successful native preflight, before the async hop.
    assert.equal(sourceMember(body.user,body.project,body.file),true);
    checked.length=0;
    const owner=createOwner({env:{NOEVIA_START_ID:body.start},frontSecret:'synthetic-token',features:()=>`rust-embedding-background-v1 ${RUST_INDEX_OUTBOX_OWNED}`,sourceMember,sourceChanged:(...args)=>calls.push(args)});
    let reading;
    const bodyRead=new Promise(resolve=>{reading=resolve;});
    const req=Object.assign(new Readable({read(){reading();}}),{method:'POST',url:'/internal/embedding-worker-owner/source-changed',headers:{'x-noevia-store-token':'synthetic-token'},socket:{remoteAddress:'127.0.0.1'}});
    const pending=owner.handleSourceChanged(req,{},(_,status,value)=>replies.push({status,value}));
    await bodyRead;
    assert.equal(checked.length,0,'the body is still pending');
    if(removed==='file') state.projects[0].files=[];
    if(removed==='project') state.projects=[];
    if(removed==='account') state.active=false;
    req.push(JSON.stringify(body));req.push(null);
    await pending;
    assert.equal(calls.length,removed==='none'?1:0,'removed source must not schedule media');
    if(removed!=='none') assert.deepEqual(checked,[[body.user,body.project,body.file]]);
    // Rejection and success share exactly the same opaque 2xx acknowledgement.
    assert.deepEqual(replies,[{status:200,value:{protocol:'rust-embedding-worker-v1',start:body.start,notified:true}}]);
  });
}
