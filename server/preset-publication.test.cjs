'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const worker = `
const fs=require('node:fs');
const {createPresetStore}=require(process.argv[1]);
const [file,base,before,text,pause]=process.argv.slice(2);
if(pause==='yes'){
 const rename=fs.renameSync;
 fs.renameSync=(a,b)=>{
  if(b===file){fs.writeFileSync(file+'.ready','');const wait=new Int32Array(new SharedArrayBuffer(4));while(!fs.existsSync(file+'.resume'))Atomics.wait(wait,0,0,10);}
  return rename(a,b);
 };
}
createPresetStore(file).commit({baseRevision:base,before,text}).then(()=>process.stdout.write('200')).catch(e=>{process.stdout.write(String(e.status||500));});
`;
function client(module, file, base, before, text, pause) {
  const child = spawn(process.execPath, ['-e', worker, module, file, base, before, text, pause], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
  return { child, done };
}
test('independent processes serialize revision read through rename and reject the stale publisher', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'models.ini');
  const before = '[m]\nmodel = /models/m.gguf\n';
  const a = before + 'ctx-size = 8192\n', b = before + 'ctx-size = 16384\n';
  fs.writeFileSync(file, before);
  const base = crypto.createHash('sha256').update(before).digest('hex');
  const module = require.resolve('./llamacpp-presets.cjs');
  const first = client(module, file, base, before, a, 'yes');
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(file + '.ready')) {
      assert.ok(Date.now() < deadline, 'first publisher reached rename barrier');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // A has read the revision, written/fsynced its temp file and is stopped before rename.
    // B is a real second process, so an in-process mutex cannot protect this interval.
    const second = client(module, file, base, before, b, 'no');
    assert.equal(await second.done, '503', 'B must not publish while A owns publication');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'no torn or premature publication');
  } finally {
    fs.writeFileSync(file + '.resume', '');
    assert.equal(await first.done, '200');
  }
  assert.equal(fs.readFileSync(file, 'utf8'), a);
  const stale = client(module, file, base, before, b, 'no');
  assert.equal(await stale.done, '409', 'stale revision refused after publication settles');
  assert.equal(fs.readFileSync(file, 'utf8'), a);
});
