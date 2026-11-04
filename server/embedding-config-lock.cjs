'use strict';
// The same OS flock as native publication. The helper holds it until stdin closes;
// no stale-file takeover, unlink, network await or event-loop blocking in the hold.
const { spawn } = require('node:child_process');
function withFlock(file, action) {
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['-x', '-w', '5', file, process.execPath, '-e', "process.stdout.write('ready');process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    let result, failure, ran = false;
    const timer = setTimeout(() => { failure = Error('Embedding config lock timed out'); try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 7000);
    child.on('error', e => { failure = e; });
    child.stdin.on('error', () => {});
    child.stdout.once('data', () => {
      ran = true;
      try { result = action(); if (result?.then) throw Error('Embedding lock action must be synchronous'); } catch (e) { failure = e; }
      child.stdin.end();
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || !ran || code !== 0) reject(failure || Error('Embedding config lock unavailable'));
      else resolve(result);
    });
  });
}
module.exports = { withFlock };
