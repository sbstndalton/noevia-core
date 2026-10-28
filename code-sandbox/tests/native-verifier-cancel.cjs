'use strict';
// Qualification-only IPC wait. A closed verifier cannot await a future host release.
async function waitForCancellation(input, closed) {
  let release;
  const cancelled = new Promise((resolve) => { release = resolve; input.once('data', release); });
  try {
    await Promise.race([cancelled, closed.then(() => { throw Error('verifier closed before observed command cancellation'); })]);
  } finally {
    input.removeListener('data', release);
    input.pause();
  }
}
module.exports = { waitForCancellation };
