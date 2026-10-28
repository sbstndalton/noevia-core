#!/usr/bin/env node
'use strict';
// Ephemeral GitHub Linux namespaces only. Never starts a harness on the host.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const os = require('node:os'), crypto = require('node:crypto');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true' || process.env.NOEVIA_NATIVE_SUPERVISOR_QUALIFICATION !== '1') throw Error('owned GitHub Linux qualification required');
const [profilePath, image, coreArg] = process.argv.slice(2);
assert.ok(profilePath && image && coreArg, 'qualifier <actual rendered profile> <built image> <exact core checkout>');
const core = fs.realpathSync(coreArg), input = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const original = input.services['code-sandbox'];
const cases = ['node-default', 'node-explicit', 'roundtrip', 'permissions', 'fragment', 'malformed', 'oversized', 'partial', 'outside', 'symlink',
  'slow-reader', 'stalled-reader', 'disconnect', 'wall', 'shutdown', 'capacity', 'pi-allow', 'pi-deny', 'pi-disconnect', 'pi-stubborn-disconnect', 'pi-protocol-cancel', 'pi-cancel-omission-control',
  'pi-timeout-late', 'escaped-quiet', 'escaped-writer', 'bad-selector', 'bad-harness', 'missing-helper', 'nonexec-helper', 'symlink-helper', 'bad-wasm', 'bad-bridge'];
const faults = new Map([['bad-selector', 'unknown CODE_SANDBOX_SUPERVISOR_IMPL'], ['bad-harness', 'native harness command is not an image-reviewed path'],
  ['missing-helper', 'native session helper is unavailable'], ['nonexec-helper', 'native session helper is unavailable'], ['symlink-helper', 'native session helper is unavailable'],
  ['bad-wasm', 'pinned sandbox bridge preflight failed'], ['bad-bridge', 'native supervisor requires SANDBOX_BRIDGE_IMPL=rust']]);
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const caps = (values) => (values || []).map((v) => v.toUpperCase().replace(/^CAP_/, '')).sort();
const imageId = JSON.parse(docker(['image', 'inspect', image]))[0].Id;
const run = 'noevia-native-supervisor-' + crypto.randomBytes(8).toString('hex');
const owned = fs.mkdtempSync(path.join(os.tmpdir(), run + '-'));
let completed = 0;
assert.equal(original.user, '1000:1000'); assert.equal(original.read_only, true);
assert.deepEqual(caps(original.cap_drop), ['ALL']); assert.deepEqual(caps(original.cap_add), []);
assert.ok(original.security_opt.some((v) => /^no-new-privileges(?::true|=true)?$/.test(v)));
assert.equal(original.security_opt.length, 1); assert.deepEqual(original.group_add || [], []);
assert.equal(original.pids_limit, 512); assert.equal(Number(original.mem_limit), 3221225472);
assert.equal(original.environment.CODE_SANDBOX_SUPERVISOR_IMPL, 'node');
assert.equal(original.environment.WORKSPACE_ROOT, '/workspaces'); assert.equal(original.environment.PORT, '8030');
assert.deepEqual(Object.keys(original.networks), ['code']); assert.equal(input.networks.code.internal, true);
assert.ok(!input.networks.code.external && !original.ports?.length && !original.privileged && !original.pid && !original.ipc && !original.init);
assert.ok(!original.command && !original.entrypoint && !original.network_mode, 'the real image selector and internal network must remain in control');
assert.equal(original.volumes.length, 1); assert.equal(original.volumes[0].target, '/workspaces'); assert.ok(!original.volumes[0].read_only);
const artifact = path.join(owned, 'native');
const fixtureFiles = ['native-supervisor-harness.cjs', 'native-supervisor-client.cjs', 'native-supervisor-pi.cjs'];
for (const file of fixtureFiles) assert.ok(fs.statSync(path.join(__dirname, file)).isFile());
const inspect = (id) => JSON.parse(docker(['inspect', id]))[0];
const top = (id) => docker(['top', id, '-eo', 'pid,ppid,pgid,sid,uid,args']).trim().split('\n');
const logs = (id) => {
  const result = spawnSync('docker', ['logs', '--tail', '30', id], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0); return result.stdout + result.stderr;
};
async function ready(id) {
  const end = Date.now() + 10000;
  for (;;) {
    assert.equal(inspect(id).State.Running, true, logs(id));
    if (logs(id).includes('[code-sandbox] listening on ')) return;
    if (Date.now() >= end) throw Error('owned supervisor did not bind: ' + logs(id));
    await delay(50);
  }
}
async function waitIdle(id) {
  const end = Date.now() + 20000;
  for (;;) {
    assert.equal(inspect(id).State.Running, true, 'namespace teardown cannot stand in for a live supervisor group-drain check');
    const rows = top(id);
    if (rows.length === 2) { assert.match(rows[1], /code-sandbox-supervisor|node \/srv\/supervisor.cjs/); return; }
    if (Date.now() >= end) throw Error('owned supervisor retained child processes: ' + rows.join('\n'));
    await delay(100);
  }
}
async function one(mode, index) {
  const name = run + '-' + index, work = path.join(owned, String(index)); fs.mkdirSync(work);
  const cfg = structuredClone(original); cfg.image = imageId; delete cfg.build; delete cfg.restart;
  cfg.cpus = 2; // An explicit stricter CI-only CPU ceiling; other source limits stay exact.
  cfg.environment = { ...cfg.environment, CODE_SANDBOX_SUPERVISOR_IMPL: 'rust', SANDBOX_BRIDGE_IMPL: 'rust',
    CODE_HARNESS_COMMAND: '/usr/local/bin/node', CODE_HARNESS_ARGS: mode.startsWith('pi-') ? '/srv/pi-acp-bridge.cjs' : '/qualification/native-supervisor-harness.cjs',
    CODE_SANDBOX_MAX_WALL_MS: mode === 'pi-timeout-late' ? '360000' : mode === 'wall' ? '1500' : '25000',
    CODE_SANDBOX_MAX_CONNECTIONS: mode === 'capacity' ? '1' : '4', NOEVIA_QUALIFICATION_AMBIENT_SECRET: 'owned-marker-not-a-credential' };
  if (mode === 'node-default') delete cfg.environment.CODE_SANDBOX_SUPERVISOR_IMPL;
  if (mode === 'node-explicit') cfg.environment.CODE_SANDBOX_SUPERVISOR_IMPL = 'node';
  if (mode === 'bad-selector') cfg.environment.CODE_SANDBOX_SUPERVISOR_IMPL = 'unexpected';
  if (mode === 'bad-harness') cfg.environment.CODE_HARNESS_COMMAND = '/tmp/unreviewed';
  if (mode === 'bad-bridge') cfg.environment.SANDBOX_BRIDGE_IMPL = 'js';
  cfg.volumes = [{ type: 'volume', source: 'work', target: '/workspaces' },
    { type: 'bind', source: path.join(__dirname, 'native-supervisor-harness.cjs'), target: '/qualification/native-supervisor-harness.cjs', read_only: true }];
  if (mode.startsWith('pi-')) cfg.volumes.push({ type: 'bind', source: path.join(__dirname, 'native-supervisor-pi.cjs'), target: '/usr/local/bin/pi', read_only: true });
  if (['missing-helper', 'nonexec-helper', 'symlink-helper'].includes(mode)) {
    const copy = path.join(work, 'native'); fs.cpSync(artifact, copy, { recursive: true });
    if (mode === 'nonexec-helper') fs.chmodSync(path.join(copy, 'code-sandbox-session-exec'), 0o444);
    else fs.unlinkSync(path.join(copy, 'code-sandbox-session-exec'));
    if (mode === 'symlink-helper') fs.symlinkSync('code-sandbox-supervisor', path.join(copy, 'code-sandbox-session-exec'));
    cfg.volumes.push({ type: 'bind', source: copy, target: '/usr/local/libexec/noevia', read_only: true });
  }
  if (mode === 'bad-wasm') { const bad = path.join(work, 'bad.wasm'); fs.writeFileSync(bad, 'owned corrupt module'); cfg.volumes.push({ type: 'bind', source: bad, target: '/srv/wasm/sandbox-bridge.wasm', read_only: true }); }
  const config = path.join(work, 'compose.json'), network = name + '-code', volume = name + '-work';
  fs.writeFileSync(config, JSON.stringify({ services: { 'code-sandbox': cfg }, networks: { code: { ...input.networks.code, name: network } }, volumes: { work: { name: volume } } }));
  const compose = (args) => docker(['compose', '-p', name, '-f', config, '--profile', 'code', ...args]);
  let created = false, id, client;
  const clientName = name + '-client';
  const clientArgs = (clientMode, suffix = '') => ['run', '--rm', '--interactive', '--name', clientName + suffix, '--pull', 'never', '--read-only', '--network', network,
    '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '512m', '--cpus', '1',
    '--env', 'NOEVIA_NATIVE_SUPERVISOR_QUALIFICATION=1', '--mount', 'type=volume,src=' + volume + ',dst=/workspaces',
    '--mount', 'type=bind,src=' + path.join(core, 'server') + ',dst=/reviewed-core/server,readonly',
    '--mount', 'type=bind,src=' + path.join(__dirname, 'native-supervisor-client.cjs') + ',dst=/qualification/client.cjs,readonly',
    '--entrypoint', 'node', imageId, '/qualification/client.cjs', clientMode];
  try {
    created = true;
    docker(['volume', 'create', '--label', 'com.docker.compose.project=' + name, '--label', 'com.docker.compose.volume=work', volume]);
    docker(['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--pids-limit', '32', '--memory', '256m', '--cpus', '1', '--mount', 'type=volume,src=' + volume + ',dst=/workspaces', '--entrypoint', 'node', imageId,
      '-e', 'require("fs").chmodSync("/workspaces",0o1777)']);
    compose(['up', '-d', '--no-build', 'code-sandbox']); id = compose(['ps', '-a', '-q', 'code-sandbox']).trim(); assert.ok(id);
    const actual = inspect(id);
    assert.equal(actual.Image, imageId); assert.equal(actual.Config.User, '1000:1000');
    assert.equal(actual.HostConfig.ReadonlyRootfs, true); assert.equal(actual.HostConfig.Privileged, false);
    assert.deepEqual(caps(actual.HostConfig.CapDrop), ['ALL']); assert.deepEqual(caps(actual.HostConfig.CapAdd), []);
    assert.ok(actual.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    assert.equal(actual.HostConfig.SecurityOpt.length, 1); assert.deepEqual(actual.HostConfig.GroupAdd || [], []);
    assert.equal(actual.HostConfig.PidMode, ''); assert.equal(actual.HostConfig.IpcMode, 'private');
    assert.equal(actual.HostConfig.PidsLimit, 512); assert.equal(actual.HostConfig.Memory, 3221225472);
    assert.equal(actual.HostConfig.NanoCpus, 2000000000);
    assert.ok(!actual.HostConfig.PortBindings || Object.keys(actual.HostConfig.PortBindings).length === 0);
    assert.deepEqual(Object.keys(actual.NetworkSettings.Networks), [network]);
    const netInfo = JSON.parse(docker(['network', 'inspect', network]))[0]; assert.equal(netInfo.Internal, true);
    assert.equal(netInfo.Id, actual.NetworkSettings.Networks[network].NetworkID);
    assert.ok(actual.Mounts.find((m) => m.Destination === '/workspaces' && m.Type === 'volume' && m.RW));
    assert.equal(actual.Mounts.length, cfg.volumes.length);
    assert.deepEqual(actual.Mounts.map((m) => m.Destination).sort(), cfg.volumes.map((m) => m.target).sort());
    assert.ok(actual.Mounts.every((m) => m.Destination === '/workspaces' || !m.RW));
    if (faults.has(mode)) {
      assert.equal(docker(['wait', id]).trim(), '2');
      const state = inspect(id).State; assert.equal(state.Running, false); assert.equal(state.OOMKilled, false);
      // Exact stderr is verified using the process result, not body-marker absence.
      const text = logs(id); assert.ok(text.includes(faults.get(mode)), text);
    } else {
      await ready(id); // Trusted startup log, before any client/health connection can admit a harness.
      let output = '', errors = '', done = false, workerSeen = false, pending = false, acted = false, awaitingIdle = false, audited = false, streamError = null;
      client = spawn('docker', clientArgs(mode), { stdio: ['pipe', 'pipe', 'pipe'] });
      client.stdout.on('data', (b) => {
        if (output.length + b.length >= 1024 * 1024) { streamError = Error('owned client stdout cap'); return; }
        output += b; pending ||= output.includes('"event":"pending"'); awaitingIdle ||= output.includes('"event":"await-idle"');
      });
      client.stderr.on('data', (b) => { if (errors.length + b.length >= 1024 * 1024) streamError = Error('owned client stderr cap'); else errors += b; });
      const exit = new Promise((resolve) => { client.once('error', (e) => { errors += e.message; done = true; resolve(-1); }); client.once('close', (code) => { done = true; resolve(code); }); });
      const end = Date.now() + (mode === 'pi-timeout-late' ? 390000 : 45000);
      while (!done && !streamError && Date.now() < end) {
        if (inspect(id).State.Running) workerSeen ||= /\/qualification\/native-supervisor-harness.cjs|\/srv\/pi-acp-bridge.cjs/.test(top(id).slice(1).join('\n'));
        if (!acted && workerSeen && pending) {
          if (['disconnect', 'pi-disconnect', 'pi-stubborn-disconnect', 'pi-protocol-cancel', 'pi-cancel-omission-control'].includes(mode)) { client.stdin.write('release\n'); acted = true; }
          if (mode === 'shutdown') { docker(['kill', '--signal', 'TERM', id]); acted = true; }
        }
        if (mode === 'pi-cancel-omission-control' && awaitingIdle && !audited) {
          await waitIdle(id); // No backend can write a late abort receipt after this actual teardown barrier.
          client.stdin.write('audit\n'); audited = true;
        }
        await delay(mode === 'pi-timeout-late' ? 2000 : 100);
      }
      if (streamError) throw streamError; // An event-stream bound must pass through scoped finally cleanup.
      assert.ok(done, 'owned client deadline: ' + output + errors); assert.equal(await exit, 0, output + errors);
      const result = JSON.parse(output.trim().split('\n').at(-1)); assert.equal(result.case, mode); assert.equal(result.complete, true);
      if (['disconnect', 'shutdown', 'wall', 'pi-disconnect', 'pi-stubborn-disconnect', 'pi-protocol-cancel', 'pi-cancel-omission-control'].includes(mode)) assert.equal(workerSeen, true, 'cancellation/expiry requires observed actual harness');
      if (mode === 'pi-cancel-omission-control') { assert.equal(audited, true); assert.equal(result.omissionControl, true); assert.equal(result.cancellationEvidenceAccepted, false); }
      if (mode.startsWith('escaped-')) {
        assert.equal(result.requiresNamespaceRecycle, true);
        const processRows = top(id), escaped = processRows.slice(1).filter((row) => row.includes('escaped.json'));
        assert.equal(escaped.length, 1, 'the actual detached fixture child must still exist');
        const fields = escaped[0].trim().split(/\s+/);
        assert.equal(Number(fields[0]), Number(fields[2])); assert.equal(Number(fields[0]), Number(fields[3]));
        assert.equal(Number(fields[1]), inspect(id).State.Pid, 'the escaped child was adopted by the namespace init');
        assert.equal(fields[4], processRows[1].trim().split(/\s+/)[4], 'host UID mapping matches the init; namespace UID1000 is checked by the fixture');
        docker(['kill', '--signal', 'TERM', id]); assert.equal(docker(['wait', id]).trim(), '0');
        assert.equal(inspect(id).State.Running, false); // Container-level cleanup, explicitly not per-session drain credit.
      } else if (mode === 'shutdown') assert.equal(docker(['wait', id]).trim(), '0');
      else {
        await waitIdle(id);
        if (mode === 'capacity') {
          const reuse = docker(clientArgs('reuse', '-reuse')); assert.equal(JSON.parse(reuse.trim().split('\n').at(-1)).complete, true); await waitIdle(id);
        }
        docker(['kill', '--signal', 'TERM', id]); assert.equal(docker(['wait', id]).trim(), mode.startsWith('node-') ? '143' : '0');
      }
      assert.equal(inspect(id).State.OOMKilled, false);
      console.log(JSON.stringify({ case: mode, workerSeen, result, boundary: mode.startsWith('escaped-') ? 'namespace-recycle-required' : 'live-supervisor-owned-group' }));
    }
    completed++; console.log('PASS native supervisor ' + mode);
  } catch (error) {
    if (id) { try { console.error(logs(id)); } catch { /* preserve original failure */ } }
    throw error;
  } finally {
    if (client && client.exitCode === null && client.signalCode === null) client.kill('SIGTERM');
    for (const suffix of ['', '-reuse']) { try { docker(['rm', '-f', clientName + suffix]); } catch { /* only owned clients, often already --rm */ } }
    if (created) compose(['down', '--volumes', '--timeout', '7']);
  }
}
(async () => {
  try {
    const container = run + '-artifact';
    try { docker(['create', '--name', container, imageId]); docker(['cp', container + ':/usr/local/libexec/noevia', artifact]); }
    finally { docker(['rm', '-f', container]); }
    for (let i = 0; i < cases.length; i++) await one(cases[i], i);
    assert.equal(completed, cases.length); console.log('Native supervisor isolated Linux qualification: ' + completed + ' PASS, 0 skipped');
  } finally { fs.rmSync(owned, { recursive: true, force: true }); }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
