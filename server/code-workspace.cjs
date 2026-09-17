'use strict';
// One writer per workspace (spec-agent-execution §3, "Workspace isolation").
//
// A coding task never runs in the repository's own working tree. It gets a git worktree of its
// own on its own branch, and that worktree is the only place it may write. Two things follow:
// the user's tree is never left dirty or half-patched by a task, and containment becomes a
// question about one directory rather than about everything the harness process can reach.
//
// Containment is resolved with realpath, because the ACP spike escalated exactly here: the
// agent behaved differently once the workspace was reached through a symlink. A path that does
// not exist yet (a file about to be created) is judged by its nearest existing ancestor, so a
// symlinked parent cannot smuggle a write out of the worktree.
//
// This module decides and records ownership. It is NOT the sandbox: the harness still runs
// unprivileged, in a container, with no credentials and no egress unless granted.
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');

const TASK_ID = /^[0-9a-f-]{36}$/;
const BRANCH_PREFIX = 'noevia/task-';

function defaultRun(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim();
}

/**
 * @param {{dir: string, treeRoot?: string|null, owner?: {uid: number, gid: number}|null,
 *          run?: (args: string[], cwd?: string) => string, now?: () => number, epoch?: string,
 *          chown?: (target: string, uid: number, gid: number) => void}} deps
 *
 * `treeRoot` puts the worktrees somewhere other than the tenant's own directory. That matters
 * for the sandbox: the harness runs in a different container and must see the worktree at the
 * SAME absolute path, which means a shared volume mounted identically in both. The ownership
 * records stay tenant-side either way — only the working trees move.
 *
 * `owner` hands each new worktree to the uid the sandbox runs as. noevia runs as root and the
 * sandbox deliberately does not, so without this the harness cannot write the tree it was
 * given. `epoch` identifies this process: claims from an earlier one are reported as
 * interrupted rather than silently reused.
 */
function createCodeWorkspaces({ dir, treeRoot = null, owner = null, run = defaultRun,
  now = Date.now, epoch = String(process.pid), chown = defaultChown } = {}) {
  const root = path.join(dir, 'code-workspaces');
  const trees = treeRoot || root;
  const recordFile = (taskId) => path.join(root, taskId + '.json');
  const treeDir = (taskId) => path.join(trees, taskId);

  const checkId = (taskId) => {
    if (!TASK_ID.test(String(taskId || ''))) throw Object.assign(Error('Invalid task id'), { status: 400 });
    return String(taskId);
  };
  function read(taskId) {
    try { return JSON.parse(fs.readFileSync(recordFile(checkId(taskId)), 'utf8')); }
    catch (e) { if (e.status) throw e; return null; }
  }
  function write(record) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(recordFile(record.taskId), JSON.stringify(record), { mode: 0o600 });
    return record;
  }
  function list() {
    try {
      return fs.readdirSync(root).filter((n) => n.endsWith('.json'))
        .map((n) => read(n.slice(0, -5))).filter(Boolean).sort((a, b) => b.claimedAt - a.claimedAt);
    } catch { return []; }
  }

  /**
   * Take the workspace for one task. Refuses a second live claim on the same repository and
   * branch — that is the "one writer" rule — and refuses to reuse a task id.
   */
  function claim({ taskId, repoPath, branch = null, capabilities = [], domains = [] }) {
    const id = checkId(taskId);
    if (read(id)) throw Object.assign(Error('This task already has a workspace'), { status: 409 });
    let repo;
    try { repo = fs.realpathSync(String(repoPath || '')); }
    catch { throw Object.assign(Error('No such repository'), { status: 400 }); }
    try { run(['rev-parse', '--git-dir'], repo); }
    catch { throw Object.assign(Error('Not a git repository'), { status: 400 }); }

    // The whole task id, not a prefix: two tasks must never derive the same branch.
    const name = branch ? String(branch) : BRANCH_PREFIX + id;
    if (!/^[\w./-]+$/.test(name) || name.includes('..') || name.startsWith('-')) {
      throw Object.assign(Error('Invalid branch name'), { status: 400 });
    }
    // Anything that has not cleanly released still owns the branch — a stuck worktree and an
    // interrupted claim both keep it checked out, so both keep blocking until someone looks.
    const held = list().find((r) => r.status !== 'released' && r.repo === repo && r.branch === name);
    if (held) throw Object.assign(Error(`Another task already writes ${name} in this repository (${held.status})`), { status: 409 });

    const tree = treeDir(id);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (trees !== root) fs.mkdirSync(trees, { recursive: true, mode: 0o755 });
    // -B so a branch left behind by an earlier, released task does not block a new one; the
    // worktree path itself must be new, which `git worktree add` enforces.
    run(['worktree', 'add', '-B', name, tree], repo);
    // Hand it to whoever runs the harness. Done after the worktree exists so git's own files
    // (including .git) are covered, and best-effort: a deployment without a separate sandbox
    // user has nothing to hand over.
    if (owner) { try { chown(tree, owner.uid, owner.gid); } catch (e) { throw Object.assign(Error(`Could not hand the workspace to the harness user: ${e.message}`), { status: 500 }); } }
    return write({ taskId: id, repo, branch: name, path: fs.realpathSync(tree), status: 'held',
      capabilities: [...capabilities], domains: [...domains], epoch, claimedAt: now() });
  }

  /**
   * Is this path inside the task's worktree? `null` when the task holds no workspace, so a
   * caller cannot mistake "unknown" for "yes".
   */
  function contains(taskId, candidate) {
    const record = read(taskId);
    if (!record || record.status !== 'held') return null;
    if (typeof candidate !== 'string' || !candidate) return false;
    // Relative paths are resolved against the worktree, as ACP paths are absolute by spec and
    // anything else is the harness deviating from it.
    const target = path.resolve(record.path, candidate);
    let resolvedRoot;
    try { resolvedRoot = fs.realpathSync(record.path); } catch { return false; }
    let probe = target, unresolved = 0;
    for (;;) {
      try { probe = fs.realpathSync(probe); break; }
      catch {
        const parent = path.dirname(probe);
        // A path whose every ancestor is missing cannot be inside anything that exists.
        if (parent === probe || ++unresolved > 64) return false;
        probe = parent;
      }
    }
    // The resolved ancestor must be the root or under it, and the unresolved remainder must not
    // climb back out with `..`.
    const rest = path.relative(probe, target);
    if (rest.split(path.sep).includes('..')) return false;
    const rel = path.relative(resolvedRoot, probe);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  /** Give the workspace back. The branch survives by default: the work is the point. */
  function release({ taskId, removeBranch = false } = {}) {
    const record = read(taskId);
    if (!record) return null;
    let removed = true, error = null;
    try { run(['worktree', 'remove', '--force', record.path], record.repo); }
    catch (e) { removed = false; error = e.message; }
    try { run(['worktree', 'prune'], record.repo); } catch { /* best effort */ }
    if (removed && removeBranch) { try { run(['branch', '-D', record.branch], record.repo); } catch { /* keep going */ } }
    // An unremovable worktree is recorded, not hidden: it still holds the branch, so the next
    // claim on it must keep failing until someone looks.
    return write({ ...record, status: removed ? 'released' : 'stuck', releasedAt: now(), error });
  }

  /**
   * After a restart, claims made by an earlier process are interrupted: the harness that held
   * them is gone. They are reported, never reused, and never cleaned up automatically — the
   * worktree may hold work nobody has read yet.
   */
  function recover() {
    return list().filter((r) => r.status === 'held' && r.epoch !== epoch)
      .map((r) => write({ ...r, status: 'interrupted', interruptedAt: now() }));
  }

  return { claim, release, recover, contains, get: read, list, root, BRANCH_PREFIX };
}

/** Recursive chown, so the harness owns the tree and git's own files inside it. */
function defaultChown(target, uid, gid) {
  const walk = (entry) => {
    fs.lchownSync(entry, uid, gid);
    let stat; try { stat = fs.lstatSync(entry); } catch { return; }
    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(entry)) walk(path.join(entry, name));
  };
  walk(target);
}

module.exports = { createCodeWorkspaces, defaultChown, BRANCH_PREFIX };
