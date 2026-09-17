'use strict';
// Code mode as a project feature: start a coding task, watch it, answer its approvals, cancel
// it (spec-agent-execution §3). Admin-only and behind features.codeHarness. Every dependency is
// injected; nothing here reaches into index.cjs.
//
// One rule shapes the whole surface: **a task may only run in a repository the operator
// registered.** A member — or a prompt-injected instruction — cannot name a path on the host and
// have noevia open it. `CODE_REPOS` is deployment configuration, read at startup, the same way
// model download targets are.
const path = require('node:path'), fs = require('node:fs'), crypto = require('node:crypto');
const { createJobs } = require('./jobs.cjs');
const { createCodeHarness } = require('./code-harness.cjs');
const { createCodeWorkspaces } = require('./code-workspace.cjs');
const { ACTIONS } = require('./code-actions.cjs');

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Prompt preparation (spec §2). Direct is the default and the only one offered, and the others
 * carry the reason they are not — which is a measurement, not an opinion. There is deliberately
 * no `Auto`: §2 allows one only after paired fixtures prove a benefit, and the 4B-as-architect
 * run scored 0/18 on the schema.
 */
const PROMPT_PREPARATION = Object.freeze([
  { id: 'direct', label: 'Direct', available: true,
    reason: 'Your request goes to the model as you wrote it.' },
  { id: 'local', label: 'Local architect', available: false,
    reason: 'Not offered yet: as an architect the 4B returned 0 of 18 usable execution prompts (list fields came back as strings). Direct stays the default until that changes.' },
  { id: 'frontier', label: 'Frontier architect', available: false,
    reason: 'Not built: it needs a provider, official authentication and the outbound allowlist enforced in code (spec §2).' },
]);
// What a task may be granted at all. Browser and external-account actions have no home here
// yet: they belong to the execution node (§5), so a task cannot be given one by mistake.
const GRANTABLE = Object.freeze([ACTIONS.READ, ACTIONS.EDIT, ACTIONS.EXECUTE, ACTIONS.INSTALL,
  ACTIONS.NETWORK, ACTIONS.DELETE, ACTIONS.GIT_PUSH]);
const DEFAULT_CAPABILITIES = Object.freeze([ACTIONS.READ, ACTIONS.EDIT, ACTIONS.EXECUTE]);

const fail = (status, message) => Object.assign(Error(message), { status, publicMessage: message });

/** `CODE_REPOS=name|/path,other|/path2` — the only repositories a task can ever be given. */
function parseRepos(raw) {
  const out = [];
  for (const entry of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [name, location] = entry.split('|').map((s) => (s || '').trim());
    if (!name || !location || !path.isAbsolute(location)) continue;
    let resolved; try { resolved = fs.realpathSync(location); } catch { continue; }
    if (!fs.existsSync(path.join(resolved, '.git'))) continue;
    if (!out.some((r) => r.id === name)) out.push({ id: name, path: resolved });
  }
  return out;
}

/** Public view of a task. Bounded, and never carrying a token or a host path outside the work. */
function view(job, pending = null) {
  if (!job) return null;
  return {
    id: job.id, status: job.status, stage: job.stage, error: job.error,
    task: job.checkpoint?.task || null, branch: job.checkpoint?.branch || null,
    // What the run could say about itself, and what it could not (§1). The identity hash is
    // what a later evidence record would be scoped to.
    meta: job.checkpoint?.meta || null, identityHash: job.checkpoint?.identityHash || null,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    capabilities: job.capabilities,
    steps: job.steps, plan: job.plan,
    approval: pending ? { id: pending.id, ...pending.request } : null,
    result: job.result || null,
  };
}

/**
 * @param {{ repos: string|Array, connect: Function, egress?: object, now?: ()=>number,
 *           log?: Function, timeoutMs?: number }} deps
 */
function createCodeService({ repos, connect, egress = null, now = Date.now, log = () => {},
  timeoutMs = APPROVAL_TIMEOUT_MS, sandboxKind = process.env.CODE_HARNESS_ENDPOINT ? 'sandbox' : 'spawn',
  harnesses = defaultHarnesses(), treeRoot = process.env.CODE_WORKSPACE_ROOT || null,
  harnessUser = parseUser(process.env.CODE_HARNESS_USER) }) {
  const repositories = Array.isArray(repos) ? repos : parseRepos(repos);
  // Approvals live in memory on purpose, exactly as the chat gate does: a decision that
  // outlives the request it belongs to is not a decision, and a restart must re-ask.
  const pending = new Map(); // approvalId -> { id, taskId, request, resolve, timer }
  const stores = new WeakMap();

  function storeFor(workspace) {
    let store = stores.get(workspace);
    if (!store) {
      store = createJobs({ dir: workspace.dir, kinds: ['code'], maxJobs: 50, retainMs: 14 * 86400000, now });
      store.recover();
      // With a sandbox the worktrees live on a volume mounted at the same path in both
      // containers, and are handed to the uid the harness runs as (noevia runs as root; the
      // sandbox deliberately does not).
      const workspaces = createCodeWorkspaces({ dir: workspace.dir, treeRoot, owner: harnessUser, now });
      workspaces.recover();
      const harness = createCodeHarness({ jobs: store, workspaces, egress, log, now, askApproval });
      store = { jobs: store, workspaces, harness };
      stores.set(workspace, store);
    }
    return store;
  }

  function askApproval(request) {
    return new Promise((resolve) => {
      // A random id, not one derived from the map's size and the clock: two approvals raised in
      // the same millisecond would otherwise collide, and the overwritten one would hang until
      // its timeout with nobody able to answer it.
      const id = crypto.randomUUID();
      let settled = false;
      const finish = (decision) => {
        if (settled) return;
        settled = true; clearTimeout(timer); pending.delete(id); resolve(decision);
      };
      // Waiting forever is a leaked task. Timing out as a REFUSAL is the only safe default.
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      timer.unref?.();
      pending.set(id, { id, taskId: request.taskId, request, decide: finish });
    });
  }
  const pendingFor = (taskId) => [...pending.values()].find((p) => p.taskId === taskId) || null;

  function owned(workspace, project, taskId) {
    const { jobs } = storeFor(workspace);
    const job = jobs.get(taskId);
    // A task belongs to one project in one tenant's workspace: anything else is not found,
    // not forbidden, so the id itself tells a caller nothing.
    if (!job || job.kind !== 'code' || job.projectId !== project.id) throw fail(404, 'Task not found');
    return job;
  }

  return {
    repositories: () => repositories.map((r) => ({ id: r.id })),
    grantable: GRANTABLE,
    defaultCapabilities: DEFAULT_CAPABILITIES,
    // One harness is configured per deployment today. It is reported as a list anyway, because
    // the shape is what changes when a second one is adapted — and an `Auto` that picks between
    // them is only allowed once there is measured evidence to pick on (§3).
    harnesses: () => harnesses.map((h) => ({ ...h })),
    promptPreparation: () => PROMPT_PREPARATION.map((p) => ({ ...p })),
    sandboxed: () => sandboxKind === 'sandbox',

    list(workspace, project) {
      const { jobs } = storeFor(workspace);
      return jobs.list({ projectId: project.id, kind: 'code' }).map((j) => view(j, pendingFor(j.id)));
    },
    get(workspace, project, taskId) {
      return view(owned(workspace, project, taskId), pendingFor(taskId));
    },
    async start(workspace, project, body = {}) {
      const repo = repositories.find((r) => r.id === String(body.repository || ''));
      if (!repo) throw fail(400, 'Choose a repository the operator registered on this server.');
      const prompt = String(body.prompt || '').trim();
      if (!prompt) throw fail(400, 'Describe the task.');
      if (prompt.length > 8000) throw fail(400, 'That task description is too long.');
      const asked = Array.isArray(body.capabilities) ? body.capabilities : DEFAULT_CAPABILITIES;
      const capabilities = GRANTABLE.filter((c) => asked.includes(c));
      // A harness or a preparation mode noevia does not offer is refused here, not passed on:
      // the browser's list is a convenience, never the authority.
      const harnessId = String(body.harness || harnesses[0]?.id || '');
      if (!harnesses.some((h) => h.id === harnessId)) throw fail(400, 'That coding harness is not configured on this server.');
      const preparation = PROMPT_PREPARATION.find((p) => p.id === String(body.promptPreparation || 'direct'));
      if (!preparation) throw fail(400, 'Unknown prompt preparation.');
      if (!preparation.available) throw fail(409, preparation.reason);
      const domains = (Array.isArray(body.domains) ? body.domains : [])
        .map((d) => String(d || '').trim().toLowerCase()).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)).slice(0, 20);
      const { harness, jobs } = storeFor(workspace);
      // One task at a time per project: a second writer is the thing §3 says to avoid, and it
      // also makes "what is running" answerable without a scheduler.
      if (jobs.list({ projectId: project.id, kind: 'code', active: true }).length) {
        throw fail(409, 'This project already has a task running.');
      }
      const started = await harness.start({ projectId: project.id, repoPath: repo.path, prompt,
        capabilities, domains, connect, model: body.model ? String(body.model) : null, sandboxKind,
        harness: harnessId, promptPreparation: preparation.id });
      return { ...started, repository: repo.id, capabilities, domains, harness: harnessId, promptPreparation: preparation.id };
    },
    decide(workspace, project, taskId, decision) {
      owned(workspace, project, taskId);
      if (!['approve', 'approve_all', 'deny'].includes(decision)) throw fail(400, 'Unknown decision');
      const waiting = pendingFor(taskId);
      if (!waiting) throw fail(409, 'That approval is no longer waiting.');
      waiting.decide(decision);
      return { ok: true };
    },
    cancel(workspace, project, taskId) {
      owned(workspace, project, taskId);
      // Refuse anything still waiting first, so a cancelled task never leaves a card that
      // could later be answered into an action.
      pendingFor(taskId)?.decide('aborted');
      const { harness, jobs } = storeFor(workspace);
      harness.cancel(taskId);
      return view(jobs.get(taskId), null);
    },
  };
}

/** `CODE_HARNESS_USER=1000:1000` — who the sandbox runs as, so a worktree can be handed over. */
function parseUser(raw) {
  const match = /^(\d{1,7}):(\d{1,7})$/.exec(String(raw || '').trim());
  return match ? { uid: Number(match[1]), gid: Number(match[2]) } : null;
}

/** What this deployment runs. One entry today; the sandbox pins its version at build time. */
function defaultHarnesses(env = process.env) {
  const id = String(env.CODE_HARNESS_NAME || 'opencode').trim() || 'opencode';
  return [{ id, label: id === 'opencode' ? 'OpenCode' : id, version: env.CODE_HARNESS_VERSION || null }];
}

module.exports = { createCodeService, parseRepos, view, defaultHarnesses, parseUser, GRANTABLE, DEFAULT_CAPABILITIES, PROMPT_PREPARATION, APPROVAL_TIMEOUT_MS };
