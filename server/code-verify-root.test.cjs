'use strict';
// #703: the verifier's privilege separation, for real. Needs root on Linux (to drop to the git and
// test uids), so `npm test` skips it and CI runs it once more under sudo:
//   sudo node --test server/code-verify-root.test.cjs
// What it proves: the test command runs as its own uid and cannot chmod or write the copy, cannot
// touch the socket or its directory, cannot signal the server, and a `setsid` escapee does not
// outlive the request. Synthetic repository only; no network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { execFileSync } = require('node:child_process');

const ROOT_LINUX = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;
const GIT_USER = { uid: 1002, gid: 1002 }, TEST_USER = { uid: 1003, gid: 1003 };

test('the test uid cannot touch the server, the socket or the copy, and leaves nothing running', { skip: !ROOT_LINUX && 'needs root on Linux (CI runs it under sudo)' }, async () => {
  const { createVerifier, parseVerify } = require('../../../services/code-sandbox/verifier.cjs');
  const dirs = [];
  const mk = (mode, owner) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nvr-'));
    dirs.push(d);
    fs.chmodSync(d, mode);
    if (owner) fs.chownSync(d, owner.uid, owner.gid);
    return d;
  };
  try {
    const root = mk(0o755);
    const repo = path.join(root, 'scratch');
    fs.mkdirSync(repo, { mode: 0o755 });
    const git = (args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
    git(['init', '--quiet', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(['add', '-A']); git(['commit', '--quiet', '-m', 'work']);
    const head = git(['rev-parse', 'HEAD']);
    execFileSync('chmod', ['-R', 'a+rX', repo]);

    const copyRoot = mk(0o755, GIT_USER), scratchRoot = mk(0o700, TEST_USER), ctlRoot = mk(0o755);
    const sockDir = mk(0o770);   // root's, as in the image: /run/noevia-verify
    const sock = path.join(sockDir, 'verify.sock');
    const pidFile = path.join(scratchRoot, 'escapee');
    const command = [
      'echo "uid=$(id -u)"',
      // Escape the process group (and session) and try to outlive the request.
      `setsid sh -c 'echo $$ > ${pidFile}; exec sleep 300' >/dev/null 2>&1 </dev/null &`,
      'sleep 0.3',
      'chmod 0777 "$PWD" 2>/dev/null && echo CHMOD-COPY-OK',
      'chmod 0777 .. 2>/dev/null && echo CHMOD-RUN-OK',
      'touch probe 2>/dev/null && echo WRITE-COPY-OK',
      `rm -f ${sock} 2>/dev/null && echo SOCKET-GONE`,
      `ln -s /tmp/evil ${sockDir}/evil 2>/dev/null && echo SOCKDIR-WRITE-OK`,
      `kill -0 ${process.pid} 2>/dev/null && echo CAN-SIGNAL-SERVER`,
      'exit 0',
    ].join('\n');
    let done = false;
    const verifier = createVerifier({ root, copyRoot, scratchRoot, ctlRoot, gitUser: GIT_USER, testUser: TEST_USER,
      oneShot: true, onDone: () => { done = true; }, graceMs: 200, verify: new Map([['scratch', command]]),
      log: (l) => console.log(`[verifier] ${l}`) });
    await verifier.listen(sock);
    assert.equal(fs.statSync(sock).uid, 0);
    const out = await new Promise((resolve) => {
      const s = net.connect({ path: sock }, () => s.write(JSON.stringify({ noevia: 'verify', repo: 'scratch', source: repo, headSha: head, nonce: 'ab'.repeat(16) }) + '\n'));
      let data = '';
      s.setEncoding('utf8');
      s.on('data', (d) => { data += d; });
      s.on('close', () => resolve(data));
      s.on('error', () => {});
    });
    const r = JSON.parse(out.trim());
    assert.equal(r.ok, true, out);
    assert.equal(r.exitCode, 0, r.tail);
    assert.match(r.tail, /^uid=1003$/m, 'the command ran as the test uid');
    for (const marker of ['CHMOD-COPY-OK', 'CHMOD-RUN-OK', 'WRITE-COPY-OK', 'SOCKET-GONE', 'SOCKDIR-WRITE-OK', 'CAN-SIGNAL-SERVER']) {
      assert.doesNotMatch(r.tail, new RegExp(marker), marker);
    }
    // The one-shot server closes its listener (and node unlinks the socket) as it accepts its one
    // connection; what matters is that the test uid could not get into the directory to replace it.
    assert.deepEqual(fs.readdirSync(sockDir).filter((n) => n !== 'verify.sock'), [], 'nothing was planted beside the socket');
    assert.equal(fs.statSync(sockDir).uid, 0);
    assert.equal(fs.statSync(sockDir).mode & 0o777, 0o770, 'the socket directory is still root’s, 0770');
    const escapee = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : 0);
    assert.ok(escapee > 0, 'the escapee started');
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 40 && alive(escapee); i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(alive(escapee), false, 'the setsid escapee did not outlive the request');
    let left = '';
    try { left = execFileSync('pgrep', ['-u', '1002,1003'], { encoding: 'utf8' }).trim(); } catch { /* none: pgrep exits 1 */ }
    assert.equal(left, '', 'no git-uid or test-uid process remains');
    for (let i = 0; i < 40 && !done; i++) await new Promise((res) => setTimeout(res, 25));
    assert.equal(done, true, 'one request served; the process would exit and be restarted');
    await verifier.close();
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});
