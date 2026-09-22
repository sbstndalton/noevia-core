'use strict';
// The CodeHarness session: one coding task, run by an external ACP agent, held inside
// noevia's own rules (spec-agent-execution §3).
//
// This module owns the policy and the record. The transport is injected — a connected ACP
// agent, whatever speaks for it — so the rules here are testable without a subprocess, and so a
// second harness can be adapted without touching any of this.
//
// What it guarantees, in order of how much it matters:
//   1. Every action the agent reports is classified (`code-actions.cjs`) and either allowed,
//      refused outright, or put in front of a human with its full arguments. There is no path
//      that writes, deletes, installs or pushes without one of those three happening first.
//   2. "Allow for this task" is scoped to this job AND that one action class, and dies with the
//      job. There is still no global never-ask.
//   3. Every file the agent asks noevia to read or write is checked against the task's own
//      worktree with realpath, after approval as well as before it.
//   4. The record is the job's append-only event log, so a task survives navigation and a
//      restart says what was interrupted instead of quietly resuming.
//
// It is not the sandbox. The spike showed an agent writing and running commands in its own
// process; the container, the worktree and the egress proxy are what contain it.
const fs = require('node:fs'), nodePath = require('node:path');
const { classify, decide, pickOption, ACTIONS } = require('./code-actions.cjs');
const { readUsage, readContext, readExitCode, codingIdentity, summarize } = require('./code-meta.cjs');

const MAX_TEXT = 4000;                  // what a job event keeps, as chat keeps of a tool result
const MAX_FILE_BYTES = 8 * 1024 * 1024; // one source file, not a database the agent found

/**
 * @param {{jobs: object, workspaces: object, egress?: object, now?: () => number,
 *          askApproval: (request: object) => Promise<'approve'|'approve_all'|'deny'|'timeout'|'aborted'>,
 *          log?: (entry: object) => void}} deps
 */
function createCodeHarness({ jobs, workspaces, egress = null, askApproval, now = Date.now, log = () => {},
  files = defaultFiles, pinConfig = require('./code-harness-config.cjs').writeHarnessConfig,
  engine = () => ({ baseUrl: null, apiKey: null, contextTokens: undefined }) }) {
  /**
   * Start a task. `capabilities` is fixed here and never widens (§4): the job records it, and
   * every later decision is taken against this list, not against anything the agent claims.
   */
  async function start({ projectId = null, repoPath, prompt, capabilities = [], domains = [],
    harness = 'opencode', connect, model = null, sandboxKind = 'spawn', promptPreparation = 'direct', context = '' }) {
    if (!prompt || !String(prompt).trim()) throw Object.assign(Error('A task needs a prompt'), { status: 400 });
    if (typeof connect !== 'function') throw Object.assign(Error('No harness transport'), { status: 500 });
    const taskId = jobs.create({ kind: 'code', projectId, capabilities: [...new Set(capabilities)] });

    let workspace;
    try { workspace = workspaces.claim({ taskId, repoPath, capabilities, domains }); }
    catch (error) { jobs.append(taskId, 'job.failed', { error: String(error.message).slice(0, 500) }); throw error; }

    // Network is a capability like any other: no grant unless the task has it AND named domains.
    const wantsNetwork = capabilities.includes(ACTIONS.NETWORK) || capabilities.includes(ACTIONS.INSTALL);
    const grant = egress && wantsNetwork && domains.length ? egress.grant({ taskId, domains }) : null;

    // The whole body is inside the try: the grant and the worktree have to come back even when
    // something fails before the harness ever starts. Writing that first checkpoint touches the
    // disk, so it can fail for ordinary reasons — a full volume, a read-only mount — and leaving
    // it outside meant a live proxy token and a branch claimed for good.
    jobs.run(taskId, async (ctx) => {
      try {
        // A task that named no model runs on whatever this deployment loads, and the identity
        // records the model that actually ran rather than the absence of a choice.
        const endpoint = engine();
        const chosen = model || endpoint.model || null;
        const session = createSession({ taskId, ctx, workspace, domains, capabilities, harness, model: chosen });
        // Recorded first so a running task is identifiable in the list, not just once it ends.
        ctx.checkpoint({ branch: workspace.branch, task: String(prompt).slice(0, 120) });
        // The agent's own config file, written by noevia before the agent exists: the gate it
        // will actually obey, and the only model endpoint it is given. A harness whose config
        // noevia cannot pin throws here, before anything runs.
        // A step of the run, not a new event type: the vocabulary is closed on purpose, and
        // this either happened or the task stops here.
        ctx.event('step.started', { id: 'harness.config', title: 'Pin the harness configuration' });
        let pinned;
        try {
          pinned = pinConfig({ cwd: workspace.path, home: workspace.home || null, owner: workspaces.owner || null, harness, model: chosen,
            engine: endpoint.baseUrl, apiKey: endpoint.apiKey || null,
            ...(endpoint.contextTokens ? { contextTokens: endpoint.contextTokens } : {}) });
        } catch (error) {
          ctx.event('step.completed', { id: 'harness.config', failed: true, error: String(error.message).slice(0, 300) });
          throw error;
        }
        ctx.event('step.completed', { id: 'harness.config', ...pinned });
        const agent = await connect({
          taskId, harness, model: chosen, cwd: workspace.path, home: workspace.home || null,
          // The adapter pins the agent's own permission config: the spike showed OpenCode's
          // defaults writing silently, and noevia refuses to run a harness whose effective
          // config it cannot pin.
          permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
          proxy: grant ? { url: `http://task:${grant.token}@${egress.endpoint || 'egress'}`, domains: [...domains],
            // The agent's own model calls go straight to the engine on the internal network; sent
            // through the proxy they would be refused as a private address.
            noProxy: engineHost(engine) } : null,
          handlers: session.handlers,
          signal: ctx.signal,
        });
        ctx.progress('running');
        // Shared project context (shared-context.cjs) goes in front of the task, never into its label.
        const outcome = await agent.prompt(context ? `${context}\n\nTask:\n${String(prompt)}` : String(prompt));
        // What the run can say about itself, and — just as much — what it could not (§1).
        const meta = session.meta(agent.agent, readUsage(outcome?._meta));
        const scope = codingIdentity({
          harness: meta.harness || harness, harnessVersion: meta.harnessVersion,
          model: chosen, protocolVersion: meta.protocolVersion, capabilities,
          promptPreparation, sandbox: sandboxKind,
        });
        ctx.event('checkpoint.created', { branch: workspace.branch, task: String(prompt).slice(0, 120),
          identityHash: scope.identityHash, identity: scope.identity, meta });
        return { stopReason: outcome?.stopReason || 'end_turn', branch: workspace.branch,
          identityHash: scope.identityHash, meta, ...session.summary() };
      } finally {
        // Whatever happened, the task stops being able to reach anything.
        if (grant) egress.revoke(taskId);
        workspaces.release({ taskId });
      }
    }).catch(() => { /* jobs.run records the failure; nothing here should throw into the caller */ });

    return { taskId, branch: workspace.branch, workspace: workspace.path };
  }

  /** The per-session state and the handlers an ACP connection calls back into. */
  function createSession({ taskId, ctx, workspace, domains, capabilities, harness, model }) {
    // "Allow for this task", per action class. Scoped to this job, in memory, gone when it ends.
    const blanket = new Map(); // action -> 'allow' | 'deny'
    const counts = { tools: 0, approvals: 0, allowed: 0, refused: 0, denied: 0 };
    // Exit codes per finished command, when the harness bothers to report one. Bounded: a long
    // task should not be able to grow this without limit.
    const exits = [];
    const names = new Map(); // toolCallId -> what it was, so an exit code has a label
    // OpenCode reports token usage in its own `usage_update`, not on the prompt result — found
    // by running the real thing. Whatever arrives goes through the same defensive reader, so a
    // harness using a different shape degrades to "not reported" rather than to a wrong number.
    let reportedUsage = null;
    // How full the window is, which the real harness reports and token usage, which it does not.
    let reportedContext = null;
    let messageChunks = 0;

    const record = (entry) => log({ at: now(), taskId, harness, model, ...entry });

    /** Where a call wants to write, as far as we can tell before it happens. */
    const containment = (classified) => {
      if (!classified.paths.length) return null;
      // Every named path must be inside. One outside is enough to refuse the call.
      const verdicts = classified.paths.map((p) => workspaces.contains(taskId, p));
      if (verdicts.includes(false)) return false;
      return verdicts.every((v) => v === true) ? true : null;
    };

    async function requestPermission({ toolCall = {}, options = [] } = {}) {
      const classified = classify(toolCall);
      counts.approvals++;
      const verdict = decide({ classified, capabilities, domains, inWorkspace: containment(classified) });

      if (verdict.decision === 'deny') {
        counts.denied++;
        record({ event: 'code.refused', action: classified.action, reason: verdict.reason });
        ctx.event('approval.decided', { decision: 'denied', action: classified.action, reason: verdict.reason, automatic: true });
        return pickOption(options, 'reject_once');
      }
      if (verdict.decision === 'allow') {
        counts.allowed++;
        return pickOption(options, 'allow_once');
      }
      // A standing "allow for this task" covers only the same class, and never a delete or a
      // push: the two actions whose damage a human should see every single time.
      const standing = blanket.get(classified.action);
      if (standing === 'allow') { counts.allowed++; return pickOption(options, 'allow_once'); }
      if (standing === 'deny') { counts.refused++; return pickOption(options, 'reject_once'); }

      const request = {
        taskId, action: classified.action, title: toolCall.title || '', kind: toolCall.kind || '',
        command: classified.command, paths: classified.paths, reason: verdict.reason,
        // Full, untruncated arguments: that IS the gate.
        arguments: toolCall.rawInput ?? null,
        diff: diffOf(toolCall),
      };
      ctx.event('approval.requested', request);
      const answer = await askApproval(request);
      ctx.event('approval.decided', { decision: answer, action: classified.action });
      record({ event: 'code.decided', action: classified.action, decision: answer });

      if (answer === 'approve' || answer === 'approve_all') {
        if (answer === 'approve_all' && canStand(classified.action)) blanket.set(classified.action, 'allow');
        counts.allowed++;
        return pickOption(options, 'allow_once');
      }
      counts.refused++;
      // A timeout or an abort is a refusal, never an allow.
      return pickOption(options, 'reject_once');
    }

    /**
     * noevia's file API for the agent: inside the worktree or not at all. The spike showed an
     * approved write being carried out through this path, which is what lets noevia contain it
     * and record it — so the containment check is repeated HERE, not trusted from approval
     * time. The path approved and the path written are two different facts, and only this one
     * is the write.
     */
    const inside = (target) => {
      if (workspaces.contains(taskId, target) !== true) {
        record({ event: 'code.refused', reason: 'path outside the workspace' });
        throw Object.assign(Error('Outside this task’s workspace'), { code: -32602 });
      }
      return target;
    };
    const readTextFile = async ({ path: target, line = null, limit = null } = {}) => {
      const content = files.read(inside(target), MAX_FILE_BYTES);
      if (line === null && limit === null) return { content };
      const all = content.split('\n');
      const from = Math.max(0, (Number(line) || 1) - 1);
      return { content: all.slice(from, limit ? from + Number(limit) : undefined).join('\n') };
    };
    const writeTextFile = async ({ path: target, content } = {}) => {
      const text = String(content ?? '');
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw Object.assign(Error('File too large'), { code: -32602 });
      files.write(inside(target), text);
      ctx.event('tool.completed', { name: 'write_file', path: target, bytes: Buffer.byteLength(text) });
      return null;
    };

    function sessionUpdate(update = {}) {
      const kind = update.sessionUpdate || update.type;
      if (kind === 'tool_call') {
        counts.tools++;
        const classified = classify(update);
        if (update.toolCallId) names.set(update.toolCallId, update.title || update.kind || 'tool');
        ctx.event('tool.started', { id: update.toolCallId, name: update.title || update.kind || 'tool',
          action: classified.action, kind: update.kind || null });
      } else if (kind === 'tool_call_update') {
        const done = update.status === 'completed' || update.status === 'failed';
        if (done) {
          const exitCode = readExitCode(update);
          if (exitCode !== null && exits.length < 200) {
            exits.push({ id: update.toolCallId ?? null, name: names.get(update.toolCallId) || null, exitCode });
          }
          ctx.event('tool.completed', { id: update.toolCallId, failed: update.status === 'failed',
            exitCode, content: summarizeContent(update.content) });
        }
      } else if (kind === 'plan') {
        ctx.event('plan.proposed', { question: null, subQuestions: (update.entries || []).map((e) => String(e.content || '').slice(0, 200)) });
      } else if (kind === 'usage_update') {
        const reported = readUsage(update) || readUsage(update.usage) || readUsage(update._meta);
        if (reported) reportedUsage = reported;
        const window = readContext(update);
        if (window) reportedContext = window;
      } else if (kind === 'available_commands_update') {
        // What the harness can do, not something it is doing. Nothing to record.
      } else if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
        // Streaming text arrives in many small chunks — 548 thought chunks and 50 message
        // chunks in one real run — so this counts chunks and says so, rather than calling them
        // turns.
        if (kind === 'agent_message_chunk') messageChunks++;
        // Thoughts are progress, not stored reasoning: the spec keeps hidden reasoning out.
        ctx.event('progress', { stage: kind === 'agent_thought_chunk' ? 'thinking' : 'writing' });
      }
    }

    return {
      handlers: { requestPermission, readTextFile, writeTextFile, sessionUpdate },
      summary: () => ({ ...counts, workspace: workspace.path }),
      // Usage the harness streamed wins over anything on the prompt result: the real one reports
      // it in `usage_update` and leaves the result's `_meta` empty.
      meta: (agentInfo, usage) => summarize({ agent: agentInfo || {}, usage: reportedUsage || usage,
        context: reportedContext, exits, messageChunks }),
    };
  }

  /**
   * Delete and git push never get a standing approval, however the user answers: a blanket yes
   * is for repetition, and these two are not repetitive in the way that matters.
   */
  function canStand(action) { return action !== ACTIONS.DELETE && action !== ACTIONS.GIT_PUSH; }

  function diffOf(toolCall) {
    const blocks = Array.isArray(toolCall?.content) ? toolCall.content : [];
    const found = blocks.find((b) => b && b.type === 'diff' && b.path);
    return found ? { path: found.path, oldText: clip(found.oldText), newText: clip(found.newText) } : null;
  }
  const clip = (text) => (typeof text === 'string' ? text.slice(0, MAX_TEXT) : null);
  function summarizeContent(content) {
    if (!Array.isArray(content)) return null;
    return clip(content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n')) || null;
  }

  function cancel(taskId) { return jobs.cancel(taskId); }

  return { start, cancel, canStand };
}

/** Real file I/O, injectable so the policy above can be tested without a disk. */
const defaultFiles = {
  read(target, max) {
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw Object.assign(Error('Not a file'), { code: -32602 });
    if (stat.size > max) throw Object.assign(Error('File too large'), { code: -32602 });
    return fs.readFileSync(target, 'utf8');
  },
  write(target, text) {
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  },
};

module.exports = { createCodeHarness, defaultFiles, MAX_TEXT, MAX_FILE_BYTES };

/** The engine's host name, kept off the proxy so a task granted the network can still think. */
function engineHost(engine) {
  try { return new URL(engine().baseUrl).hostname; } catch { return ''; }
}
