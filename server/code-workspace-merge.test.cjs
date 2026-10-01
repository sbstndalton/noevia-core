// code-workspace.cjs additions for the Code pipeline (#705): taking a released task's branch up
// again (reclaim), the Planner's repository snapshot, and the verified fast-forward merge.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createCodeWorkspaces } = require('./code-workspace.cjs');

const temps = [];
const temp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ids = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function repo() {
  const dir = temp('noevia-mrepo-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 'qa@example.invalid'); git(dir, 'config', 'user.name', 'QA');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Synthetic\nFixture readme.\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'first');
  return dir;
}
function commitIn(tree, file, text) {
  fs.writeFileSync(path.join(tree, file), text);
  // A clone has no identity of its own (CI has no global one either).
  git(tree, 'add', file); git(tree, '-c', 'user.email=qa@example.invalid', '-c', 'user.name=QA', 'commit', '-qm', `edit ${file}`);
  return git(tree, 'rev-parse', 'HEAD');
}
/** A task that made one commit and was released: what the pipeline hands to verify and merge. */
function released({ mode = 'worktree' } = {}) {
  const source = repo();
  const ws = createCodeWorkspaces({ dir: temp('noevia-mws-'), epoch: 'test', mode, ...(mode === 'clone' ? { treeRoot: temp('noevia-mtrees-') } : {}) });
  const claim = ws.claim({ taskId: ids(1), repoPath: source });
  const head = commitIn(claim.path, 'a.txt', 'changed');
  const rel = ws.release({ taskId: ids(1) });
  return { source, ws, claim, head, rel };
}

test('the claim records which branch the task forked from', () => {
  const { claim, ws } = released();
  assert.equal(claim.baseBranch, 'main');
  assert.equal(ws.get(ids(1)).baseBranch, 'main');
});

for (const mode of ['worktree', 'clone']) {
  test(`reclaim (${mode}): the next round continues on the same branch, from its last commit, with the original base`, () => {
    const { ws, claim, head, rel } = released({ mode });
    assert.equal(rel.status, 'released');
    assert.equal(rel.headSha, head);
    const again = ws.reclaim({ taskId: ids(1) });
    assert.equal(again.status, 'held');
    assert.equal(again.branch, claim.branch);
    assert.equal(again.baseSha, claim.baseSha, 'judged against where the task first forked');
    assert.equal(again.rounds, 2);
    assert.equal(git(again.path, 'rev-parse', 'HEAD'), head, 'the earlier round’s commit is there');
    const second = commitIn(again.path, 'b.txt', 'b');
    const back = ws.release({ taskId: ids(1) });
    assert.equal(back.status, 'released');
    assert.equal(back.headSha, second);
    assert.equal(git(back.repo, 'rev-list', '--count', `${claim.baseSha}..${claim.branch}`), '2');
  });
}

test('reclaim refuses a task that holds its workspace, is stuck, or never had one', () => {
  const source = repo();
  const ws = createCodeWorkspaces({ dir: temp('noevia-mws-'), epoch: 'test' });
  ws.claim({ taskId: ids(1), repoPath: source });
  assert.throws(() => ws.reclaim({ taskId: ids(1) }), (e) => e.status === 409 && /held/.test(e.message));
  assert.throws(() => ws.reclaim({ taskId: ids(9) }), (e) => e.status === 404);
});

test('projectSnapshot reads the file list and README from the source at the base commit, never the task tree', () => {
  const { ws, claim } = released();
  // A file the task added is not in the base commit's listing.
  const snap = ws.projectSnapshot(ids(1));
  assert.deepEqual(snap.files.sort(), ['README.md', 'a.txt']);
  assert.equal(snap.readme.path, 'README.md');
  assert.match(snap.readme.text, /Fixture readme/);
  assert.equal(snap.truncated, false);
  const small = ws.projectSnapshot(ids(1), { maxFiles: 1, maxReadmeBytes: 4 });
  assert.equal(small.files.length, 1);
  assert.equal(small.truncated, true);
  assert.equal(small.readme.text, '# Sy');
  void claim;
  assert.deepEqual(ws.projectSnapshot(ids(8)), { files: [], truncated: false, readme: null });
});

test('mergeVerified never moves a base that is checked out: an ignored secret.env the task commits stays untouched', () => {
  const source = repo();
  // The owner's own ignored file in the registered repository's working tree.
  fs.appendFileSync(path.join(source, '.git', 'info', 'exclude'), 'secret.env\n');
  fs.writeFileSync(path.join(source, 'secret.env'), 'TOKEN=the-owners-real-value\n');
  const ws = createCodeWorkspaces({ dir: temp('noevia-mws-'), epoch: 'test' });
  const claim = ws.claim({ taskId: ids(1), repoPath: source });
  fs.writeFileSync(path.join(claim.path, 'secret.env'), 'TOKEN=from-the-task\n');
  git(claim.path, 'add', '-f', 'secret.env'); git(claim.path, 'commit', '-qm', 'task tracks secret.env');
  const head = git(claim.path, 'rev-parse', 'HEAD');
  ws.release({ taskId: ids(1) });
  assert.equal(ws.mergePreflight(ids(1), { headSha: head }).code, 'checked_out');
  const refused = ws.mergeVerified(ids(1), { headSha: head });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'checked_out');
  assert.match(refused.reason, new RegExp(`main is checked out in .*To merge it yourself, run there: git merge --ff-only ${head}`));
  assert.equal(fs.readFileSync(path.join(source, 'secret.env'), 'utf8'), 'TOKEN=the-owners-real-value\n', 'the owner’s file is unchanged');
  assert.equal(git(source, 'rev-parse', 'main'), claim.baseSha, 'main did not move');
  // A dirty checked-out base is refused the same way.
  fs.writeFileSync(path.join(source, 'a.txt'), 'uncommitted');
  assert.equal(ws.mergeVerified(ids(1), { headSha: head }).code, 'checked_out');
  assert.equal(fs.readFileSync(path.join(source, 'a.txt'), 'utf8'), 'uncommitted');
});

test('mergeVerified moves a base that is not checked out with a compare-and-swap, exactly to the reviewed head', () => {
  const { source, ws, head, claim } = released();
  git(source, 'checkout', '-q', '--detach');
  assert.deepEqual(ws.mergePreflight(ids(1), { headSha: head }), { ok: true, baseBranch: 'main' });
  const merged = ws.mergeVerified(ids(1), { headSha: head });
  assert.deepEqual(merged, { ok: true, baseBranch: 'main', from: claim.baseSha, to: head });
  assert.equal(git(source, 'rev-parse', 'main'), head);
  assert.equal(git(source, 'rev-parse', 'HEAD'), claim.baseSha, 'no working tree was touched');
  assert.equal(ws.get(ids(1)).merged.to, head);
  // Never twice: the base is no longer at the task's base.
  assert.equal(ws.mergeVerified(ids(1), { headSha: head }).code, 'base_moved');
});

test('mergeVerified: a merge that happened but could not be recorded says so, and is still a merge', () => {
  const { source, ws, head } = released();
  git(source, 'checkout', '-q', '--detach');
  const original = fs.writeFileSync;
  fs.writeFileSync = (target, ...rest) => {
    if (String(target).endsWith(`${ids(1)}.json`)) throw Object.assign(Error('EROFS: read-only file system'), { code: 'EROFS' });
    return original(target, ...rest);
  };
  let merged;
  try { merged = ws.mergeVerified(ids(1), { headSha: head }); } finally { fs.writeFileSync = original; }
  assert.equal(merged.ok, true);
  assert.equal(merged.recordFailed, true);
  assert.equal(git(source, 'rev-parse', 'main'), head);
});

test('mergeVerified refuses, and changes nothing, unless base, head and ancestry all still hold', () => {
  // The base moved.
  {
    const { source, ws, head } = released();
    const moved = commitIn(source, 'other.txt', 'someone else');
    assert.equal(ws.mergeVerified(ids(1), { headSha: head }).code, 'base_moved');
    assert.equal(git(source, 'rev-parse', 'main'), moved);
  }
  // The task branch moved past the reviewed head.
  {
    const { source, ws, head, claim } = released();
    const tmp = temp('noevia-late-');
    git(source, 'worktree', 'add', '-q', tmp, claim.branch);
    commitIn(tmp, 'late.txt', 'late');
    git(source, 'worktree', 'remove', '--force', tmp);
    assert.equal(ws.mergeVerified(ids(1), { headSha: head }).code, 'head_moved');
    assert.equal(git(source, 'rev-parse', 'main'), claim.baseSha);
  }
  // A short or wrong head id, a held workspace, an unknown task.
  {
    const { ws, head } = released();
    assert.equal(ws.mergeVerified(ids(1), { headSha: head.slice(0, 12) }).code, 'bad_sha');
    assert.equal(ws.mergeVerified(ids(1), { headSha: 'f'.repeat(40) }).code, 'head_moved');
    assert.equal(ws.mergeVerified(ids(7), { headSha: head }).code, 'no_workspace');
    ws.reclaim({ taskId: ids(1) });
    assert.equal(ws.mergeVerified(ids(1), { headSha: head }).code, 'not_released');
  }
  // The base checked out in another worktree.
  {
    const { source, ws, head, claim } = released();
    git(source, 'checkout', '-q', '-b', 'parked');
    const other = temp('noevia-other-');
    fs.rmSync(other, { recursive: true, force: true });
    git(source, 'worktree', 'add', '-q', other, 'main');
    assert.equal(ws.mergeVerified(ids(1), { headSha: head }).code, 'checked_out');
    assert.equal(git(source, 'rev-parse', 'main'), claim.baseSha);
  }
  // A detached source HEAD at claim: there is no named base to move.
  {
    const source = repo();
    git(source, 'checkout', '-q', '--detach');
    const ws = createCodeWorkspaces({ dir: temp('noevia-mws-'), epoch: 'test' });
    const claim = ws.claim({ taskId: ids(1), repoPath: source });
    const head = commitIn(claim.path, 'a.txt', 'x');
    ws.release({ taskId: ids(1) });
    assert.equal(ws.mergeVerified(ids(1), { headSha: head }).code, 'no_base_branch');
  }
});

test('branchTip reads the task branch in the source repository', () => {
  const { ws, head } = released();
  assert.equal(ws.branchTip(ids(1)), head);
  assert.equal(ws.branchTip(ids(5)), null);
  assert.equal(ws.branchTip('not-an-id'), null);
});
