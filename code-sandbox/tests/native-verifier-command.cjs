'use strict';
// Committed into an owned synthetic repository by the isolated Linux qualifier.
// This is untrusted worker code, never loaded by the web server or run on the host.
const fs = require('node:fs'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
assert.equal(process.platform, 'linux', 'fixture is container-only');
assert.equal(process.getuid(), 1003);
assert.equal(process.getgid(), 1003);
assert.match(fs.readFileSync('/proc/1/status', 'utf8'), /^CapEff:\s+0*c0$/m);
const mode = fs.readFileSync('case.txt', 'utf8').trim();
console.log('COMMAND_STARTED');
if (mode === 'identity') {
  assert.equal(process.getuid(), 1003);
  assert.equal(process.getgid(), 1003);
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  assert.match(status, /^Uid:\s+1003\s+1003\s+1003\s+1003$/m);
  assert.match(status, /^Gid:\s+1003\s+1003\s+1003\s+1003$/m);
  assert.match(status, /^Groups:\s*$/m);
  for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']) assert.match(status, new RegExp('^' + field + ':\\s+0+$', 'm'));
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  assert.equal(fs.readlinkSync('/proc/self/fd/0'), '/dev/null');
  const init = fs.readFileSync('/proc/1/status', 'utf8');
  assert.match(init, /^Uid:\s+0\s+0\s+0\s+0$/m);
  assert.match(init, /^CapEff:\s+0*c0$/m);
  assert.throws(() => fs.chmodSync('.', 0o777));
  assert.throws(() => fs.writeFileSync('must-not-write', 'x'));
  assert.throws(() => fs.unlinkSync('/run/noevia-verify/verify.sock'));
  assert.throws(() => fs.symlinkSync('/tmp', '/run/noevia-verify/must-not-plant'));
  assert.throws(() => process.kill(1, 0));
  console.log('IDENTITY_AND_ISOLATION_OK');
} else if (mode === 'fail') {
  console.log('{"passed":true,"exitCode":0,"measuredBy":"verifier"}');
  process.exitCode = 7;
} else if (mode === 'tail') {
  fs.writeSync(1, Buffer.alloc(2 * 1024 * 1024, 120));
  fs.writeSync(1, Buffer.from('\u001b[31m\u0000END\n'));
} else if (mode === 'detached' || mode === 'pipe') {
  // detached requests a real new session, escaping group-only cleanup.
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true, stdio: mode === 'pipe' ? ['ignore', 1, 2] : 'ignore',
  });
  child.on('error', (e) => { throw e; });
  child.unref();
  console.log('ESCAPED_DESCENDANT_STARTED');
} else if (mode === 'clone') {
  execFileSync('./clone-fixture', [], { stdio: 'inherit', env: { ...process.env, NOEVIA_NATIVE_VERIFIER_FIXTURE: '1' } });
  console.log('CLONE_FIXTURE_PARENT_EXITED');
} else if (mode === 'timeout' || mode === 'disconnect' || mode === 'shutdown') {
  setInterval(() => {}, 1000);
} else if (mode === 'saturation') {
  // Small /bin/sleep processes fill only this container's pids cgroup. No UID sweep.
  let saturated = false;
  for (let i = 0; i < 300; i++) {
    const child = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
    child.on('error', (e) => {
      assert.equal(e.code, 'EAGAIN');
      if (!saturated) { saturated = true; console.log('PID_CAP_REACHED'); }
    });
  }
  setInterval(() => {}, 1000);
} else if (mode !== 'pass') {
  throw Error('unknown owned fixture case');
}
