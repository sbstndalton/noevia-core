'use strict';
// The sandbox supervisor lives in services/code-sandbox; it is tested from here because this is
// where the suite runs, and because the two ends of the pipe have to agree.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { createSupervisor, insideRoot, cleanEnv } = require('../../../services/code-sandbox/supervisor.cjs');
const { connectAcp } = require('./code-acp.cjs');

const AGENT = require.resolve('./fixtures/fake-acp-agent.cjs');
const temps = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-sbx-')); temps.push(d); return d; };
// Every supervisor this file starts, closed when it ends. A listening server keeps the test
// process alive forever, and an earlier version of this file left runners behind for 20 minutes.
const supervisors = [];
test.after(async () => {
  for (const s of supervisors) { try { await s.close(); } catch { /* already closed */ } }
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

test('a workspace outside the root is refused, symlinks included', () => {
  const root = temp(), outside = temp();
  fs.mkdirSync(path.join(root, 'task-1'));
  fs.symlinkSync(outside, path.join(root, 'escape'));
  assert.equal(insideRoot(root, path.join(root, 'task-1')), fs.realpathSync(path.join(root, 'task-1')));
  assert.equal(insideRoot(root, root), fs.realpathSync(root));
  assert.equal(insideRoot(root, outside), null);
  assert.equal(insideRoot(root, path.join(root, 'escape')), null, 'a symlink out of the root is out of the root');
  assert.equal(insideRoot(root, path.join(root, 'does-not-exist')), null);
  assert.equal(insideRoot(root, '/etc'), null);
  assert.equal(insideRoot(root, ''), null);
  assert.equal(insideRoot('/nowhere-at-all', root), null);
});

test('the sandbox supplies its own HOME when noevia sends none', () => {
  assert.equal(cleanEnv({}, '/home/node').HOME, '/home/node');
  assert.equal(cleanEnv({ HOME: '/workspaces/trees/.harness-home/x' }, '/home/node').HOME, '/workspaces/trees/.harness-home/x');
  assert.equal(cleanEnv({}, null).HOME, undefined, 'and invents nothing when there is none');
});

test('only an allowlist of environment variables crosses into the sandbox', () => {
  const out = cleanEnv({ HOME: '/work/t1', HTTPS_PROXY: 'http://task:tok@egress', PATH: '/usr/bin',
    AWS_SECRET_ACCESS_KEY: 'nope', COWORK_SESSION_SECRET: 'nope', LD_PRELOAD: '/evil.so', HOME_EXTRA: 'nope' });
  assert.deepEqual(out, { HOME: '/work/t1', HTTPS_PROXY: 'http://task:tok@egress', PATH: '/usr/bin' });
  assert.deepEqual(cleanEnv({ HOME: 'x'.repeat(5000) }, null), {}, 'an absurd value is dropped');
  assert.deepEqual(cleanEnv({ HOME: 12 }, null), {});
  assert.deepEqual(cleanEnv(null, null), {});
});

async function sandbox(script = []) {
  const root = temp();
  const work = path.join(root, 'task-1');
  fs.mkdirSync(work);
  const logs = [];
  const sup = createSupervisor({ command: process.execPath, args: [AGENT], root, graceMs: 50,
    log: (line) => logs.push(line),
    // The real supervisor takes the agent from its own env; here the script rides along so the
    // fake agent behaves, without the start message being able to choose a command.
    spawnFn: (cmd, args, opts) => require('node:child_process').spawn(cmd, args,
      { ...opts, env: { ...opts.env, SCRIPT: JSON.stringify(script) } }),
  });
  supervisors.push(sup);
  const address = await sup.listen(0, '127.0.0.1');
  return { sup, root, work, logs, endpoint: `127.0.0.1:${address.port}` };
}
const handlers = () => {
  const seen = { updates: [], permissions: [] };
  return [{
    requestPermission: async (p) => { seen.permissions.push(p); return { outcome: 'selected', optionId: 'y' }; },
    readTextFile: async () => ({ content: 'x' }), writeTextFile: async () => null,
    sessionUpdate: (u) => seen.updates.push(u),
  }, seen];
};

test('noevia drives an agent in the sandbox exactly as it drives a local one', async () => {
  const { sup, work, endpoint } = await sandbox([
    { update: { sessionUpdate: 'tool_call', toolCallId: '1', kind: 'edit', title: 'Edit a.txt' } },
    { permission: { toolCall: { kind: 'edit' }, options: [{ optionId: 'y', kind: 'allow_once' }] } },
  ]);
  const [h, seen] = handlers();
  const agent = await connectAcp({ endpoint, cwd: work, handlers: h, graceMs: 50 });
  const result = await agent.prompt('do it');
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(seen.updates.map((u) => u.sessionUpdate), ['tool_call']);
  assert.equal(seen.permissions.length, 1, 'the approval still comes back to noevia');
  // Nested, as ACP requires: the agent reads `result.outcome.outcome`, and the unwrapped shape
  // reads to it as a rejection.
  assert.deepEqual(result.seen[0].result, { outcome: { outcome: 'selected', optionId: 'y' } });
  assert.equal(result.seen[0].noeviaSaid, 'selected', 'the sandbox agent understood it as an approval');
  await sup.close();
});

test('the sandbox refuses a workspace it was not given, and says so in the task', async () => {
  const { sup, endpoint } = await sandbox();
  const [h] = handlers();
  await assert.rejects(() => connectAcp({ endpoint, cwd: '/etc', handlers: h, graceMs: 50, handshakeMs: 2000 }),
    /not inside this sandbox|closed the connection/);
  await sup.close();
});

test('a first line that is not noevia’s start message starts nothing', async () => {
  const { sup, endpoint, logs } = await sandbox();
  const refusal = (payload) => new Promise((resolve, reject) => {
    const socket = net.connect(Number(endpoint.split(':')[1]), '127.0.0.1', () => socket.write(payload));
    let out = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => { out += d; });
    socket.on('close', () => resolve(out));
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); resolve(out); }, 2000).unref();
  });
  assert.match(await refusal('not json\n'), /start message/);
  assert.match(await refusal(JSON.stringify({ jsonrpc: '2.0', method: 'initialize' }) + '\n'), /start message/,
    'speaking ACP straight at the supervisor does not start an agent');
  assert.match(await refusal('x'.repeat(70 * 1024)), /too long/, 'an endless first line is not buffered forever');
  assert.equal(logs.some((l) => l.startsWith('started ')), false, 'nothing was ever spawned');
  await sup.close();
});

test('hanging up stops the agent, even one that ignores cancellation', async () => {
  const { sup, work, endpoint, logs } = await sandbox([{ hang: true }]);
  const [h] = handlers();
  const controller = new AbortController();
  const agent = await connectAcp({ endpoint, cwd: work, handlers: h, graceMs: 50, signal: controller.signal });
  const settled = agent.prompt('x').then(() => 'resolved', () => 'rejected');
  setTimeout(() => controller.abort(), 50);
  assert.equal(await settled, 'rejected');
  // The supervisor owns the process group it started, so noevia never reaches across the
  // container boundary to kill anything.
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(logs.some((l) => l.startsWith('started ')), 'it did start');
  await sup.close();
});

test('an unreachable sandbox is a clear failure, not a hang', async () => {
  const [h] = handlers();
  await assert.rejects(() => connectAcp({ endpoint: '127.0.0.1:1', cwd: temp(), handlers: h, graceMs: 50, handshakeMs: 2000 }),
    /unreachable|refused/);
});

test('a malformed endpoint is a configuration error, named as one', async () => {
  const [h] = handlers();
  for (const endpoint of ['not-an-endpoint', '127.0.0.1', 'host:notaport', '']) {
    await assert.rejects(() => connectAcp({ endpoint: endpoint || null, command: endpoint ? null : '', cwd: temp(), handlers: h }),
      /CODE_HARNESS_ENDPOINT should be host:port|No coding harness is configured/, JSON.stringify(endpoint));
  }
});

// The compose override is the security control, so it gets a test — the same reasoning that
// keeps MCP_INTERNAL_PORT out of `ports:`. Read as text: pulling in a YAML parser for six
// assertions would be a dependency for nothing.
test('the sandbox override stays hardened and unpublished', () => {
  const file = path.join(__dirname, '../../../deploy/examples/code-sandbox.override.yml');
  const yaml = fs.readFileSync(file, 'utf8');
  const code = yaml.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  assert.doesNotMatch(code, /\bports:/, 'publishing this port lets anything on the host start a coding agent');
  assert.match(code, /read_only:\s*true/);
  assert.match(code, /cap_drop:\s*\["ALL"\]/);
  assert.match(code, /no-new-privileges:true/);
  assert.match(code, /user:\s*"1000:1000"/);
  assert.match(code, /pids_limit:/);
  assert.match(code, /mem_limit:/);
  assert.match(code, /internal:\s*true/, 'the sandbox network must not reach the rest of the box');
  assert.doesNotMatch(code, /docker\.sock/, 'a socket holder is the finding this design exists to avoid');
  // The harness is pinned: an agent that updates itself is an unreviewed supply-chain change in
  // the one container allowed to run arbitrary commands.
  // Pinned: an exact version, or a variable whose default is an exact version (the live .env pins its own).
  assert.match(code, /HARNESS_VERSION:\s*"(\d+\.\d+\.\d+|\$\{[A-Z_]+:-\d+\.\d+\.\d+\})"/);
  const dockerfile = fs.readFileSync(path.join(__dirname, '../../../services/code-sandbox/Dockerfile'), 'utf8');
  assert.match(dockerfile, /^USER node$/m, 'nothing in the sandbox runs as root');
  assert.match(dockerfile, /ARG HARNESS_VERSION=\d+\.\d+\.\d+/);
  assert.match(dockerfile, /pi-coding-agent[\s\S]*npm install -g --ignore-scripts/,
    'the pinned pi install follows upstream and cannot run package lifecycle scripts');
});

// A raw supervisor whose agent is an inline script, for the lifetime tests below.
async function rawSandbox(agentScript) {
  const root = temp();
  fs.mkdirSync(path.join(root, 'task-1'));
  const logs = [];
  const sup = createSupervisor({ command: process.execPath, args: ['-e', agentScript], root, graceMs: 50,
    log: (line) => logs.push(line) });
  supervisors.push(sup);
  const { port } = await sup.listen(0, '127.0.0.1');
  const start = JSON.stringify({ noevia: 'start', cwd: path.join(root, 'task-1') }) + '\n';
  return { sup, logs, port, start };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (fn, ms = 3000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return fn();
};

test('an agent that exits does not leave its background children running', async () => {
  // The agent starts a sleeper in its own process group, reports its pid, and exits.
  const { sup, port, start } = await rawSandbox(`
    const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stdout.write(JSON.stringify({ sleeper: c.pid }) + '\\n');
    c.unref(); setTimeout(() => process.exit(0), 100);`);
  let sleeper = null;
  const socket = net.connect(port, '127.0.0.1', () => socket.write(start));
  socket.setEncoding('utf8');
  let out = '';
  socket.on('data', (d) => { out += d; const m = out.match(/"sleeper":(\d+)/); if (m) sleeper = Number(m[1]); });
  await new Promise((r) => socket.on('close', r));
  assert.ok(sleeper, 'the fake agent reported its background child');
  try {
    assert.ok(await waitFor(() => !alive(sleeper)), 'the background child was killed with the group');
  } finally { try { process.kill(sleeper, 'SIGKILL'); } catch { /* already dead */ } }
  await sup.close();
});

test('nothing after a refusal or an exited agent can start another agent', async () => {
  const { sup, port, start, logs } = await rawSandbox('setTimeout(() => process.exit(0), 50)');
  const send = (payload, delayed) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(payload);
      if (delayed) setTimeout(() => { try { socket.write(delayed); } catch { /* closed */ } }, 300);
    });
    socket.on('data', () => {});
    socket.on('error', () => {});
    socket.on('close', resolve);
    setTimeout(() => { socket.destroy(); resolve(); }, 3000).unref();
  });
  await send('not json\n' + start);
  await send('not json\n', start);
  assert.equal(logs.filter((l) => l.startsWith('started ')).length, 0, 'a refused connection starts nothing');
  await send(start, start);
  assert.equal(logs.filter((l) => l.startsWith('started ')).length, 1, 'one agent per connection, even after it exits');
  await send('x'.repeat(70 * 1024) + 'y'.repeat(70 * 1024));
  assert.equal(logs.filter((l) => l === 'refused: start line too long').length, 1, 'refused once, not per chunk');
  await sup.close();
});

// ---- #115: the supervisor's own limits, with a fake spawn ----
function fakeSpawn() {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const spawned = [];
  const fn = () => {
    const child = new EventEmitter();
    child.pid = 90000 + spawned.length;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    spawned.push(child);
    return child;
  };
  return { fn, spawned };
}
const startLine = (cwd) => JSON.stringify({ noevia: 'start', cwd, env: {} }) + '\n';
function dial(port, cwd) {
  const socket = net.connect(port, '127.0.0.1');
  let data = '';
  socket.setEncoding('utf8');
  socket.on('data', (d) => { data += d; });
  socket.on('error', () => {});
  const closed = new Promise((r) => socket.on('close', r));
  socket.on('connect', () => { if (cwd) socket.write(startLine(cwd)); });
  return { socket, closed, data: () => data };
}
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

test('connections beyond the cap are refused with a JSON-RPC error, and a slot frees on close', async () => {
  const root = temp(); const work = path.join(root, 't'); fs.mkdirSync(work);
  const { fn, spawned } = fakeSpawn();
  const kills = [];
  const sup = createSupervisor({ command: 'agent', root, spawnFn: fn, graceMs: 10, maxConnections: 2,
    kill: (pid, sig) => kills.push([pid, sig]) });
  supervisors.push(sup);
  const { port } = await sup.listen(0, '127.0.0.1');
  const a = dial(port, work), b = dial(port, work);
  await until(() => spawned.length === 2);
  const c = dial(port, work);
  await c.closed;
  const reply = JSON.parse(c.data().trim());
  assert.equal(reply.jsonrpc, '2.0');
  assert.match(reply.error.message, /already running 2 agents/);
  assert.equal(spawned.length, 2, 'the refused connection started nothing');
  a.socket.destroy(); await a.closed;
  await until(() => sup.live() === 1);
  const d = dial(port, work);
  await until(() => spawned.length === 3);
  b.socket.destroy(); d.socket.destroy(); await Promise.all([b.closed, d.closed]);
  await sup.close();
});

test('an agent past its wall-clock limit gets SIGTERM, then SIGKILL, and the connection ends', async () => {
  const root = temp(); const work = path.join(root, 't'); fs.mkdirSync(work);
  const { fn, spawned } = fakeSpawn();
  const kills = [];
  const sup = createSupervisor({ command: 'agent', root, spawnFn: fn, graceMs: 20, maxWallMs: 50,
    kill: (pid, sig) => kills.push([pid, sig]) });
  supervisors.push(sup);
  const { port } = await sup.listen(0, '127.0.0.1');
  const a = dial(port, work);
  await a.closed;
  assert.equal(spawned.length, 1);
  assert.match(a.data(), /time limit/);
  await until(() => kills.length === 2);
  assert.deepEqual(kills, [[-spawned[0].pid, 'SIGTERM'], [-spawned[0].pid, 'SIGKILL']]);
  await until(() => sup.live() === 0);
  await sup.close();
});

test('the start-message allowlist carries the pinned curl/wget config paths (#224)', () => {
  assert.deepEqual(cleanEnv({ CURL_HOME: '/nonexistent', WGETRC: '/dev/null' }, null), { CURL_HOME: '/nonexistent', WGETRC: '/dev/null' });
});
