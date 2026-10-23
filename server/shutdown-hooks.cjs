'use strict';
// What this process does when it is told to stop (SIGTERM, SIGINT): its hooks run (each may be async), bounded
// by one time limit, and then the signal is sent again so the process ends the default way. The listeners are
// once-listeners: a second signal while the hooks run ends the process at once.
function createShutdownHooks({ proc = process, timeoutMs = 3000, signals = ['SIGTERM', 'SIGINT'] } = {}) {
  const hooks = [];
  let running = null;
  /** Runs every hook once, in parallel; a hook that throws or does not finish within the limit does not hold the rest. */
  function run() {
    if (running) return running;
    const started = hooks.map((hook) => { try { return Promise.resolve(hook()).catch(() => {}); } catch { return Promise.resolve(); } });
    let timer;
    const limit = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    running = Promise.race([Promise.all(started), limit]).then(() => { clearTimeout(timer); });
    return running;
  }
  function install() {
    for (const signal of signals) proc.once(signal, () => { run().finally(() => proc.kill(proc.pid, signal)); });
  }
  return { add: (hook) => { hooks.push(hook); }, run, install };
}

module.exports = { createShutdownHooks };
