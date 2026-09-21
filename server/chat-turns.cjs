'use strict';
// Internal opt-in seam only: no route, scheduler, environment flag or production wiring.
// Canonical turn snapshots use the existing tenant jobs journal; projections are disposable.
const { createJobs } = require('./jobs.cjs');
const crypto = require('node:crypto');
const clone = (value) => JSON.parse(JSON.stringify(value));
function createChatTurns({ enabled = false } = {}) {
  const store = (workspace) => {
    if (!enabled) throw Error('Durable chat is disabled');
    if (!workspace?.userId || !workspace?.dir) throw Error('Tenant workspace required');
    return createJobs({ dir: workspace.dir, kinds: ['chat'], durable: true });
  };
  function bind(workspace, id) {
    const jobs = store(workspace), job = jobs.get(id);
    if (!job || job.kind !== 'chat' || job.checkpoint?.identity.userId !== workspace.userId) throw Error('No such chat turn');
    let state = clone(job.checkpoint);
    let expected = JSON.stringify(state);
    let broken = false;
    const save = () => { if (broken) throw Error('Checkpoint write failed; review required'); try { if (JSON.stringify(jobs.get(id)?.checkpoint) !== expected) throw Error('Turn changed; review required'); const event = jobs.append(id, 'checkpoint.created', state); expected = JSON.stringify(state); return event; } catch (e) { broken = true; throw e; } };
    const call = (callId) => { const c = state.calls.find(x => x.id === callId); if (!c) throw Error('Unknown tool call'); return c; };
    return {
      id,
      snapshot: () => clone(state),
      generation(projection, round) { state.phase = 'generating'; state.round = round; state.projection = clone(projection); save(); },
      retry() { if (state.retries.remaining <= 0) throw Error('Retry budget exhausted'); state.retries.remaining--; save(); },
      partial(content) { if (content) { state.outputs.push({round:state.round,content,partial:true}); save(); } },
      replacement(model) { state.models.push(clone(model)); save(); },
      fallbackRetry() { if (state.retries.fallbackRemaining <= 0) throw Error('Fallback budget exhausted'); state.retries.fallbackRemaining--; save(); },
      output(content, calls = []) {
        if (calls.some(c => !c.id || state.calls.some(old => old.id === c.id)) || new Set(calls.map(c => c.id)).size !== calls.length) throw Error('Duplicate tool call id');
        if (content) state.outputs.push({ round: state.round, content });
        state.messages.push({ role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls.map(c => ({ id:c.id, type:'function', function:{name:c.name,arguments:c.args} })) } : {}) });
        state.calls.push(...calls.map(c => ({ ...clone(c), status: 'not_started', approval: null })));
        state.phase = calls.length ? 'tools' : 'completed'; save();
      },
      approval(callId, approval) { const c = call(callId); c.approval = { ...c.approval, ...clone(approval) }; save(); },
      started(callId) { const c = call(callId); if (c.status !== 'not_started') throw Error('Tool already started; review required'); c.status = 'started'; save(); },
      uncertain(callId) { call(callId).status = 'outcome_unknown'; save(); },
      result(callId, result) { const c = call(callId); if (c.status === 'started' && /^ERROR/i.test(result)) c.status = 'outcome_unknown'; if (c.status === 'outcome_unknown') { c.error = result; save(); return; } if (!['not_started','started'].includes(c.status)) throw Error('Tool already resolved'); c.status = 'completed'; c.result = result; state.messages.push({role:'tool',tool_call_id:callId,content:result}); save(); },
      interrupt(reason) { state.interruptedPhase = state.phase; state.phase = 'interrupted'; state.failure = String(reason); save(); },
      complete() { if (state.calls.some(c => c.status !== 'completed')) throw Error('Unresolved tools require review'); state.phase = 'completed'; save(); jobs.append(id, 'job.completed'); },
    };
  }
  function start(workspace, { projectId = null, conversationId, messages, model, retries = 1 }) {
    if (!conversationId || !Number.isInteger(retries) || retries < 0) throw Error('Conversation and retry budget required');
    const jobs = store(workspace), id = jobs.create({ kind:'chat', projectId });
    jobs.append(id, 'checkpoint.created', { v:1, identity:{userId:workspace.userId,projectId,conversationId,turnId:crypto.randomUUID()},
      phase:'ready', round:0, model:clone(model), models:[clone(model)], retries:{remaining:retries,fallbackRemaining:3}, messages:clone(messages), outputs:[], calls:[], projection:null });
    jobs.append(id, 'job.started');
    return bind(workspace, id);
  }
  function restore(workspace, id) {
    const turn = bind(workspace,id), state = turn.snapshot();
    const unresolved = state.calls.filter(c => c.status !== 'completed');
    let next = state.phase === 'completed' ? 'completed' : 'generate';
    if (unresolved.some(c => ['started','outcome_unknown'].includes(c.status))) next = 'review';
    else if (unresolved.length) next = 'approval'; // Even approve_all is historical, never a restored grant.
    else if ((state.retries.remaining <= 0 || (state.round >= 2 && (state.phase === 'tools' || state.interruptedPhase === 'tools'))) && next !== 'completed') next = 'budget_exhausted';
    return { state, next, unresolved: unresolved.map(c => ({...c,status:['started','outcome_unknown'].includes(c.status) ? 'outcome_unknown' : c.status, reask:true})) };
  }
  // Explicitly invoked test/internal continuation, generation only. No tool executor is accepted.
  async function resumeGeneration(workspace, id, { provider, model, project }) {
    const restored = restore(workspace,id);
    if (restored.next !== 'generate') throw Error(`Continuation requires ${restored.next}`);
    const turn = bind(workspace,id);
    turn.retry(); // Persist the attempt before any external request, including projection failure.
    try {
      const projection = await project(clone(restored.state));
      if (!Array.isArray(projection)) throw Error('Invalid projection');
      let pending = [];
      for (const message of projection) {
        if (message.role === 'tool') {
          if (pending.shift() !== message.tool_call_id) throw Error('Invalid tool group');
        } else {
          if (pending.length) throw Error('Incomplete tool group');
          pending = (message.tool_calls || []).map(c => c.id);
        }
      }
      if (pending.length) throw Error('Incomplete tool group');
      const meter = require('./chat-context.cjs').measure(projection, [], model.limit || restored.state.model.limit || 8192, 'Restored configuration', model.id);
      if (meter.used > meter.threshold) throw Error('Replacement context does not fit');
      turn.replacement(model);
      turn.generation(projection,restored.state.round);
      const result = await provider({model:clone(model),messages:projection});
      if (typeof result?.content !== 'string' || result.tool_calls?.length) throw Error('Replacement must return text only in this slice');
      turn.output(result.content);
      turn.complete();
      return turn.snapshot();
    } catch (error) { turn.interrupt(error.message); throw error; }
  }
  return { enabled, start, restore, resumeGeneration };
}
module.exports = { createChatTurns };
