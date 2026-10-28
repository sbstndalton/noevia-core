'use strict';
// Fixed owned qualification artifact. Never installed as a production harness.
const fs = require('node:fs'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 1000); assert.equal(process.getgid(), 1000);
const spec = JSON.parse(fs.readFileSync('case.json', 'utf8'));
const mode = spec.mode;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const stat = (pid) => {
  const text = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  const f = text.slice(text.lastIndexOf(') ') + 2).trim().split(/\s+/);
  return { pid: Number(text.slice(0, text.indexOf(' '))), ppid: Number(f[1]), pgid: Number(f[2]), sid: Number(f[3]) };
};
const self = stat('self');
assert.equal(self.pid, self.pgid); assert.equal(self.pid, self.sid);
assert.equal(self.ppid, 1);
const status = fs.readFileSync('/proc/self/status', 'utf8');
for (const field of ['CapEff', 'CapPrm', 'CapInh', 'CapAmb']) assert.match(status, new RegExp('^' + field + ':\\s+0+$', 'm'));
assert.match(status, /^NoNewPrivs:\s+1$/m);
assert.ok(!process.getgroups().includes(0));
assert.equal(process.env.NOEVIA_QUALIFICATION_AMBIENT_SECRET, undefined);
assert.equal(process.env.LD_PRELOAD, undefined); assert.equal(process.env.NODE_OPTIONS, undefined);
assert.equal(process.env.PI_COMMAND, undefined);
assert.equal(process.env.SANDBOX_BRIDGE_IMPL, 'rust');
assert.ok(process.cwd().startsWith('/workspaces/'));
assert.throws(() => fs.writeFileSync('/srv/must-not-write', 'x'));
const expectedInit = ['node-default', 'node-explicit'].includes(mode) ? '/usr/local/bin/node' : '/usr/local/libexec/noevia/code-sandbox-supervisor';
const init = fs.statSync('/proc/1/exe'), pinned = fs.statSync(expectedInit);
assert.equal(init.dev, pinned.dev); assert.equal(init.ino, pinned.ino);
const evidence = { ...self, uid: process.getuid(), gid: process.getgid(), cwd: process.cwd(), home: process.env.HOME,
  init: expectedInit, bridge: process.env.SANDBOX_BRIDGE_IMPL, secretAbsent: true };
fs.writeFileSync('admitted.json', JSON.stringify(evidence));

async function write(bytes) {
  await new Promise((resolve, reject) => process.stdout.write(bytes, (error) => error ? reject(error) : resolve()));
}
async function streaming() {
  if (mode === 'slow-reader') {
    for (let i = 0; i < 128; i++) await write(Buffer.alloc(65536, 120));
    return;
  }
  if (mode === 'stalled-reader') {
    const child = spawn(process.execPath, ['-e', `
      process.on('SIGTERM',()=>{}); process.stdout.on('error',()=>process.exit(0));
      (async()=>{for(let i=0;i<1024;i++){
        await new Promise((resolve,reject)=>process.stdout.write(Buffer.alloc(65536),e=>e?reject(e):resolve()));
        if(i===0)process.send({ready:true});
      }})().catch(()=>process.exit(0));
    `.replace(/\n/g, ' ')], { stdio: ['ignore', 1, 2, 'ipc'] });
    await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
    child.disconnect(); child.unref();
    // Leave the original group leader waitable while an uncooperative pipe writer runs.
    process.exit(0);
  }
  const child = spawn(process.execPath, ['-e', `
    const fs=require('fs'); process.on('SIGTERM',()=>{}); process.stdout.on('error',()=>{});
    const t=fs.readFileSync('/proc/self/stat','utf8'),f=t.slice(t.lastIndexOf(') ')+2).trim().split(/\\s+/);
    if(Number(f[2])!==process.pid||Number(f[3])!==process.pid)throw Error('owned child did not escape the original session');
    fs.writeFileSync('escaped.json',JSON.stringify({pid:process.pid,pgid:Number(f[2]),sid:Number(f[3])}));
    process.send({ready:true});
    ${mode === 'escaped-writer' ? "setInterval(()=>{if(!process.stdout.writableNeedDrain)process.stdout.write(Buffer.alloc(8192))},5)" : 'setInterval(()=>{},1000)'};
  `.replace(/\n/g, ' ')], { detached: true, stdio: ['ignore', 1, 2, 'ipc'] });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  child.disconnect(); child.unref(); process.exit(0);
}
if (['slow-reader', 'stalled-reader', 'escaped-quiet', 'escaped-writer'].includes(mode)) {
  streaming().catch((error) => { console.error(error); process.exitCode = 1; });
} else {
  let buffer = '', next = 100; const waiting = new Map();
  const ask = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); send({ id, method, params }); });
  process.on('SIGTERM', () => {}); // Qualification proves the forced group-kill fallback too.
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk; assert.ok(buffer.length < 1024 * 1024);
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.method === undefined && m.id !== undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); continue; }
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'owned-fixture', version: '1' } } });
      else if (m.method === 'session/new') { assert.deepEqual(m.params?._meta?.noevia?.permission, { edits: 'ask' }); send({ id: m.id, result: { sessionId: 'owned-session' } }); }
      else if (m.method === 'session/prompt') {
        (async () => {
          if (['disconnect', 'shutdown', 'wall', 'capacity'].includes(mode)) {
            send({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OWNED_PENDING' } } } });
            setInterval(() => {}, 1000); return;
          }
          const seen = [];
          if (mode === 'permissions') {
            seen.push(await ask('session/request_permission', { toolCall: { kind: 'edit', title: 'owned synthetic edit' }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] }));
            seen.push(await ask('fs/read_text_file', { path: 'owned.txt' }));
            seen.push(await ask('fs/write_text_file', { path: 'owned.txt', content: 'synthetic' }));
          }
          send({ id: m.id, result: { stopReason: 'end_turn', evidence, seen } });
        })().catch((error) => { console.error(error); process.exitCode = 1; });
      }
      // Cancellation is intentionally ignored by this synthetic adversarial harness.
    }
  });
}
