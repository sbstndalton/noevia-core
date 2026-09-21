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

test('worktrees can live on a shared root, at one path both containers see', () => {
  // The harness runs in another container, so it must see the worktree at the SAME absolute
  // path noevia sends it. That means a shared volume, not the tenant's own directory.
  const repo = repoWith();
  const dir = temp('noevia-ws-');
  const shared = temp('noevia-shared-');
  const ws = createCodeWorkspaces({ dir, treeRoot: shared, epoch: 'test' });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  assert.equal(path.dirname(claim.path), fs.realpathSync(shared), 'the tree is on the shared root');
  assert.ok(fs.existsSync(path.join(claim.path, 'a.txt')));
  // The ownership record stays tenant-side: the shared volume holds work, not who owns what.
  assert.ok(fs.existsSync(path.join(dir, 'code-workspaces', ids(1) + '.json')));
  assert.equal(ws.contains(ids(1), path.join(claim.path, 'new.txt')), true);
  assert.equal(ws.contains(ids(1), path.join(shared, 'elsewhere', 'x.txt')), false, 'a sibling task’s tree is still outside');
  ws.release({ taskId: ids(1) });
  assert.equal(fs.existsSync(claim.path), false);
});

test('a new worktree is handed to the user the harness runs as', () => {
  const repo = repoWith();
  const dir = temp('noevia-ws-');
  const handed = [];
  const ws = createCodeWorkspaces({ dir, owner: { uid: 1000, gid: 1000 }, epoch: 'test',
    chown: (target, uid, gid) => handed.push([path.basename(target), uid, gid]) });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  // The workspace and the harness's own state directory both change hands.
  assert.deepEqual(handed, [[ids(1), 1000, 1000], [ids(1), 1000, 1000]], 'noevia runs as root and the sandbox does not');
  assert.ok(claim.path);
});

test('a workspace that cannot be handed over is a failed claim, not a silent one', () => {
  // Better to refuse the task than to start a harness that cannot write the tree it was given.
  const repo = repoWith();
  const dir = temp('noevia-ws-');
  const ws = createCodeWorkspaces({ dir, owner: { uid: 1000, gid: 1000 }, epoch: 'test',
    chown: () => { throw new Error('EPERM: operation not permitted'); } });
  assert.throws(() => ws.claim({ taskId: ids(1), repoPath: repo }), /Could not hand the workspace/);
});

test('without an owner nothing is chowned', () => {
  const repo = repoWith();
  const handed = [];
  const ws = createCodeWorkspaces({ dir: temp('noevia-ws-'), epoch: 'test', chown: () => handed.push(1) });
  ws.claim({ taskId: ids(1), repoPath: repo });
  assert.deepEqual(handed, [], 'a deployment with no separate sandbox user has nothing to hand over');
});

// ── Clone mode: what the sandbox needs, because a handed-over worktree cannot commit ──

test('a clone gives the task a repository it owns, and the work comes back on release', () => {
  const repo = repoWith();
  const dir = temp('noevia-ws-');
  const ws = createCodeWorkspaces({ dir, treeRoot: temp('noevia-shared-'), mode: 'clone', epoch: 'test' });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  assert.equal(claim.mode, 'clone');
  // It is a repository of its own, not a pointer into the source's .git.
  assert.ok(fs.statSync(path.join(claim.path, '.git')).isDirectory(), 'a worktree would leave a .git FILE here');
  assert.ok(fs.existsSync(path.join(claim.path, 'a.txt')));

  // The task commits, the way a harness would.
  const git = (...args) => execFileSync('git', args, { cwd: claim.path, stdio: 'ignore' });
  fs.writeFileSync(path.join(claim.path, 'a.txt'), 'fixed');
  git('config', 'user.email', 'harness@example.invalid');
  git('config', 'user.name', 'harness');
  git('add', '-A'); git('commit', '-qm', 'the task did its job');

  const released = ws.release({ taskId: ids(1) });
  assert.equal(released.status, 'released');
  assert.equal(fs.existsSync(claim.path), false, 'the clone is gone');
  // And the work is in the source repository, on the task's branch.
  const log = execFileSync('git', ['log', '--oneline', '-1', claim.branch], { cwd: repo, encoding: 'utf8' });
  assert.match(log, /the task did its job/);
  const body = execFileSync('git', ['show', `${claim.branch}:a.txt`], { cwd: repo, encoding: 'utf8' });
  assert.equal(body, 'fixed');
});

test('a clone shares the source objects rather than copying them', () => {
  const repo = repoWith({ 'big.txt': 'x'.repeat(2 * 1024 * 1024) });
  const ws = createCodeWorkspaces({ dir: temp('noevia-ws-'), treeRoot: temp('noevia-shared-'), mode: 'clone', epoch: 'test' });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  assert.ok(fs.existsSync(path.join(claim.path, '.git', 'objects', 'info', 'alternates')),
    'without alternates every task would copy the whole history');
});

test('a task that committed nothing releases cleanly', () => {
  const repo = repoWith();
  const ws = createCodeWorkspaces({ dir: temp('noevia-ws-'), treeRoot: temp('noevia-shared-'), mode: 'clone', epoch: 'test' });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  const released = ws.release({ taskId: ids(1) });
  assert.equal(released.status, 'released', 'no commits is not a failure');
  assert.equal(fs.existsSync(claim.path), false);
});

test('work that cannot be saved keeps the clone and says so', () => {
  const repo = repoWith();
  const real = require('node:child_process').execFileSync;
  const ws = createCodeWorkspaces({
    dir: temp('noevia-ws-'), treeRoot: temp('noevia-shared-'), mode: 'clone', epoch: 'test',
    run: (args, cwd) => {
      if (args[0] === 'fetch') throw new Error('fatal: the disk is full');
      return real('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    },
  });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  const released = ws.release({ taskId: ids(1) });
  assert.equal(released.status, 'stuck');
  assert.match(released.error, /Could not save the task’s branch/);
  assert.equal(fs.existsSync(claim.path), true, "a task's work is not ours to discard quietly");
});

test('the mode follows whether the harness runs as someone else', () => {
  const repo = repoWith();
  // An owner means a separate sandbox user, which means a worktree could not commit.
  const sandboxed = createCodeWorkspaces({ dir: temp('noevia-ws-'), owner: { uid: 1000, gid: 1000 }, chown: () => {}, epoch: 'test' });
  assert.equal(sandboxed.claim({ taskId: ids(1), repoPath: repo }).mode, 'clone');
  const local = createCodeWorkspaces({ dir: temp('noevia-ws-'), epoch: 'test' });
  assert.equal(local.claim({ taskId: ids(2), repoPath: repoWith() }).mode, 'worktree');
});

test('a failed handover leaves nothing behind', () => {
  const repo = repoWith();
  const shared = temp('noevia-shared-');
  const ws = createCodeWorkspaces({ dir: temp('noevia-ws-'), treeRoot: shared, owner: { uid: 1000, gid: 1000 },
    epoch: 'test', chown: () => { throw new Error('EPERM'); } });
  assert.throws(() => ws.claim({ taskId: ids(1), repoPath: repo }), /Could not hand the workspace/);
  const left = fs.readdirSync(shared).filter((n) => n !== '.harness-home');
  assert.deepEqual(left, [], 'a half-made workspace is not left on the volume');
  assert.deepEqual(fs.existsSync(path.join(shared, '.harness-home', ids(1))), false, 'nor its state directory');
});

test('the clone is taken back before reading from it, or git refuses', () => {
  // Found by a real harness run: git refuses to read a repository owned by another user, and
  // that refusal deliberately ignores `-c safe.directory` and GIT_CONFIG_*. Without handing the
  // clone back first, every task's work is stranded in it.
  const repo = repoWith();
  const order = [];
  const ws = createCodeWorkspaces({
    dir: temp('noevia-ws-'), treeRoot: temp('noevia-shared-'), owner: { uid: 1000, gid: 1000 }, epoch: 'test',
    chown: (target, uid) => order.push(`chown:${uid}`),
    run: (args, cwd) => {
      if (args[0] === 'fetch') order.push('fetch');
      return require('node:child_process').execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    },
  });
  ws.claim({ taskId: ids(1), repoPath: repo });
  ws.release({ taskId: ids(1) });
  // Workspace and state directory handed over, workspace taken back, then read.
  assert.deepEqual(order, ['chown:1000', 'chown:1000', `chown:${process.getuid()}`, 'fetch'],
    'handed to the harness, taken back, then read');
});

test('a clone that cannot be taken back is stuck, and keeps the work', () => {
  const repo = repoWith();
  let claimed = 0;
  const ws = createCodeWorkspaces({
    dir: temp('noevia-ws-'), treeRoot: temp('noevia-shared-'), owner: { uid: 1000, gid: 1000 }, epoch: 'test',
    // Both claim-time chowns succeed; the one at release (taking it back) fails.
    chown: () => { if (claimed >= 2) throw new Error('EPERM: operation not permitted'); claimed++; },
  });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  const released = ws.release({ taskId: ids(1) });
  assert.equal(released.status, 'stuck');
  assert.match(released.error, /Could not take the workspace back/);
  assert.equal(fs.existsSync(claim.path), true, 'the work stays on disk for a human');
});

test('uncommitted work is saved, not deleted with the clone', () => {
  // Found by a real run: OpenCode edited the file through noevia's own file API and never
  // committed. Only commits can be fetched back, so the change would have gone in the bin with
  // the clone — the opposite of the point.
  const repo = repoWith();
  const ws = createCodeWorkspaces({ dir: temp('noevia-ws-'), treeRoot: temp('noevia-shared-'), mode: 'clone', epoch: 'test' });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  fs.writeFileSync(path.join(claim.path, 'a.txt'), 'the harness fixed this and walked away');
  fs.writeFileSync(path.join(claim.path, 'new-file.txt'), 'and added this');

  const released = ws.release({ taskId: ids(1) });
  assert.equal(released.status, 'released');
  assert.equal(fs.existsSync(claim.path), false);

  const show = (file) => execFileSync('git', ['show', `${claim.branch}:${file}`], { cwd: repo, encoding: 'utf8' });
  assert.equal(show('a.txt'), 'the harness fixed this and walked away', 'the edit survived');
  assert.equal(show('new-file.txt'), 'and added this', 'so did the new file');
  const log = execFileSync('git', ['log', '--format=%an%n%s', '-1', claim.branch], { cwd: repo, encoding: 'utf8' });
  assert.match(log, /^noevia\n/, 'committed in noevia’s name, not the harness’s');
  assert.match(log, /work in progress from task/);
});

test('a clean clone produces no empty commit', () => {
  const repo = repoWith();
  const ws = createCodeWorkspaces({ dir: temp('noevia-ws-'), treeRoot: temp('noevia-shared-'), mode: 'clone', epoch: 'test' });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  ws.release({ taskId: ids(1) });
  const count = execFileSync('git', ['rev-list', '--count', claim.branch], { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(count, '1', 'a task that changed nothing adds nothing');
});

test("work that cannot be committed keeps the clone rather than losing it", () => {
  const repo = repoWith();
  const real = require('node:child_process').execFileSync;
  const ws = createCodeWorkspaces({
    dir: temp('noevia-ws-'), treeRoot: temp('noevia-shared-'), mode: 'clone', epoch: 'test',
    run: (args, cwd) => {
      if (args.includes('commit')) throw new Error('fatal: unable to write new index file');
      return real('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    },
  });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  fs.writeFileSync(path.join(claim.path, 'a.txt'), 'precious');
  const released = ws.release({ taskId: ids(1) });
  assert.equal(released.status, 'stuck');
  assert.match(released.error, /uncommitted changes/);
  assert.equal(fs.readFileSync(path.join(claim.path, 'a.txt'), 'utf8'), 'precious');
});

test('the harness gets its own HOME, beside the workspace and never inside it', () => {
  // A real run had HOME pointing at the repository, so OpenCode's cache, sqlite database and a
  // nested git repo all ended up committed onto the task's branch.
  const repo = repoWith();
  const shared = temp('noevia-shared-');
  const ws = createCodeWorkspaces({ dir: temp('noevia-ws-'), treeRoot: shared, mode: 'clone', epoch: 'test' });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  assert.ok(claim.home, 'a task has somewhere of its own to keep harness state');
  assert.equal(fs.existsSync(claim.home), true);
  assert.equal(ws.contains(ids(1), claim.home), false, 'and it is outside the workspace');

  // State written there does not reach the branch.
  fs.writeFileSync(path.join(claim.home, 'opencode.db'), 'harness noise');
  fs.writeFileSync(path.join(claim.path, 'a.txt'), 'the actual work');
  ws.release({ taskId: ids(1) });
  const files = execFileSync('git', ['diff', '--name-only', `main..${claim.branch}`], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(files, ['a.txt'], 'only the task’s work is on the branch');
  assert.equal(fs.existsSync(claim.home), false, 'and the state directory goes with the clone');
});

test('harness droppings inside the workspace are ignored, not committed', () => {
  const repo = repoWith();
  const ws = createCodeWorkspaces({ dir: temp('noevia-ws-'), treeRoot: temp('noevia-shared-'), mode: 'clone', epoch: 'test' });
  const claim = ws.claim({ taskId: ids(1), repoPath: repo });
  // Some harnesses write into the working directory whatever HOME says.
  for (const noise of ['.cache/opencode/models.json', '.local/share/opencode/opencode.db', '.config/opencode/x.jsonc', 'opencode.json']) {
    fs.mkdirSync(path.dirname(path.join(claim.path, noise)), { recursive: true });
    fs.writeFileSync(path.join(claim.path, noise), 'noise');
  }
  fs.writeFileSync(path.join(claim.path, 'a.txt'), 'the actual work');
  ws.release({ taskId: ids(1) });
  const files = execFileSync('git', ['diff', '--name-only', `main..${claim.branch}`], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(files, ['a.txt']);
});

test('the shared state parent is traversable, the task’s own directory is not', () => {
  // Creating the whole path at 0700 left the shared parent root-owned and unenterable, and the
  // real harness died with EACCES before doing any work.
  const shared = temp('noevia-shared-');
  const ws = createCodeWorkspaces({ dir: temp('noevia-ws-'), treeRoot: shared, mode: 'clone', epoch: 'test' });
  const claim = ws.claim({ taskId: ids(1), repoPath: repoWith() });
  const parent = fs.statSync(path.dirname(claim.home)).mode & 0o777;
  const own = fs.statSync(claim.home).mode & 0o777;
  assert.equal(parent & 0o111, 0o111, 'every user can traverse the shared parent');
  assert.equal(own, 0o700, "but only the task's owner can read its own state");
});

test('a state parent left too strict by an older version is corrected', () => {
  const shared = temp('noevia-shared-');
  // What the first version of this created, and what `mkdir` would not fix.
  fs.mkdirSync(path.join(shared, '.harness-home'), { recursive: true, mode: 0o700 });
  const ws = createCodeWorkspaces({ dir: temp('noevia-ws-'), treeRoot: shared, mode: 'clone', epoch: 'test' });
  const claim = ws.claim({ taskId: ids(1), repoPath: repoWith() });
  assert.equal(fs.statSync(path.dirname(claim.home)).mode & 0o111, 0o111, 'now traversable');
});

test('a registered repository owned by another user is used, and any other git refusal is reported as itself', (t) => {
  // On a shared volume the repository belongs to the harness user (the sandbox has to read it)
  // while noevia runs as root. git then refuses with "dubious ownership" unless the path is
  // trusted in a config FILE — this is the one place noevia may say a repository is fine,
  // because the operator registered it.
  const dir = temp('noevia-trust-');
  const repoPath = repoWith();
  const calls = [];
  const ws = createCodeWorkspaces({ dir, epoch: 'trust', run: (args, cwd, env) => {
    calls.push({ args, env });
    if (args[0] === 'rev-parse' && !env?.GIT_CONFIG_GLOBAL) {
      throw Object.assign(Error('git failed'), { stderr: "fatal: detected dubious ownership in repository at '/workspaces/repos/scratch'" });
    }
    return '';
  } });
  const claimed = ws.claim({ taskId: ids(1), repoPath });
  assert.ok(claimed.path, 'the claim succeeds with the repository trusted');
  const trusted = fs.readFileSync(path.join(dir, 'code-workspaces', 'trusted-repositories.gitconfig'), 'utf8');
  assert.match(trusted, /^\[safe\]$/m);
  assert.ok(trusted.includes(fs.realpathSync(repoPath)), 'only the registered repository is named');
  assert.ok(calls.every((c) => c.env?.GIT_CONFIG_GLOBAL), 'every git call carries the trust file, not just the first');

  // Anything else git says is reported as itself rather than as "Not a git repository".
  const other = createCodeWorkspaces({ dir: temp('noevia-trust2-'), epoch: 'trust2', run: () => {
    throw Object.assign(Error('git failed'), { stderr: 'fatal: unable to read /x: Permission denied' });
  } });
  assert.throws(() => other.claim({ taskId: ids(2), repoPath }), (e) => e.status === 400 && /Permission denied/.test(e.message));
});
