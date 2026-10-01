'use strict';
// The pipeline's view of server-measured verification (#705 ← #703). One small adapter, so the
// pipeline never depends on the verifier module's internals; index.cjs wires the real one
// (`createVerifyAdapter(require('./code-verify.cjs').createCodeVerify())`). A verifier that stays
// busy past its own retries answers `unavailable` (code `busy`), which blocks like any other.
//
// The contract the pipeline relies on (code-verify.cjs, #703):
//   createCodeVerify({ endpoint }) → { available(), run({ workspaces, taskId, repo, headSha, revision,
//   emit, signal }) → { status: 'passed'|'failed'|'error'|'unavailable', report, error }, isMeasured(report,
//   { taskId, headSha, revision }) }
//
// What this adapter adds is distrust. Only `passed` or `failed` with a report the verifier itself
// vouches for — `isMeasured()` for exactly this task, commit and revision — is ever a test result.
// Everything else is `unavailable` or `error`, and the pipeline goes `blocked` on both: a missing,
// unreachable or unbound verification is never a pass.

const STATUSES = new Set(['passed', 'failed', 'error', 'unavailable']);
const unavailable = (message) => ({ status: 'unavailable', report: null, error: { code: 'no_verifier', message } });
const error = (code, message) => ({ status: 'error', report: null, error: { code, message } });

/**
 * @param {{ available?: () => boolean, run?: Function, isMeasured?: Function } | null} verify
 *   the #703 verifier, or null when this server has none (then every run is `unavailable`).
 */
function createVerifyAdapter(verify = null) {
  const usable = () => !!verify && typeof verify.run === 'function' && typeof verify.isMeasured === 'function';
  const available = () => {
    if (!usable()) return false;
    try { return typeof verify.available !== 'function' || verify.available() === true; } catch { return false; }
  };
  return {
    available,
    /**
     * @param {{ workspaces: object, taskId: string, repo: string, headSha: string, revision: number,
     *           emit: (type: string, data: object) => void, signal?: AbortSignal }} args
     */
    async run(args) {
      if (!available()) return unavailable('Verification is not set up on this server (the verifier container, CODE_VERIFY_ENDPOINT).');
      let outcome;
      try { outcome = await verify.run(args); }
      catch { return error('verifier_threw', 'The verifier failed unexpectedly.'); }
      const status = outcome && STATUSES.has(outcome.status) ? outcome.status : null;
      if (!status) return error('bad_outcome', 'The verifier gave no usable answer.');
      const reason = outcome.error && typeof outcome.error.message === 'string' ? outcome.error.message.slice(0, 300) : null;
      if (status === 'unavailable') return unavailable(reason || 'Verification is unavailable.');
      if (status === 'error') return error(String(outcome.error?.code || 'error').slice(0, 40), reason || 'Verification could not run.');
      let measured = false;
      try { measured = verify.isMeasured(outcome.report, { taskId: args.taskId, headSha: args.headSha, revision: args.revision }) === true; }
      catch { measured = false; }
      if (!measured) return error('unmeasured', 'The test report was not measured by the verifier for this task, commit and revision.');
      // Re-derived here rather than trusted from `status`: a "passed" over a failing report is not one.
      return { status: outcome.report.passed === true ? 'passed' : 'failed', report: outcome.report, error: null };
    },
  };
}

module.exports = { createVerifyAdapter };
