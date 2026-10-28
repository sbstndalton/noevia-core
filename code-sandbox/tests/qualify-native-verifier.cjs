#!/usr/bin/env node
'use strict';
// Ephemeral GitHub Linux runner only. Never runs repository commands on the host.
// Input is the actual rendered companion Compose profile, not a relaxed test service.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const os = require('node:os'), crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.NOEVIA_NATIVE_VERIFIER_QUALIFICATION !== '1' || process.platform !== 'linux') {
  throw Error('owned isolated GitHub Linux qualification required');
}
const [profilePath, image, coreArg, fixtureImage] = process.argv.slice(2);
assert.ok(profilePath && image && coreArg && fixtureImage, 'usage: qualifier <rendered-profile.json> <built-image> <exact-core-checkout> <built-fixture-image>');
const core = fs.realpathSync(coreArg);
assert.ok(!core.includes(','), 'Docker mount source cannot contain a comma');
const input = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const service = input.services['code-verify'];
assert.deepEqual(service.command, ['/usr/local/libexec/noevia/code-verify-native']);
assert.equal(service.user, '0:0'); assert.equal(service.read_only, true);
assert.equal(service.network_mode, 'none'); assert.ok(!service.init && !service.privileged);
assert.ok(!service.ports?.length && !service.pid && !service.ipc);
const caps = (values) => values.map((v) => v.toUpperCase().replace(/^CAP_/, '')).sort();
assert.deepEqual(caps(service.cap_drop), ['ALL']); assert.deepEqual(caps(service.cap_add), ['SETGID', 'SETUID']);
assert.ok(service.security_opt.some((v) => /^no-new-privileges(?::true|=true)?$/.test(v)));
assert.equal(service.pids_limit, 256); assert.equal(Number(service.cpus), 2);
assert.equal(Number(service.mem_limit), 2147483648);
assert.equal(service.environment.VERIFY_SOURCE_ROOT, '/workspaces');
assert.equal(service.environment.VERIFY_SOCKET, '/run/noevia-verify/verify.sock');
assert.equal(service.environment.VERIFY_TEST_USER, '1003:1003');
assert.match(service.environment.VERIFY_GIT_USER, /^1002:[1-9][0-9]*$/);
assert.equal(service.volumes.length, 2);
const workspaceMount = service.volumes.find((v) => v.target === '/workspaces');
const socketMount = service.volumes.find((v) => v.target === '/run/noevia-verify');
assert.equal(workspaceMount.type, 'volume'); assert.equal(workspaceMount.read_only, true);
assert.equal(socketMount.type, 'volume'); assert.ok(!socketMount.read_only);
const runId = 'noevia-native-verifier-' + crypto.randomBytes(8).toString('hex');
const owned = fs.mkdtempSync(path.join(os.tmpdir(), runId + '-'));
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cases = ['pass', 'identity', 'fail', 'tail', 'detached', 'pipe', 'clone', 'timeout', 'copy-deadline',
  'copy-descendant', 'admission-witness-control', 'bad-head', 'unconfigured', 'hostile-config', 'malformed', 'partial', 'oversized', 'disconnect', 'shutdown', 'root-gid', 'saturation'];
let completed = 0;
async function one(mode, index) {
  const name = runId + '-' + index;
  const work = path.join(owned, String(index)); fs.mkdirSync(work);
  const sources = path.join(work, 'workspaces'); fs.mkdirSync(sources, { mode: 0o755 });
  const repo = path.join(sources, 'synthetic'); fs.mkdirSync(repo, { mode: 0o755 });
  const git = (args) => execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', ...args], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
  git(['init', '--quiet', '-b', 'main']);
  fs.copyFileSync(path.join(__dirname, 'native-verifier-command.cjs'), path.join(repo, 'verify.cjs'));
  fs.writeFileSync(path.join(repo, 'case.txt'), mode === 'copy-deadline' ? 'pass' : mode);
  if (mode === 'clone') { fs.copyFileSync(path.join(owned, 'clone-fixture'), path.join(repo, 'clone-fixture')); fs.chmodSync(path.join(repo, 'clone-fixture'), 0o755); }
  git(['add', '.']); git(['commit', '--quiet', '-m', 'owned synthetic fixture']);
  const head = git(['rev-parse', 'HEAD']);
  if (mode === 'hostile-config') git(['config', 'alias.synthetic', '!echo MUST_NOT_RUN']);
  const witnessed = ['copy-deadline', 'copy-descendant', 'admission-witness-control'].includes(mode);
  const configured = structuredClone(service);
  configured.image = image; delete configured.build; delete configured.restart;
  configured.environment = { ...configured.environment,
    CODE_VERIFY: 'synthetic|node verify.cjs',
    CODE_VERIFY_WALL_MS: ['timeout', 'saturation'].includes(mode) ? '1500' : mode === 'copy-deadline' ? '1' : '15000',
    CODE_VERIFY_TAIL_BYTES: '1024', VERIFY_MIN_UPTIME_MS: '60000',
  };
  if (mode === 'root-gid') configured.environment.VERIFY_TEST_USER = '1003:0';
  configured.volumes = [
    { type: 'bind', source: sources, target: '/workspaces', read_only: true },
    { type: 'volume', source: 'socket', target: '/run/noevia-verify' },
  ];
  const volumes = { socket: { name: name + '-socket' } };
  if (witnessed) {
    volumes.proof = { name: name + '-proof' };
    configured.volumes.push({ type: 'volume', source: 'proof', target: '/qualification-proof' });
  }
  if (mode === 'copy-descendant') {
    configured.environment.PATH = '/qualification/bin:/usr/local/bin:/usr/bin:/bin';
    configured.volumes.push({ type: 'bind', source: path.join(__dirname, 'native-verifier-git-wrapper.cjs'), target: '/qualification/bin/git', read_only: true });
  }
  const config = path.join(work, 'compose.json');
  fs.writeFileSync(config, JSON.stringify({ services: { 'code-verify': configured }, volumes }));
  const compose = (args) => docker(['compose', '-p', name, '-f', config, '--profile', 'code', ...args]);
  let created = false, client, clientCreated = false;
  try {
    created = true;
    if (witnessed) {
      docker(['volume', 'create', '--label', 'com.docker.compose.project=' + name, '--label', 'com.docker.compose.volume=proof', name + '-proof']);
      docker(['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--user', '0:0',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '32', '--memory', '256m', '--cpus', '1',
        '--mount', 'type=volume,src=' + name + '-proof,dst=/proof', '--entrypoint', 'node', image,
        '-e', 'require("fs").chmodSync("/proof",0o1777)']);
    }
    compose(['up', '-d', '--no-build', 'code-verify']);
    const id = compose(['ps', '-a', '-q', 'code-verify']).trim(); assert.ok(id);
    const initial = JSON.parse(docker(['inspect', id]))[0];
    assert.equal(initial.Config.User, '0:0'); assert.equal(initial.HostConfig.ReadonlyRootfs, true);
    assert.equal(initial.HostConfig.NetworkMode, 'none'); assert.equal(initial.HostConfig.Privileged, false);
    assert.deepEqual(caps(initial.HostConfig.CapAdd), ['SETGID', 'SETUID']);
    assert.deepEqual(caps(initial.HostConfig.CapDrop), ['ALL']);
    assert.ok(!initial.HostConfig.PortBindings || Object.keys(initial.HostConfig.PortBindings).length === 0);
    assert.equal(initial.HostConfig.PidsLimit, 256); assert.equal(initial.HostConfig.Memory, 2147483648); assert.equal(initial.HostConfig.NanoCpus, 2000000000);
    assert.ok(initial.Mounts.find((v) => v.Destination === '/workspaces' && v.Type === 'bind' && !v.RW));
    assert.ok(initial.Mounts.find((v) => v.Destination === '/run/noevia-verify' && v.Type === 'volume' && v.RW));
    if (mode === 'root-gid') {
      assert.equal(docker(['wait', id]).trim(), '1', 'GID0 refuses before binding');
      const absent = docker(['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--user', '0:0',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--mount', 'type=volume,src=' + name + '-socket,dst=/run/noevia-verify,readonly',
        '--entrypoint', 'node', image, '-e', 'if(require("fs").existsSync("/run/noevia-verify/verify.sock"))process.exit(1)']);
      assert.equal(absent, '');
    } else {
      const args = ['run', '--interactive', '--rm', '--name', name + '-client', '--pull', 'never', '--read-only', '--network', 'none', '--user', '0:0',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '512m', '--cpus', '1',
        '--env', 'NOEVIA_NATIVE_VERIFIER_QUALIFICATION=1',
        '--mount', 'type=volume,src=' + name + '-socket,dst=/run/noevia-verify',
        '--mount', 'type=bind,src=' + path.join(core, 'server') + ',dst=/reviewed-core/server,readonly',
        '--mount', 'type=bind,src=' + path.join(__dirname, 'native-verifier-client.cjs') + ',dst=/qualification/client.cjs,readonly',
        '--mount', 'type=bind,src=' + path.join(__dirname, 'native-verifier-assertions.cjs') + ',dst=/qualification/native-verifier-assertions.cjs,readonly',
        ...(witnessed ? ['--mount', 'type=volume,src=' + name + '-proof,dst=/qualification-proof,readonly'] : []),
        '--entrypoint', 'node', image, '/qualification/client.cjs', mode, head];
      let output = '', errors = '', done = false;
      clientCreated = true;
      client = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      client.stdout.on('data', (b) => { output += b; assert.ok(output.length < 1024 * 1024); });
      client.stderr.on('data', (b) => { errors += b; assert.ok(errors.length < 1024 * 1024); });
      const exit = new Promise((resolve) => {
        client.once('error', (error) => { done = true; errors += error.message; resolve(-1); });
        client.once('close', (code) => { done = true; resolve(code); });
      });
      const end = Date.now() + 45000; let workerSeen = false, maximumTasks = 0, stopped = false, serverEnded = false, cancelSent = false;
      while (!done && Date.now() < end) {
        let tasks = '';
        if (!serverEnded) {
          try { tasks = docker(['top', id, '-eo', 'pid,ppid,uid,args']); }
          catch (error) {
            if (JSON.parse(docker(['inspect', id]))[0].State.Running) throw error;
            serverEnded = true;
          }
        }
        workerSeen ||= /node verify\.cjs/.test(tasks);
        maximumTasks = Math.max(maximumTasks, tasks.trim().split('\n').length - 1);
        if (mode === 'disconnect' && workerSeen && !cancelSent) { client.stdin.write('cancel\n'); cancelSent = true; }
        if (mode === 'shutdown' && workerSeen && !stopped) { docker(['kill', '--signal', 'TERM', id]); stopped = true; }
        await delay(100);
      }
      assert.ok(done, 'owned client exceeded qualification deadline');
      assert.equal(await exit, 0, output + errors);
      const result = JSON.parse(output.trim().split('\n').at(-1)); assert.equal(result.case, mode);
      if (mode === 'disconnect' || mode === 'shutdown') assert.ok(workerSeen, 'cancellation must happen during actual command execution');
      if (mode === 'saturation') assert.ok(maximumTasks >= 250, 'actual pids-cap pressure was not established');
      if (result.report) {
        // A receipt plus a still-live init, with no workers, is stronger than teardown alone.
        const tasks = docker(['top', id, '-eo', 'pid,ppid,uid,args']).trim().split('\n');
        assert.equal(tasks.length, 2, 'owned descendants/pipe holders must be gone before reply');
        assert.match(tasks[1], /code-verify-native/);
        docker(['kill', '--signal', 'TERM', id]);
        assert.equal(docker(['wait', id]).trim(), '0');
      } else {
        if (JSON.parse(docker(['inspect', id]))[0].State.Running) docker(['kill', '--signal', 'TERM', id]);
        docker(['wait', id]);
      }
      const state = JSON.parse(docker(['inspect', id]))[0].State;
      assert.equal(state.OOMKilled, false, 'OOM cannot substitute for cleanup qualification');
      console.log(JSON.stringify({ case: mode, result: result.status || 'no-answer', workerSeen, maximumTasks }));
    }
    completed++; console.log('PASS native verifier ' + mode);
  } finally {
    if (client && client.exitCode === null && client.signalCode === null) client.kill('SIGTERM');
    if (clientCreated) { try { docker(['rm', '-f', name + '-client']); } catch { /* --rm already removed this owned client */ } }
    if (created) compose(['down', '--volumes', '--timeout', '5']);
  }
}
(async () => {
  try {
    const fixtureContainer = runId + '-fixture';
    try {
      docker(['create', '--name', fixtureContainer, fixtureImage]);
      docker(['cp', fixtureContainer + ':/native-verifier-clone', path.join(owned, 'clone-fixture')]);
    } finally { docker(['rm', '-f', fixtureContainer]); }
    for (let i = 0; i < cases.length; i++) await one(cases[i], i);
    assert.equal(completed, cases.length);
    console.log('Native verifier isolated Linux qualification: ' + completed + ' PASS, 0 skipped');
  } finally { fs.rmSync(owned, { recursive: true, force: true }); }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
