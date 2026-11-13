'use strict';
// sbstndalton/noevia#2516 (Rust port R6): who runs model auto-tune. AUTOTUNE_RUNNER_IMPL=rust (the web container's
// variable, read by this process and by the Rust front alike) hands the job, its state file
// native-autotune-<hash>.json, its private calibrator and its boot recovery to the front (noevia-rs
// crates/autotune-runner). This process then builds no auto-tuner, so exactly one owner ever writes the file; its
// auto-tune bridges answer { available: false } and POST /api/models/autotune is the front's. Unset or any other
// value: Node, as before. The release assembly pairs AUTOTUNE_RUNNER_OWNER with the front's capability
// (`rust-autotune-runner`) before the variable may be set.
const IMPL_ENV = 'AUTOTUNE_RUNNER_IMPL';
const AUTOTUNE_RUNNER_OWNER = 'noevia-autotune-runner-rust/1';
const frontOwnsRunner = (env = process.env) => env?.[IMPL_ENV] === 'rust';

const NOT_REREAD = 'The model server has not re-read the restored settings yet. Try again shortly.';
/** The front's run as this process's manager sees it: `tuningActive()` from a 1 s poll of the front's state
 *  (false until the front answers, and when it cannot), and `flushReload(model)`, which throws the runner's own
 *  sentence when the front could not have the router re-read the restored file. */
function createFrontAutotune({ client, intervalMs = 1000, log = (m) => console.warn(m) } = {}) {
  let running = false, timer = null, polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try { const { status, body } = await client.autotune('state', {}, { timeoutMs: 2000 }); running = status === 200 && body?.running === true; }
    catch { running = false; }
    finally { polling = false; }
  };
  return {
    start() { if (timer) return; void poll(); timer = setInterval(() => { void poll(); }, intervalMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
    poll,
    tuningActive: () => running,
    async flushReload(model = null) {
      let answer;
      try { answer = await client.autotune('flush', model ? { model } : {}, { timeoutMs: 125000 }); }
      catch { log('[autotune] the front did not answer the re-read'); throw Object.assign(new Error(NOT_REREAD), { publicMessage: NOT_REREAD }); }
      if (answer.status === 200 && answer.body?.flushed === true) return;
      const message = typeof answer.body?.error === 'string' && answer.body.error ? answer.body.error : NOT_REREAD;
      throw Object.assign(new Error(message), { publicMessage: message });
    },
  };
}
module.exports = { IMPL_ENV, AUTOTUNE_RUNNER_OWNER, frontOwnsRunner, createFrontAutotune };
