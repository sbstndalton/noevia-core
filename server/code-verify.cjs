'use strict';
// Server-measured verification for Code tasks (#703, part of #511).
//
// The pipeline (#705) asks one question after the Executor's work is on the branch: do the
// operator's tests pass at exactly this commit? This module answers it without believing anything
// the agent said. code-workspace.cjs `verifyCheckout` names the SOURCE repository and checks the
// commit is the released branch's tip; the verifier (services/code-sandbox/verifier.cjs) runs in
// its OWN container — another uid, no network, the workspaces volume read-only — makes a
// hash-checked copy of that commit and runs the command the OPERATOR configured there
// (`CODE_VERIFY=name|command`). noevia sends a repository name, a source path and a commit id —
// never a command — over `CODE_VERIFY_ENDPOINT` (`unix:/path` in production) and gets back an
// exit status and a bounded tail of output. It never uses the agent sandbox's endpoint.
//
// Trust rules:
//   * The only test report the pipeline may accept is the object `run()` returns. Those objects are
//     frozen and remembered in a module-private WeakSet; `isMeasured(report, { taskId, headSha,
//     revision })` is the check, and it also binds the report to that task, commit and revision.
//     A report read back from a job journal, an artifact, a file in the repository or anything the
//     agent emitted is a different object and is never measured — even if every field matches.
//     The pipeline must still re-check, at merge time, that the branch head is the measured
//     `headSha` (the merge itself is #705's job).
//   * `passed` is computed here from the measured exit status: exit 0, no signal, no timeout.
//   * The output tail is untrusted data: re-capped here in bytes, stripped of control characters
//     other than newline and tab, and never parsed for a verdict.
//   * The verifier’s answer is read as ONE line of at most MAX_ANSWER_BYTES. Its commit id must
//     equal the one asked for.
//
// Events: `step.started` / `step.completed` with id `tests`, and an `artifact.created` with
// `kind: 'test-report'` carrying the report, through the `emit(type, data)` the caller supplies.
const net = require('node:net'), crypto = require('node:crypto');
const { splitEndpoint } = require('./code-acp.cjs');

const STEP_ID = 'tests';
const STEP_TITLE = 'Run the tests';
const DEFAULT_TAIL_BYTES = 16 * 1024;
const MAX_TAIL_BYTES = 256 * 1024;
// JSON escaping can expand a byte to six characters; the line is bounded well above that.
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
// Longer than the verifier's own default wall limit (10 min) so its answer normally arrives first.
const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
// The verifier serves one request and restarts (services/code-sandbox/verifier.cjs, one-shot), so
// for a few seconds after a run it is not listening, and while one runs it turns others away.
const DEFAULT_CONNECT_RETRY_MS = 15_000;
const RETRY_STEP_MS = 250;
const RETRYABLE = new Set(['ENOENT', 'ECONNREFUSED', 'EAGAIN', 'ECONNRESET']);

const measured = new WeakSet();

/** Keep the last `cap` bytes of a string, without splitting a UTF-8 character at the cut. */
function tailUtf8(text, cap) {
  const buf = Buffer.from(String(text || ''), 'utf8');
  if (buf.length <= cap) return buf.toString('utf8');
  let start = buf.length - cap;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

/** Untrusted output, made safe to store and show: no escape sequences or other controls. */
function cleanTail(text, cap) {
  // eslint-disable-next-line no-control-regex
  return tailUtf8(String(text || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ''), cap);
}

/**
 * True only for a report this module produced in this process, for exactly this task, commit and
 * revision. All three are required: a measurement of another task or an older revision is not one.
 */
function isMeasured(report, expected) {
  if (!report || typeof report !== 'object' || !measured.has(report)) return false;
  if (!expected || typeof expected !== 'object') return false;
  return report.taskId === expected.taskId && report.headSha === expected.headSha && report.revision === expected.revision;
}

/** `unix:/path` or `host:port`. */
function connectTo(endpoint, connectFn) {
  const text = String(endpoint);
  if (text.startsWith('unix:')) {
    const socketPath = text.slice(5);
    if (!socketPath.startsWith('/')) throw Error(`CODE_VERIFY_ENDPOINT should be unix:/absolute/path or host:port, not "${text}"`);
    return connectFn({ path: socketPath });
  }
  const [host, port] = splitEndpoint(text);
  return connectFn(port, host);
}

/**
 * Ask the verifier to verify. Resolves with the parsed answer object or rejects with a reason.
 * `connectFn(port, host)` is `net.connect` in production.
 */
function askVerifier({ endpoint, connectFn, request, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let socket;
    try { socket = connectTo(endpoint, connectFn); } catch (e) { reject(Object.assign(Error(e.message), { code: 'config' })); return; }
    let settled = false, received = '', bytes = 0, connectedAt = null;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      // Hanging up is what stops the run in the verifier, so this is also the cancel path.
      try { socket.destroy(); } catch { /* already gone */ }
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => done(Object.assign(Error('Verification was cancelled.'), { code: 'cancelled' }));
    const timer = setTimeout(() => done(Object.assign(Error('The verifier did not answer in time.'), { code: 'timeout' })), timeoutMs);
    timer.unref?.();
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    socket.setEncoding?.('utf8');
    socket.on('connect', () => { connectedAt = Date.now(); });
    socket.write(JSON.stringify(request) + '\n');
    socket.on('data', (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_ANSWER_BYTES) return done(Object.assign(Error('The verifier’s answer was too large.'), { code: 'bad_answer' }));
      received += chunk;
      const end = received.indexOf('\n');
      if (end === -1) return;
      let answer;
      try { answer = JSON.parse(received.slice(0, end)); }
      catch { return done(Object.assign(Error('The verifier’s answer was not readable.'), { code: 'bad_answer' })); }
      done(null, answer);
    });
    // Not listening (restarting), or accepted and dropped at once by an instance that already
    // served its request: retryable. Anything later is a real failure, never silently re-run.
    socket.on('error', (error) => done(Object.assign(Error(`The verifier is unreachable (${error.message}).`),
      { code: !bytes && RETRYABLE.has(error.code) ? 'not_listening' : 'unreachable' })));
    socket.on('close', () => done(Object.assign(Error('The verifier closed the connection without an answer.'),
      { code: !bytes && (connectedAt === null || Date.now() - connectedAt < 1000) ? 'not_listening' : 'unreachable' })));
  });
}

/**
 * @param {{endpoint?: string|null, connectFn?: Function, timeoutMs?: number, tailBytes?: number,
 *          log?: (entry: object) => void, now?: () => number, connectRetryMs?: number,
 *          nonceFn?: () => string}} [deps]
 *
 * `endpoint` is the verifier container (`CODE_VERIFY_ENDPOINT`, e.g. `unix:/run/noevia-verify/verify.sock`).
 * Without one there is nowhere isolated to run tests, so verification is unavailable — it is never
 * run beside noevia's own state, nor in the agent's sandbox.
 */
function createCodeVerify({ endpoint = process.env.CODE_VERIFY_ENDPOINT || null, connectFn = net.connect,
  timeoutMs = DEFAULT_TIMEOUT_MS, tailBytes = DEFAULT_TAIL_BYTES, log = () => {}, now = Date.now,
  connectRetryMs = DEFAULT_CONNECT_RETRY_MS, nonceFn = () => crypto.randomBytes(16).toString('hex') } = {}) {
  const cap = Math.min(Math.max(1024, Math.floor(Number(tailBytes) || DEFAULT_TAIL_BYTES)), MAX_TAIL_BYTES);

  /**
   * Verify one revision. Never throws for an expected failure; the outcome says what happened.
   *
   * @param {{workspaces: {verifyCheckout: Function}, taskId: string, repo: string, headSha: string,
   *          revision: number, emit?: (type: string, data: object) => void, signal?: AbortSignal}} args
   * @returns {Promise<{status: 'passed'|'failed'|'error'|'unavailable', report: object|null,
   *          error: {code: string, message: string}|null}>}
   */
  async function run({ workspaces, taskId, repo, headSha, revision, emit = () => {}, signal = undefined }) {
    const started = now();
    emit('step.started', { id: STEP_ID, title: STEP_TITLE });
    const stop = (status, code, message) => {
      log({ event: 'code.verify', taskId, revision, status, code });
      emit('step.completed', { id: STEP_ID, failed: true, reason: message });
      return { status, report: null, error: { code, message } };
    };
    if (!endpoint) return stop('unavailable', 'no_verifier', 'Verification needs the verifier container (CODE_VERIFY_ENDPOINT).');
    if (!REPO_NAME.test(String(repo || ''))) return stop('error', 'bad_request', 'Verification needs the repository name.');
    if (!COMMIT.test(String(headSha || ''))) return stop('error', 'bad_sha', 'Verification needs a full commit id.');
    if (!Number.isInteger(revision) || revision < 0) return stop('error', 'bad_request', 'Verification needs the revision number.');

    let target;
    try { target = workspaces.verifyCheckout(taskId, headSha); }
    catch (e) { return stop('error', e.code || 'checkout', e.message || 'Could not name the commit to verify.'); }

    // A fresh nonce per request, echoed by the verifier: a stale or replayed answer does not match.
    // (It does not stop someone who can read the request; the verifier's isolation does that.)
    const nonce = nonceFn();
    let answer;
    const giveUp = Date.now() + Math.max(0, connectRetryMs);
    for (;;) {
      try {
        answer = await askVerifier({ endpoint, connectFn, timeoutMs, signal,
          request: { noevia: 'verify', repo, source: target.source, headSha, nonce } });
      } catch (e) {
        if (e.code === 'not_listening' && Date.now() < giveUp && !signal?.aborted) { await new Promise((r) => setTimeout(r, RETRY_STEP_MS)); continue; }
        if (e.code === 'not_listening') return stop('unavailable', 'busy', 'The verifier is busy or restarting; try again shortly.');
        return stop('error', e.code || 'unreachable', e.message);
      }
      if (answer && answer.ok === false && answer.error === 'busy' && Date.now() < giveUp && !signal?.aborted) {
        await new Promise((r) => setTimeout(r, RETRY_STEP_MS)); continue;
      }
      break;
    }

    if (!answer || answer.noevia !== 'verify-result') return stop('error', 'bad_answer', 'The verifier’s answer was not a verification result.');
    if (answer.nonce !== nonce) return stop('error', 'bad_answer', 'The verifier’s answer was not for this request.');
    if (answer.ok !== true) {
      const code = typeof answer.error === 'string' ? answer.error.slice(0, 40) : 'refused';
      const message = typeof answer.message === 'string' ? cleanTail(answer.message, 500) : 'The verifier refused the verification.';
      return stop(code === 'not_configured' || code === 'busy' ? 'unavailable' : 'error', code, message);
    }
    if (answer.headSha !== headSha) return stop('error', 'bad_answer', 'The verifier answered for a different commit.');
    const exitCode = Number.isInteger(answer.exitCode) ? answer.exitCode : null;
    const signalName = typeof answer.signal === 'string' && /^SIG[A-Z0-9]{1,10}$/.test(answer.signal) ? answer.signal : null;
    const timedOut = answer.timedOut === true;
    const tail = cleanTail(typeof answer.tail === 'string' ? answer.tail : '', cap);
    const totalBytes = Number.isSafeInteger(answer.totalBytes) && answer.totalBytes >= 0 ? answer.totalBytes : null;
    const report = Object.freeze({
      kind: 'test-report',
      passed: exitCode === 0 && !signalName && !timedOut,
      exitCode,
      signal: signalName,
      timedOut,
      tail,
      tailBytes: Buffer.byteLength(tail),
      totalBytes,
      truncated: answer.truncated === true || (totalBytes !== null && totalBytes > Buffer.byteLength(tail)),
      taskId,
      headSha,
      revision,
      repo,
      durationMs: Math.max(0, now() - started),
      measuredBy: 'verifier',
    });
    measured.add(report);
    log({ event: 'code.verify', taskId, revision, status: report.passed ? 'passed' : 'failed', exitCode, timedOut });
    emit('artifact.created', { ...report });
    emit('step.completed', { id: STEP_ID, failed: !report.passed });
    return { status: report.passed ? 'passed' : 'failed', report, error: null };
  }

  return { available: () => !!endpoint, run, isMeasured };
}

module.exports = { createCodeVerify, isMeasured, cleanTail, tailUtf8, connectTo, STEP_ID, DEFAULT_TAIL_BYTES, MAX_ANSWER_BYTES };
