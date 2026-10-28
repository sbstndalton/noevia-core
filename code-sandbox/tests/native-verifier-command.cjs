'use strict';
// Committed into an owned synthetic repository by the isolated Linux qualifier.
// This is untrusted worker code, never loaded by the web server or run on the host.
const fs = require('node:fs'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const os = require('node:os'), crypto = require('node:crypto');
const { writeTail } = require('./native-verifier-output.cjs');
assert.equal(process.platform, 'linux', 'fixture is container-only');
assert.equal(process.getuid(), 1003);
assert.equal(process.getgid(), 1003);
assert.match(fs.readFileSync('/proc/1/status', 'utf8'), /^CapEff:\s+0*c0$/m);
const mode = fs.readFileSync('case.txt', 'utf8').trim();
if (fs.existsSync('/qualification-proof')) {
  fs.writeFileSync('/qualification-proof/operator-started', JSON.stringify({ uid: process.getuid(), pid: process.pid }), { mode: 0o644 });
}
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
  for (const fd of fs.readdirSync('/proc/self/fd')) {
    let target;
    try { target = fs.readlinkSync('/proc/self/fd/' + fd); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    assert.doesNotMatch(target, /socket:\[|anon_inode:\[pidfd\]|\/run\/noevia-verify\//,
      'no bootstrap/listener/request socket, pidfd or root admission writer may reach worker exec');
  }
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
  writeTail(process.stdout).catch((error) => { console.error(error); process.exitCode = 1; });
} else if (mode === 'detached' || mode === 'pipe') {
  // detached requests a real new session, escaping group-only cleanup.
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true, stdio: mode === 'pipe' ? ['ignore', 1, 2] : 'ignore',
  });
  child.on('error', (e) => { throw e; });
  child.unref();
  console.log('ESCAPED_DESCENDANT_STARTED');
} else if (mode === 'clone') {
  const artifact = '/qualification/clone-fixture';
  assert.equal(fs.statSync('./clone-fixture').mode & 0o111, 0o111, 'verified copy retains executable bits');
  const mount = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
    .map((line) => line.trim().split(/\s+/)).find((fields) => fields[4] === '/verify/copy');
  assert.ok(mount && mount[5].split(',').includes('noexec'), 'preserve the actual copy noexec boundary');
  const env = { ...process.env, NOEVIA_NATIVE_VERIFIER_FIXTURE: '1' };
  assert.throws(() => execFileSync('./clone-fixture', [], { env, stdio: 'inherit' }),
    (error) => error.code === 'EACCES', 'repository copy must remain non-executable');
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(hash('./clone-fixture'), hash(artifact), 'readonly trusted artifact matches the verified Git bytes');
  console.log('COPY_NOEXEC_AND_ARTIFACT_BINDING_OK');
  execFileSync(artifact, [], { stdio: 'inherit', env });
  const pid = fs.readFileSync('/verify/run/qualification-clone-pid', 'utf8').trim();
  assert.match(pid, /^[1-9][0-9]*$/);
  const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
  assert.equal(Number(fields[1]), 1, 'clone child was actually adopted by init');
  assert.equal(Number(fields[35]), os.constants.signals.SIGCHLD, 'observed adopted class, not a __WALL omission proof');
  console.log('ADOPTED_CLONE_SIGCHLD_DRAIN_CASE');
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
} else if (!['pass', 'copy-descendant', 'admission-witness-control'].includes(mode)) {
  throw Error('unknown owned fixture case');
}
