'use strict';
// Owned isolated Node22 client, with the actual immutable Core ACP implementation mounted RO.
const assert = require('node:assert/strict'), fs = require('node:fs'), net = require('node:net');
if (process.platform !== 'linux' || process.getuid() !== 1000 || process.env.NOEVIA_NATIVE_SUPERVISOR_QUALIFICATION !== '1') throw Error('owned Linux qualification only');
const { connectAcp } = require('/reviewed-core/server/code-acp.cjs');
const mode = process.argv[2], endpoint = 'code-sandbox:8030', cwd = '/workspaces/task-' + mode;
fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
fs.mkdirSync(cwd + '/home', { recursive: true, mode: 0o700 });
fs.writeFileSync(cwd + '/case.json', JSON.stringify({ mode: mode === 'reuse' ? 'roundtrip' : mode }));
const emit = (value) => console.log(JSON.stringify(value));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadlineMs = mode === 'pi-timeout-late' ? 350000 : 30000;
const overall = setTimeout(() => { console.error('owned client deadline'); process.exit(2); }, deadlineMs);
const start = (where = cwd) => JSON.stringify({ noevia: 'start', cwd: where, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LD_PRELOAD: 'must-be-filtered', NODE_OPTIONS: 'must-be-filtered', PI_COMMAND: 'must-be-filtered' } }) + '\n';
function assertPiCancellationEvidence() {
  const refused = JSON.parse(fs.readFileSync(cwd + '/pi-refused.json', 'utf8'));
  const aborted = JSON.parse(fs.readFileSync(cwd + '/pi-aborted.json', 'utf8'));
  assert.deepEqual(refused, { mode, requested: true, confirmed: false, decisions: 1 });
  assert.deepEqual(aborted, { mode, requested: true, aborted: true, confirmed: false, decisions: 1 });
}
async function socket() {
  const end = Date.now() + 10000;
  for (;;) {
    try {
      return await new Promise((resolve, reject) => {
        const s = net.connect(8030, 'code-sandbox'); s.once('connect', () => { s.removeListener('error', reject); resolve(s); }); s.once('error', reject);
      });
    } catch (error) { if (!['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.code) || Date.now() >= end) throw error; await delay(50); }
  }
}
async function raw() {
  const s = await socket(); let bytes = 0, reset = false, text = '', frames = [], buffer = '';
  const rawBytes = ['slow-reader', 'stalled-reader', 'escaped-quiet', 'escaped-writer'].includes(mode);
  let signalFrame = () => {};
  s.on('data', (chunk) => {
    bytes += chunk.length; assert.ok(bytes <= (rawBytes ? 128 * 1024 * 1024 : 2 * 1024 * 1024));
    if (mode === 'slow-reader') for (const byte of chunk) assert.equal(byte, 120);
    if (!rawBytes) {
      buffer += chunk.toString('utf8'); let i;
      while ((i = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) { frames.push(JSON.parse(line)); signalFrame(); } }
      text += chunk.toString('utf8');
    }
  });
  let closed = false;
  const ended = new Promise((resolve, reject) => {
    s.on('error', (e) => { if (['ECONNRESET', 'ECONNABORTED'].includes(e.code)) reset = true; else reject(e); });
    s.on('close', () => { closed = true; signalFrame(); resolve(); });
  });
  void ended.catch(() => {}); // Preserve rejection for await, even during an intentional read pause.
  const until = async (predicate) => {
    while (!predicate()) {
      if (closed) throw Error('owned socket closed before expected frame: ' + text.slice(-4096));
      await Promise.race([ended, new Promise((resolve) => { signalFrame = resolve; })]);
    }
  };
  const send = (m) => s.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  try {
    if (mode === 'malformed') s.write('not-json\n');
    else if (mode === 'oversized') s.write('x'.repeat(70 * 1024));
    else if (mode === 'partial') s.write(start().slice(0, -1));
    else if (mode === 'outside' || mode === 'symlink') {
      if (mode === 'symlink') fs.symlinkSync('/etc', cwd + '/outside');
      s.write(start(mode === 'outside' ? '/etc' : cwd + '/outside'));
    } else if (rawBytes) {
      s.write(start());
      if (mode === 'slow-reader' || mode === 'stalled-reader') {
        s.pause(); await delay(mode === 'slow-reader' ? 250 : 3000); s.resume();
      }
    } else if (mode === 'fragment') {
      const line = start(); s.write(line.slice(0, 3)); await delay(50); assert.equal(frames.length, 0);
      s.write(line.slice(3) + JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
      await until(() => frames.some((m) => m.id === 1));
      send({ id: 2, method: 'session/new', params: { cwd, _meta: { noevia: { permission: { edits: 'ask' } } } } });
      await until(() => frames.some((m) => m.id === 2));
      send({ id: 3, method: 'session/prompt', params: { sessionId: 'owned-session', prompt: [{ type: 'text', text: 'synthetic' }] } });
      await until(() => frames.some((m) => m.id === 3));
      assert.equal(frames.find((m) => m.id === 3).result?.stopReason, 'end_turn'); s.destroy();
    } else if (mode === 'pi-timeout-late' || mode === 'pi-protocol-cancel') {
      s.write(start()); send({ id: 1, method: 'initialize', params: {} });
      await until(() => frames.some((m) => m.id === 1));
      send({ id: 2, method: 'session/new', params: { cwd } }); await until(() => frames.some((m) => m.id === 2));
      send({ id: 3, method: 'session/prompt', params: { sessionId: 'pi-1', prompt: [{ type: 'text', text: 'synthetic' }] } });
      await until(() => frames.some((m) => m.method === 'session/request_permission'));
      const asked = frames.find((m) => m.method === 'session/request_permission'), began = Date.now();
      const hasText = (value) => frames.some((m) => m.params?.update?.content?.text === value);
      if (mode === 'pi-protocol-cancel') {
        emit({ event: 'pending' }); await releaseOrFailure(ended);
        send({ id: asked.id, result: { outcome: { outcome: 'selected', optionId: 'reject_once' } } });
        await until(() => hasText('PERMISSION_REFUSED')); // Backend barrier, not a race-prone immediate file read.
        send({ method: 'session/cancel', params: { sessionId: 'pi-1' } });
      } else {
        await until(() => hasText('TIMEOUT_REFUSED'));
        assert.ok(Date.now() - began >= 299000, 'exercise the real five-minute CLI deadline, not a test-only shortened knob');
        // One TCP write: the expired answer is processed before the cancel barrier.
        s.write(JSON.stringify({ jsonrpc: '2.0', id: asked.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }) + '\n' +
          JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'pi-1' } }) + '\n');
      }
      await until(() => frames.some((m) => m.id === 3));
      if (mode === 'pi-timeout-late') assert.equal(hasText('LATE_REPLY_IGNORED'), true);
      else assertPiCancellationEvidence(); // Both backend records precede the actual cancelled ACP reply.
      assert.equal(frames.find((m) => m.id === 3).result?.stopReason, 'cancelled');
      s.destroy();
    } else throw Error('unknown raw case');
    await ended;
    if (mode === 'slow-reader') { assert.equal(reset, false); assert.equal(bytes, 8 * 1024 * 1024); }
    else if (['stalled-reader', 'escaped-quiet', 'escaped-writer'].includes(mode)) assert.equal(reset, true, 'uncertain inherited output must reset, never clean EOF');
    else if (['malformed', 'oversized', 'partial'].includes(mode)) assert.ok(frames.some((m) => /start message|too long|timed out/.test(m.error?.message || '')), text);
    else if (['outside', 'symlink'].includes(mode)) assert.ok(frames.some((m) => /not inside/.test(m.error?.message || '')), text);
    emit({ case: mode, complete: true, bytes, reset, requiresNamespaceRecycle: mode.startsWith('escaped-') });
  } finally { s.destroy(); }
}
async function releaseOrFailure(settled) {
  let release;
  const data = new Promise((resolve) => { release = resolve; process.stdin.once('data', release); });
  try { await (settled ? Promise.race([data, settled.then(() => { throw Error('request settled before observed-worker release'); })]) : data); }
  finally { process.stdin.removeListener('data', release); process.stdin.pause(); }
}
async function actual() {
  const controller = new AbortController(); let pendingPermission, refusedBarrier, cancelNotifications = 0;
  const deferred = new Promise((resolve) => { pendingPermission = resolve; });
  const refused = new Promise((resolve) => { refusedBarrier = resolve; });
  const h = {
    requestPermission: async (p) => {
      if (mode.startsWith('pi-')) assert.equal(p.toolCall.kind, 'execute');
      if (['pi-disconnect', 'pi-stubborn-disconnect', 'pi-cancel-omission-control'].includes(mode)) { emit({ event: 'pending' }); return deferred; }
      return { outcome: 'selected', optionId: mode === 'pi-deny' ? 'reject_once' : mode === 'permissions' ? 'yes' : 'allow_once',
        ...(mode === 'pi-deny' ? { _meta: { noevia: { reason: 'owned synthetic refusal' } } } : {}) };
    },
    readTextFile: async () => ({ content: 'owned read' }), writeTextFile: async () => null,
    sessionUpdate: (u) => { if (u.content?.text === 'OWNED_PENDING') emit({ event: 'pending' }); if (u.content?.text === 'PERMISSION_REFUSED') refusedBarrier(); },
  };
  const agent = await connectAcp({ endpoint, cwd, home: cwd + '/home', env: { PATH: '/usr/local/bin:/usr/bin:/bin', LD_PRELOAD: 'filtered', NODE_OPTIONS: 'filtered', PI_COMMAND: 'filtered' },
    permission: { edits: 'ask' }, handlers: h, signal: controller.signal, handshakeMs: 10000,
    connectFn: (...args) => {
      const channel = net.connect(...args), write = channel.write;
      channel.write = function (chunk, ...rest) {
        try { for (const line of String(chunk).split('\n').filter(Boolean)) if (JSON.parse(line).method === 'session/cancel') cancelNotifications++; } catch { /* observation cannot alter transport */ }
        return write.call(this, chunk, ...rest);
      };
      return channel;
    } });
  const result = agent.prompt('owned synthetic prompt');
  const observed = result.then((value) => ({ value }), (error) => ({ error: error.message }));
  if (['disconnect', 'pi-disconnect', 'pi-stubborn-disconnect'].includes(mode)) {
    await releaseOrFailure(observed); controller.abort();
    assert.equal(cancelNotifications, 1, 'the real Core client must emit its cancel notification; delivery after immediate close is not claimed');
  }
  if (mode === 'pi-cancel-omission-control') {
    await releaseOrFailure(observed); pendingPermission({ outcome: 'selected', optionId: 'reject_once' });
    await Promise.race([refused, observed.then(() => { throw Error('turn settled before backend refusal barrier'); })]);
    agent.stop(); // Deliberate protocol omission: public transport stop, not AbortController.notify.
    const outcome = await observed; assert.ok(outcome.error); assert.equal(cancelNotifications, 0);
    emit({ event: 'await-idle' }); await releaseOrFailure(null); // Host releases only after actual live-init-only observation.
    assert.deepEqual(JSON.parse(fs.readFileSync(cwd + '/pi-refused.json', 'utf8')), { mode, requested: true, confirmed: false, decisions: 1 });
    assert.throws(() => assertPiCancellationEvidence(), (error) => error.code === 'ENOENT');
    emit({ case: mode, complete: true, localError: true, cancellationEvidenceAccepted: false, omissionControl: true }); return;
  }
  if (mode === 'capacity') {
    const s = await socket(); let text = '';
    await new Promise((resolve, reject) => { s.on('data', (b) => { text += b; assert.ok(text.length <= 65536); }); s.on('error', reject); s.on('close', resolve); });
    assert.match(text, /already running 1 agents/); controller.abort();
  }
  const outcome = await observed;
  if (['disconnect', 'shutdown', 'wall', 'capacity', 'pi-disconnect', 'pi-stubborn-disconnect'].includes(mode)) assert.ok(outcome.error, JSON.stringify(outcome));
  else {
    assert.equal(outcome.error, undefined); assert.equal(outcome.value.stopReason, 'end_turn');
    if (!mode.startsWith('pi-')) {
      assert.equal(outcome.value.evidence.uid, 1000); assert.equal(outcome.value.evidence.cwd, cwd);
      assert.equal(outcome.value.evidence.home, cwd + '/home');
      if (mode === 'permissions') {
        assert.deepEqual(outcome.value.seen[0].result, { outcome: { outcome: 'selected', optionId: 'yes' } });
        assert.deepEqual(outcome.value.seen[1].result, { content: 'owned read' }); assert.equal(outcome.value.seen[2].result, null);
      }
    } else {
      const decision = JSON.parse(fs.readFileSync(cwd + '/pi-decision.json', 'utf8'));
      assert.equal(decision.confirmed, mode === 'pi-allow'); if (mode === 'pi-deny') assert.equal(decision.readOnce, true);
    }
  }
  pendingPermission({ outcome: 'selected', optionId: 'reject_once' });
  emit({ case: mode, complete: true, cancelled: Boolean(outcome.error) });
}
(async () => {
  try {
    const rawModes = ['malformed', 'oversized', 'partial', 'outside', 'symlink', 'fragment', 'slow-reader', 'stalled-reader', 'escaped-quiet', 'escaped-writer', 'pi-timeout-late', 'pi-protocol-cancel'];
    if (rawModes.includes(mode)) await raw(); else await actual();
  } finally { clearTimeout(overall); }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
