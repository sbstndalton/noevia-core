'use strict';
// code-workspace.cjs change(): the diff the Astra review reads (#519). Temp git fixtures only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createCodeWorkspaces } = require('./code-workspace.cjs');

const temps = [];
const temp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const ids = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sub = (args) => { let i = 0; while (args[i] === '-c') i += 2; return args[i]; };

function repoWith(files) {
  const repo = temp('noevia-crepo-');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'qa@example.invalid'); git('config', 'user.name', 'QA');
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), body);
  git('add', '.'); git('commit', '-qm', 'first');
  return repo;
}
/** The task commits, the way a harness that commits would. */
function commitIn(cwd, files, remove = []) {
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git('config', 'user.email', 'harness@example.invalid'); git('config', 'user.name', 'harness');
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), body);
  }
  for (const name of remove) git('rm', '-q', name);
  git('add', '-A'); git('commit', '-qm', 'task work');
}

test('clone mode: the diff comes from the source repository, after release', () => {
  const repo = repoWith({ 'a.txt': 'a\n' });
  const ws = createCodeWorkspaces({ dir: temp('noevia-cws-'), treeRoot: temp('noevia-cshared-'), mode: 'clone', epoch: 'test' });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  assert.equal(claim.mode, 'clone');
  assert.throws(() => ws.change(ids(1)), (e) => e.code === 'not_released', 'a held claim is never diffed');
  // Left uncommitted on purpose: release() commits it in noevia's name and fetches it back.
  fs.writeFileSync(path.join(claim.path, 'a.txt'), 'fixed\n');
  const released = ws.release({ taskId: ids(1) });
  assert.equal(released.status, 'released');
  assert.equal(fs.existsSync(claim.path), false, 'read after the clone is gone');
  const change = ws.change(ids(1));
  assert.equal(change.baseSha, claim.baseSha);
  assert.equal(change.headSha, released.headSha);
  assert.deepEqual(change.files.map((f) => f.path), ['a.txt']);
  assert.match(change.files[0].patch, /^diff --git a\/a\.txt b\/a\.txt/);
  assert.match(change.files[0].patch, /\n-a\n\+fixed$/);
  assert.equal(change.truncated, false);
  // A clean clone commits nothing, so there is nothing to review.
  ws.claim({ taskId: ids(2), repoPath: repo });
  ws.release({ taskId: ids(2) });
  assert.throws(() => ws.change(ids(2)), (e) => e.code === 'no_change');
  assert.throws(() => ws.change(ids(3)), (e) => e.code === 'no_workspace');
});

test('names come from git, not from patch bodies: quoted, non-ASCII and decoy lines', () => {
  const quoted = 'dïr/ünï "q"\ttab.js', gone = 'gönë "x".js';
  const repo = repoWith({ 'a.txt': 'a\n', [gone]: '-- a/decoy-deleted.js\n' });
  const ws = createCodeWorkspaces({ dir: temp('noevia-cws-'), epoch: 'test' });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  // The content line `++ b/decoy.js` becomes the patch line `+++ b/decoy.js`, and the deleted
  // file's `-- a/decoy-deleted.js` becomes `--- a/decoy-deleted.js`. Neither may name a file.
  commitIn(claim.path, { [quoted]: '++ b/decoy.js\nreal\n' }, [gone]);
  ws.release({ taskId: ids(1) });
  const change = ws.change(ids(1));
  assert.deepEqual(change.files.map((f) => f.path).sort(), [quoted, gone].sort());
  assert.match(change.files.find((f) => f.path === quoted).patch, /^\+\+\+ b\/decoy\.js$/m, 'the decoy really is in the body');
  assert.match(change.files.find((f) => f.path === gone).patch, /^--- a\/decoy-deleted\.js$/m);
  assert.ok(!change.files.some((f) => /decoy/.test(f.path)));
});

test('a diff over 1 MiB is read; past the buffer it is "too large", in plain words', () => {
  const repo = repoWith({ 'a.txt': 'a\n' });
  const line = 'x'.repeat(100) + '\n';
  const ws = createCodeWorkspaces({ dir: temp('noevia-cws-'), epoch: 'test' });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  commitIn(claim.path, { 'big.txt': line.repeat(15000) }); // ~1.5 MiB of diff
  ws.release({ taskId: ids(1) });
  assert.ok(ws.change(ids(1)).files[0].patch.length > 1024 * 1024, 'the old 1 MiB default threw ENOBUFS here');
  // The same size against a small buffer: the plain reason, never ENOBUFS or a command line.
  const small = createCodeWorkspaces({ dir: temp('noevia-cws-'), epoch: 'test', changeMaxBuffer: 64 * 1024 });
  const claim2 = small.claim({ taskId: ids(2), repoPath: repo });
  commitIn(claim2.path, { 'big2.txt': line.repeat(15000) });
  small.release({ taskId: ids(2) });
  assert.throws(() => small.change(ids(2)), (e) => e.code === 'too_large' && e.message === 'The change is too large to review.');
});

test('a failing git is "could not be read", never the command text', () => {
  const repo = repoWith({ 'a.txt': 'a\n' });
  let failDiff = false;
  const run = (args, cwd, env = {}, opts = {}) => {
    if (failDiff && sub(args) === 'diff') {
      throw Object.assign(Error('Command failed: git -c core.fsmonitor=false diff SECRET-PATH'), { status: 128, stderr: 'fatal: bad object SECRET' });
    }
    const out = execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return opts.raw ? out : out.trim();
  };
  const ws = createCodeWorkspaces({ dir: temp('noevia-cws-'), epoch: 'test', run });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  commitIn(claim.path, { 'a.txt': 'b\n' });
  ws.release({ taskId: ids(1) });
  failDiff = true;
  assert.throws(() => ws.change(ids(1)), (e) => e.code === 'unreadable' && e.message === 'The change could not be read.');
});
