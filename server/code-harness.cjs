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
const { classify, decide, pickOption, ACTIONS } = require('./code-actions.cjs');

const MAX_TEXT = 4000; // what a job event keeps of a chunk, as chat keeps of a tool result

/**
 * @param {{jobs: object, workspaces: object, egress?: object, now?: () => number,
 *          askApproval: (request: object) => Promise<'approve'|'approve_all'|'deny'|'timeout'|'aborted'>,
 *          log?: (entry: object) => void}} deps
 */
function createCodeHarness({ jobs, workspaces, egress = null, askApproval, now = Date.now, log = () => {} }) {
  /**
   * Start a task. `capabilities` is fixed here and never widens (§4): the job records it, and
   * every later decision is taken against this list, not against anything the agent claims.
   */
  async function start({ projectId = null, repoPath, prompt, capabilities = [], domains = [],
    harness = 'opencode', connect, model = null }) {
    if (!prompt || !String(prompt).trim()) throw Object.assign(Error('A task needs a prompt'), { status: 400 });
    if (typeof connect !== 'function') throw Object.assign(Error('No harness transport'), { status: 500 });
    const taskId = jobs.create({ kind: 'code', projectId, capabilities: [...new Set(capabilities)] });

    let workspace;
    try { workspace = workspaces.claim({ taskId, repoPath, capabilities, domains }); }
    catch (error) { jobs.append(taskId, 'job.failed', { error: String(error.message).slice(0, 500) }); throw error; }

    // Network is a capability like any other: no grant unless the task has it AND named domains.
    const wantsNetwork = capabilities.includes(ACTIONS.NETWORK) || capabilities.includes(ACTIONS.INSTALL);
    const grant = egress && wantsNetwork && domains.length ? egress.grant({ taskId, domains }) : null;

    jobs.run(taskId, async (ctx) => {
      const session = createSession({ taskId, ctx, workspace, domains, capabilities, harness, model });
      try {
        const agent = await connect({
          taskId, harness, model, cwd: workspace.path,
          // The adapter pins the agent's own permission config: the spike showed OpenCode's
          // defaults writing silently, and noevia refuses to run a harness whose effective
          // config it cannot pin.
          permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
          proxy: grant ? { url: `http://task:${grant.token}@egress`, domains: [...domains] } : null,
          handlers: session.handlers,
          signal: ctx.signal,
        });
        ctx.progress('running');
        const outcome = await agent.prompt(String(prompt));
        return { stopReason: outcome?.stopReason || 'end_turn', branch: workspace.branch, ...session.summary() };
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

    /** noevia's file API for the agent: inside the worktree or not at all. */
    const readTextFile = async ({ path: target } = {}) => {
      if (workspaces.contains(taskId, target) !== true) throw Object.assign(Error('Outside this task’s workspace'), { code: -32602 });
      return { path: target };
    };
    const writeTextFile = async ({ path: target, content } = {}) => {
      // Checked again here, not only at approval time: the path approved and the path written
      // are two different facts, and only this one is the write.
      if (workspaces.contains(taskId, target) !== true) throw Object.assign(Error('Outside this task’s workspace'), { code: -32602 });
      ctx.event('tool.completed', { name: 'write_file', path: target, bytes: String(content ?? '').length });
      return { path: target };
    };

    function sessionUpdate(update = {}) {
      const kind = update.sessionUpdate || update.type;
      if (kind === 'tool_call') {
        counts.tools++;
        const classified = classify(update);
        ctx.event('tool.started', { id: update.toolCallId, name: update.title || update.kind || 'tool',
          action: classified.action, kind: update.kind || null });
      } else if (kind === 'tool_call_update') {
        const done = update.status === 'completed' || update.status === 'failed';
        if (done) ctx.event(update.status === 'failed' ? 'tool.completed' : 'tool.completed',
          { id: update.toolCallId, failed: update.status === 'failed', content: summarize(update.content) });
      } else if (kind === 'plan') {
        ctx.event('plan.proposed', { question: null, subQuestions: (update.entries || []).map((e) => String(e.content || '').slice(0, 200)) });
      } else if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
        // Thoughts are progress, not stored reasoning: the spec keeps hidden reasoning out.
        ctx.event('progress', { stage: kind === 'agent_thought_chunk' ? 'thinking' : 'writing' });
      }
    }

    return {
      handlers: { requestPermission, readTextFile, writeTextFile, sessionUpdate },
      summary: () => ({ ...counts, workspace: workspace.path }),
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
  function summarize(content) {
    if (!Array.isArray(content)) return null;
    return clip(content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n')) || null;
  }

  function cancel(taskId) { return jobs.cancel(taskId); }

  return { start, cancel, canStand };
}

module.exports = { createCodeHarness, MAX_TEXT };
