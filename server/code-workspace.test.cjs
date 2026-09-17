const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createCodeWorkspaces } = require('./code-workspace.cjs');

// Every temp tree this suite makes is removed when it ends: a worktree left behind holds a
// lock on its repository and the next run inherits it.
const temps = [];
const temp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const ids = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function repoWith(files = { 'a.txt': 'a' }) {
  const repo = temp('noevia-repo-');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'qa@example.invalid');
  git('config', 'user.name', 'QA');
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), body);
  git('add', '.');
  git('commit', '-qm', 'first');
  return repo;
}
function workspaces(extra = {}) {
  const dir = temp('noevia-ws-');
  return { dir, ws: createCodeWorkspaces({ dir, epoch: 'test', ...extra }) };
}

test('a task gets its own worktree and branch, leaving the repository tree alone', () => {
  const repo = repoWith();
  const { ws } = workspaces();
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  assert.equal(claim.status, 'held');
  assert.match(claim.branch, /^noevia\/task-/);
  assert.ok(fs.existsSync(path.join(claim.path, 'a.txt')), 'the worktree has the repository content');
  assert.notEqual(fs.realpathSync(claim.path), fs.realpathSync(repo));
  // The repository's own tree is untouched and still on its own branch.
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(branch, 'main');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '');
});

test('one writer per repository and branch', () => {
  const repo = repoWith();
  const { ws } = workspaces();
  ws.claim({ taskId: ids(1), repoPath: repo, branch: 'feature/x' });
  assert.throws(() => ws.claim({ taskId: ids(2), repoPath: repo, branch: 'feature/x' }), /already writes/);
  // A different branch in the same repository is fine: each task writes its own.
  assert.ok(ws.claim({ taskId: ids(3), repoPath: repo, branch: 'feature/y' }));
  // Once released, the branch is claimable again.
  ws.release({ taskId: ids(1) });
  assert.ok(ws.claim({ taskId: ids(4), repoPath: repo, branch: 'feature/x' }));
});

test('each task derives its own branch, and an interrupted claim keeps blocking', () => {
  const repo = repoWith();
  const dir = temp('noevia-ws-');
  const first = createCodeWorkspaces({ dir, epoch: 'process-1' });
  const a = first.claim({ taskId: ids(1), repoPath: repo });
  const b = first.claim({ taskId: ids(2), repoPath: repo });
  assert.notEqual(a.branch, b.branch, 'default branches are derived from the whole task id');

  const afterRestart = createCodeWorkspaces({ dir, epoch: 'process-2' });
  afterRestart.recover();
  assert.throws(() => afterRestart.claim({ taskId: ids(3), repoPath: repo, branch: a.branch }),
    /already writes/, 'an interrupted worktree still has the branch checked out');
});

test('a task id claims once, and a bad id, repo or branch is refused', () => {
  const repo = repoWith();
  const { ws } = workspaces();
  ws.claim({ taskId: ids(1), repoPath: repo });
  assert.throws(() => ws.claim({ taskId: ids(1), repoPath: repo }), /already has a workspace/);
  assert.throws(() => ws.claim({ taskId: 'nope', repoPath: repo }), /Invalid task id/);
  assert.throws(() => ws.claim({ taskId: ids(2), repoPath: '/nowhere-at-all' }), /No such repository/);
  assert.throws(() => ws.claim({ taskId: ids(2), repoPath: os.tmpdir() }), /Not a git repository/);
  for (const branch of ['--upload-pack=x', 'a/../../b', 'a b', '']) {
    assert.throws(() => ws.claim({ taskId: ids(5), repoPath: repo, branch: branch || 'ok space ' }), /Invalid branch name/, branch);
  }
});

test('containment follows symlinks, including for a file that does not exist yet', () => {
  const repo = repoWith();
  const { ws } = workspaces();
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  const outside = temp('noevia-out-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');

  assert.equal(ws.contains(ids(1), path.join(claim.path, 'a.txt')), true);
  assert.equal(ws.contains(ids(1), path.join(claim.path, 'new', 'deep', 'file.txt')), true, 'a path about to be created');
  assert.equal(ws.contains(ids(1), path.join(outside, 'secret.txt')), false);
  assert.equal(ws.contains(ids(1), path.join(claim.path, '..', 'escape.txt')), false);
  assert.equal(ws.contains(ids(1), '/etc/passwd'), false);

  // A symlink inside the worktree pointing out of it does not make the target inside.
  fs.symlinkSync(outside, path.join(claim.path, 'link'));
  assert.equal(ws.contains(ids(1), path.join(claim.path, 'link', 'secret.txt')), false);
  assert.equal(ws.contains(ids(1), path.join(claim.path, 'link', 'brand-new.txt')), false,
    'a new file under a symlinked-out directory is still outside');

  // Unknown task: null, never a silent yes.
  assert.equal(ws.contains(ids(9), path.join(claim.path, 'a.txt')), null);
  ws.release({ taskId: ids(1) });
  assert.equal(ws.contains(ids(1), 'a.txt'), null, 'a released workspace contains nothing');
});

test('release removes the worktree and keeps the branch unless asked', () => {
  const repo = repoWith();
  const { ws } = workspaces();
  const claim = ws.claim({ taskId: ids(1), repoPath: repo, branch: 'keep/me' });
  fs.writeFileSync(path.join(claim.path, 'work.txt'), 'in progress');
  const released = ws.release({ taskId: ids(1) });
  assert.equal(released.status, 'released');
  assert.equal(fs.existsSync(claim.path), false);
  const branches = execFileSync('git', ['branch', '--list'], { cwd: repo, encoding: 'utf8' });
  assert.match(branches, /keep\/me/, 'the work survives the workspace');

  const second = ws.claim({ taskId: ids(2), repoPath: repo, branch: 'drop/me' });
  ws.release({ taskId: ids(2), removeBranch: true });
  assert.doesNotMatch(execFileSync('git', ['branch', '--list'], { cwd: repo, encoding: 'utf8' }), /drop\/me/);
  assert.equal(fs.existsSync(second.path), false);
  assert.equal(ws.release({ taskId: ids(7) }), null, 'releasing an unknown task is not an error');
});

test('a worktree that cannot be removed is recorded as stuck, not as released', () => {
  const repo = repoWith();
  const { ws } = workspaces({ run: makeFailingRun() });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  assert.equal(claim.status, 'held');
  const result = ws.release({ taskId: ids(1) });
  assert.equal(result.status, 'stuck');
  assert.match(result.error, /worktree remove refused/);
  // Still holding the branch, so the next claim on it keeps failing until someone looks.
  assert.throws(() => ws.claim({ taskId: ids(2), repoPath: repo, branch: claim.branch }), /already writes/);
});

function makeFailingRun() {
  const real = require('node:child_process').execFileSync;
  return (args, cwd) => {
    if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('worktree remove refused');
    return real('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  };
}

test('claims from an earlier process are interrupted, never silently reused', () => {
  const repo = repoWith();
  const { dir } = workspaces();
  const first = createCodeWorkspaces({ dir, epoch: 'process-1' });
  first.claim({ taskId: ids(1), repoPath: repo });

  const afterRestart = createCodeWorkspaces({ dir, epoch: 'process-2' });
  const recovered = afterRestart.recover();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, 'interrupted');
  assert.equal(afterRestart.contains(ids(1), 'a.txt'), null, 'an interrupted workspace is not writable');
  // The worktree is left on disk: it may hold work nobody has read.
  assert.equal(fs.existsSync(recovered[0].path), true);
  assert.equal(afterRestart.recover().length, 0, 'recovery is idempotent');
});
