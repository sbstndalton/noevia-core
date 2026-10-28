'use strict';
// Run only in the owned Node container, beside the exact Core checkout and shared socket.
const assert = require('node:assert/strict'), net = require('node:net');
if (process.env.NOEVIA_NATIVE_VERIFIER_QUALIFICATION !== '1' || process.platform !== 'linux') throw Error('isolated qualification context required');
const fs = require('node:fs');
const { assertRefusal, assertNotAdmitted, assertFinalAdmission } = require('./native-verifier-assertions.cjs');
const { waitForCancellation } = require('./native-verifier-cancel.cjs');
const { createCodeVerify, isMeasured } = require('/reviewed-core/server/code-verify.cjs');
const mode = process.argv[2], headSha = process.argv[3];
const socketPath = '/run/noevia-verify/verify.sock';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function connect() {
  const end = Date.now() + 15000;
  for (;;) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.connect({ path: socketPath });
        socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); });
        socket.once('error', reject);
      });
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code) || Date.now() >= end) throw error;
      await delay(50);
    }
  }
}
async function raw() {
  const socket = await connect();
  const request = { noevia: 'verify', repo: 'synthetic', source: '/workspaces/synthetic', headSha, nonce: 'ab'.repeat(16) };
  const line = JSON.stringify(request) + '\n';
  let bytes = '';
  const closed = new Promise((resolve, reject) => {
    socket.on('data', (b) => { bytes += b.toString('utf8'); assert.ok(Buffer.byteLength(bytes) <= 2 * 1024 * 1024); });
    socket.on('error', (e) => { if (e.code !== 'ECONNRESET' && e.code !== 'EPIPE') reject(e); });
    socket.on('close', resolve);
  });
  const timer = setTimeout(() => socket.destroy(Error('qualification socket deadline')), 20000);
  try {
    if (mode === 'malformed') socket.write('{not-json}\n');
    else if (mode === 'partial') socket.write(line.slice(0, -1));
    else if (mode === 'oversized') socket.write('x'.repeat(65536));
    else if (mode === 'disconnect') {
      socket.write(line);
      // The host observer releases cancellation only after actual command admission.
      await waitForCancellation(process.stdin, closed);
      socket.destroy();
    }
    else if (mode === 'shutdown') { socket.write(line); console.log('SHUTDOWN_REQUEST_SENT'); }
    else throw Error('unknown raw case');
    await closed;
    assert.equal(bytes, '', 'refusal/cancellation cannot return a passing measurement');
    console.log(JSON.stringify({ case: mode, noAnswer: true }));
  } catch (error) {
    // Owned synthetic protocol bytes explain a premature close without trusting them.
    let receipt;
    try { receipt = admissionReceipt(); } catch (receiptError) { receipt = { unavailable: receiptError.code || 'invalid' }; }
    throw Error(error.message + '; received=' + JSON.stringify(bytes.slice(-4096)) + '; admission=' + JSON.stringify(receipt));
  } finally { clearTimeout(timer); socket.destroy(); }
}
function admissionReceipt() {
  const fd = fs.openSync('/run/noevia-verify/.noevia-native-admission.json',
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    assert.ok(stat.isFile()); assert.equal(stat.nlink, 1);
    assert.equal(stat.uid, 0); assert.equal(stat.gid, 0);
    assert.equal(stat.mode & 0o7777, 0o600); assert.ok(stat.size <= 1024);
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
async function measured() {
  const taskId = 'owned-qualification', revision = 3, nonce = 'cd'.repeat(16);
  const witnessed = ['copy-deadline', 'copy-descendant', 'admission-witness-control', 'admission-early-control'].includes(mode);
  if (witnessed) assertNotAdmitted('/qualification-proof');
  const verify = createCodeVerify({ endpoint: 'unix:' + socketPath,
    timeoutMs: 20000, connectRetryMs: 15000, tailBytes: 1024, nonceFn: () => nonce });
  const targetHead = mode === 'bad-head' ? '1'.repeat(40) : headSha;
  const result = await verify.run({ taskId, revision, repo: mode === 'unconfigured' ? 'other' : 'synthetic',
    headSha: targetHead, workspaces: { verifyCheckout: (id, head) => {
      assert.equal(id, taskId); assert.equal(head, targetHead);
      return { source: '/workspaces/synthetic' };
    } } });
  if (['bad-head', 'unconfigured', 'hostile-config', 'copy-deadline'].includes(mode)) {
    assertRefusal(mode, result);
    assertFinalAdmission(admissionReceipt(), nonce, 0);
    if (mode === 'copy-deadline') assertNotAdmitted('/qualification-proof');
  } else if (mode === 'saturation') {
    assert.notEqual(result.status, 'passed');
    assert.equal(result.report?.passed ?? false, false);
  } else {
    assert.ok(result.report, JSON.stringify(result));
    const receipt = admissionReceipt();
    assertFinalAdmission(receipt, nonce, 1);
    assert.equal(isMeasured(result.report, { taskId, headSha, revision }), true);
    assert.equal(Object.isFrozen(result.report), true);
    assert.equal(isMeasured(JSON.parse(JSON.stringify(result.report)), { taskId, headSha, revision }), false);
    for (const mismatch of [{ taskId: 'other' }, { headSha: '2'.repeat(40) }, { revision: 4 }]) {
      assert.equal(isMeasured(result.report, { taskId, headSha, revision, ...mismatch }), false);
    }
    if (mode === 'admission-early-control') {
      assert.equal(result.status, 'failed'); assert.equal(result.report.exitCode, 1);
      assertNotAdmitted('/qualification-proof'); // No JavaScript payload marker was reached.
      assert.throws(() => assertFinalAdmission(receipt, nonce, 0));
    } else if (mode === 'fail') {
      assert.equal(result.status, 'failed'); assert.equal(result.report.exitCode, 7);
    } else if (mode === 'timeout') {
      assert.equal(result.status, 'failed'); assert.equal(result.report.timedOut, true);
    } else {
      assert.equal(result.status, 'passed', JSON.stringify(result));
      assert.equal(result.report.exitCode, 0); assert.equal(result.report.timedOut, false);
      if (mode === 'identity') assert.match(result.report.tail, /IDENTITY_AND_ISOLATION_OK/);
      if (mode === 'detached' || mode === 'pipe') assert.match(result.report.tail, /ESCAPED_DESCENDANT_STARTED/);
      if (mode === 'copy-descendant') {
        const proof = JSON.parse(fs.readFileSync('/qualification-proof/copy-started', 'utf8'));
        assert.equal(proof.uid, 1002); assert.ok(Number.isInteger(proof.pid) && proof.pid > 0);
      }
      if (mode === 'admission-witness-control') {
        // Real admitted execution must trip the same witness used by copy-deadline,
        // even if a later failure were to prevent any report from being returned.
        assert.throws(() => assertNotAdmitted('/qualification-proof'), /operator command was admitted/);
        const proof = JSON.parse(fs.readFileSync('/qualification-proof/operator-started', 'utf8'));
        assert.equal(proof.uid, 1003);
        assert.throws(() => assertFinalAdmission(receipt, nonce, 0));
      }
      if (mode === 'clone') {
        assert.match(result.report.tail, /COPY_NOEXEC_AND_ARTIFACT_BINDING_OK/);
        assert.match(result.report.tail, /NON_SIGCHLD_CLONE_READY/);
        assert.match(result.report.tail, /ADOPTED_CLONE_SIGCHLD_DRAIN_CASE/);
        assert.match(result.report.tail, /CLONE_FIXTURE_PARENT_EXITED/);
      }
      if (mode === 'tail') {
        assert.equal(result.report.truncated, true); assert.ok(result.report.totalBytes >= 2 * 1024 * 1024);
        assert.ok(Buffer.byteLength(result.report.tail) <= 1024);
        assert.ok(!result.report.tail.includes('\u001b')); assert.ok(!result.report.tail.includes('\u0000'));
      }
    }
  }
  console.log(JSON.stringify({ case: mode, status: result.status, report: result.report, error: result.error }));
}
(['malformed', 'partial', 'oversized', 'disconnect', 'shutdown'].includes(mode) ? raw() : measured())
  .catch((error) => { console.error(error.stack); process.exitCode = 1; });
