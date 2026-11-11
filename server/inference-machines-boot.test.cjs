'use strict';
// The supervisor starts Core and the front together: Core's machine session must wait (bounded)
// for the front's private store instead of failing the boot on the first refused connection.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const TOKEN = 'synthetic-boot-token-0123456789abcdef0123';

function freePort() {
  return Number(execFileSync(process.execPath, ['-e', "const s=require('node:net').createServer().listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();})"], { encoding: 'utf8' }));
}

// A synthetic store that only starts listening after `delayMs`, in its own process (Core's boot
// blocks this one while it waits). It prints each request's op.
function lateStore(port, delayMs) {
  const src = `setTimeout(()=>require('node:http').createServer((q,r)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{
    const ok=q.url==='/v1/inference-machines'&&q.headers['x-noevia-store-token']===${JSON.stringify(TOKEN)};
    const op=ok?JSON.parse(b).op:'refused';process.stdout.write(op+'\\n');
    r.writeHead(ok&&op==='session'?200:503,{'content-type':'application/json'});
    r.end(ok&&op==='session'?'{"epoch":7}':'{"error":"Inference machines are unavailable.","code":"machinesUnavailable"}');});
  }).listen(${port},'127.0.0.1',()=>process.stdout.write('listening\\n')),${delayMs});`;
  const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  return { child, out: () => out };
}

function boot(port, sessionWaitMs) {
  // A fresh process per case: the native client is configured once per process.
  const script = `process.env.NOEVIA_PROJECT_STORE_PORT=${JSON.stringify(String(port))};process.env.NOEVIA_PROJECT_STORE_TOKEN=${JSON.stringify(TOKEN)};
    const started=Date.now();
    try{require(${JSON.stringify(path.join(__dirname, 'inference-machines.cjs'))}).createInferenceMachines({sessionWaitMs:${sessionWaitMs}});process.stdout.write(JSON.stringify({ok:true,ms:Date.now()-started}));}
    catch(e){process.stdout.write(JSON.stringify({ok:false,code:e.code,status:e.status,ms:Date.now()-started}));}`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 }));
}

test('Core waits for a store that starts after it and opens one session', async () => {
  const port = freePort();
  const store = lateStore(port, 700);
  try {
    const result = boot(port, 10000);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.ms >= 500, `waited ${result.ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(store.out().trim().split('\n'), ['listening', 'session']);
  } finally { store.child.kill(); }
});

test('Core refuses to start once the bounded wait passes with no store', () => {
  const port = freePort();
  const result = boot(port, 600);
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.code, 'machinesUnavailable');
  assert.ok(result.ms >= 400 && result.ms < 5000, `refused after ${result.ms} ms`);
});
