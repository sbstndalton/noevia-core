'use strict';
// noevia's pi bridge lives in services/code-sandbox; tested here, end to end through noevia's own
// ACP client, against a fake `pi --mode rpc` that speaks pi's documented event shapes.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { connectAcp } = require('./code-acp.cjs');
const { toolCallFor, piArgsFor } = require('../../../services/code-sandbox/pi-acp-bridge.cjs');
const { classify, ACTIONS } = require('./code-actions.cjs');

const BRIDGE = require.resolve('../../../services/code-sandbox/pi-acp-bridge.cjs');
const FAKE_PI = require.resolve('./fixtures/fake-pi-rpc.cjs');

test('an allowed pi command reaches noevia as a classifiable permission request and runs', async (t) => {
  const r = await runWithShim(t, (p) => ({ outcome: 'selected', optionId: p.options.find((o) => o.kind === 'allow_once').optionId }));
  const outcome = await r.agent.prompt('clean the build folder');
  assert.equal(outcome.stopReason, 'end_turn');
  assert.equal(r.asked.length, 1);
  const call = r.asked[0].toolCall;
  assert.equal(call.kind, 'execute');
  assert.deepEqual(call.rawInput, { command: 'rm -rf build' });
  assert.equal(classify(call).action, ACTIONS.DELETE, 'noevia sees the real command, so a delete is classified as one');
  assert.equal(r.log(), 'ran');
  assert.ok(r.updates.some((u) => u.sessionUpdate === 'agent_message_chunk' && /Done/.test(u.content.text)));
  assert.ok(r.updates.some((u) => u.sessionUpdate === 'agent_message_chunk' && /Settled/.test(u.content.text)),
    'agent_end does not truncate a continuation before agent_settled');
  assert.ok(r.updates.some((u) => u.sessionUpdate === 'tool_call' && u.toolCallId === 'call_1'));
});

test('declining, cancelling or an odd answer never lets the command run', async (t) => {
  for (const answer of [
    (p) => ({ outcome: 'selected', optionId: p.options.find((o) => o.kind === 'reject_once').optionId }),
    () => ({ outcome: 'cancelled' }),
    () => ({ outcome: 'selected', optionId: 'allow_always' }),
    () => { throw Error('card closed'); },
  ]) {
    const r = await runWithShim(t, answer);
    await r.agent.prompt('clean');
    assert.equal(r.log(), 'blocked');
  }
});

test('tool mapping: edits carry their path, unknown tools are "other" (gated like a command)', () => {
  assert.deepEqual(toolCallFor({ toolCallId: 'x', toolName: 'write', input: { path: 'src/a.js', content: 'y' } }).locations, [{ path: 'src/a.js' }]);
  assert.equal(toolCallFor({ toolName: 'edit', input: { path: 'a' } }).kind, 'edit');
  assert.equal(toolCallFor({ toolName: 'read', input: { path: 'a' } }).kind, 'read');
  assert.equal(toolCallFor({ toolName: 'mystery', input: {} }).kind, 'other');
  assert.equal(classify(toolCallFor({ toolName: 'mystery', input: {} })).action, ACTIONS.EXECUTE);
});

async function runWithShim(t, answer, command) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-pi-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'pi.log');
  const asked = [], updates = [];
  // PI_COMMAND must be one executable; a shell script runs node on the fixture and drops pi's flags.
  const exe = path.join(dir, 'pi');
  fs.writeFileSync(exe, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_PI)}\n`, { mode: 0o755 });
  const agent = await connectAcp({ command: process.execPath, args: [BRIDGE], cwd: dir, home: dir,
    env: { PI_COMMAND: exe, FAKE_PI_LOG: logFile, ...(command ? { FAKE_PI_COMMAND: command } : {}) },
    handlers: {
      requestPermission: async (p) => { asked.push(p); return answer(p); },
      readTextFile: async () => { throw Error('not used'); }, writeTextFile: async () => { throw Error('not used'); },
      sessionUpdate: (u) => updates.push(u),
    } });
  return { agent, asked, updates, log: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim() : '') };
}

test('other dialogs and confirms without noevia’s payload are refused without asking', async () => {
  const { PassThrough } = require('node:stream'), { EventEmitter } = require('node:events');
  const { createBridge } = require('../../../services/code-sandbox/pi-acp-bridge.cjs');
  const input = new PassThrough(), output = new PassThrough(), toPi = [];
  const fakePi = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: { writable: true, write: (line) => { toPi.push(JSON.parse(line)); return true; } }, kill() {} });
  createBridge({ input, output, env: { HOME: '/task-home' }, spawnFn: () => fakePi });
  const sent = []; output.setEncoding('utf8'); output.on('data', (d) => d.split('\n').filter(Boolean).forEach((l) => sent.push(JSON.parse(l))));
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/w' } }) + '\n');
  await new Promise((r) => setImmediate(r));
  for (const req of [{ id: 'a', method: 'select', options: ['x'] }, { id: 'b', method: 'confirm', message: 'not json' },
    { id: 'c', method: 'confirm', message: JSON.stringify({ toolName: 'bash' }) }, { id: 'd', method: 'notify', message: 'hi' }]) {
    fakePi.stdout.write(JSON.stringify({ type: 'extension_ui_request', ...req }) + '\n');
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(toPi.filter((m) => m.type === 'extension_ui_response'), [
    { type: 'extension_ui_response', id: 'a', cancelled: true },
    { type: 'extension_ui_response', id: 'b', confirmed: false },
    { type: 'extension_ui_response', id: 'c', confirmed: false },
  ]);
  assert.ok(!sent.some((m) => m.method === 'session/request_permission'), 'nothing reached the user as a question');
});

test('pi starts offline with no discovered resources, persistence or project trust', () => {
  assert.deepEqual(piArgsFor({ HOME: '/workspaces/.harness-home/task-1' }), [
    '--mode', 'rpc', '--offline', '--no-session', '--no-approve', '--no-context-files', '--no-extensions',
    '--extension', '/workspaces/.harness-home/task-1/.pi/agent/extensions/noevia-gate.js',
    '--no-skills', '--no-prompt-templates', '--no-themes',
    '--tools', 'read,bash,edit,write,grep,find,ls',
  ]);
  assert.throws(() => piArgsFor({}), /private HOME/);
  assert.throws(() => piArgsFor({ HOME: 'relative' }), /private HOME/);
});
