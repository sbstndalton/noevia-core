const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createCodeHarness } = require('./code-harness.cjs');
const { createCodeWorkspaces } = require('./code-workspace.cjs');
const { createJobs } = require('./jobs.cjs');
const { ACTIONS } = require('./code-actions.cjs');

const temps = [];
const temp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function repo() {
  const dir = temp('noevia-hrepo-');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'qa@example.invalid'); git('config', 'user.name', 'QA');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a'); git('add', '.'); git('commit', '-qm', 'first');
  return dir;
}

const OPTIONS = [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'ya', kind: 'allow_always' },
  { optionId: 'n', kind: 'reject_once' }, { optionId: 'na', kind: 'reject_always' }];

/**
 * Drive one task with a scripted agent. `script` receives the session handlers and plays the
 * part of the harness; `answers` is what the human says, in order.
 */
async function run({ script, answers = [], capabilities = [], domains = [], egress = null,
  agent = {}, promptResult = { stopReason: 'end_turn' }, sandboxKind = 'spawn', context = '', sent = [], onStarted = null }) {
  const dir = temp('noevia-hjobs-');
  const jobs = createJobs({ dir });
  const workspaces = createCodeWorkspaces({ dir, epoch: 'test' });
  const asked = [];
  const harness = createCodeHarness({
    jobs, workspaces, egress,
    // The deployment's model endpoint. A real one is required to start — see the test below
    // that a server without one refuses rather than running a harness that cannot work.
    engine: () => ({ baseUrl: 'http://engine.test/v1', model: 'synthetic-coder', apiKey: null, contextTokens: 8192 }),
    askApproval: async (request) => { asked.push(request); return answers.shift() ?? 'deny'; },
  });
  let handlers, connected;
  const started = await harness.start({
    repoPath: repo(), prompt: 'fix the bug', capabilities, domains, sandboxKind, context,
    connect: async (args) => {
      const { handlers: h, cwd } = args;
      handlers = h; connected = args;
      return { agent, prompt: async (text) => { sent.push(text); await script(h, cwd, args.signal); return promptResult; } };
    },
  });
  if (onStarted) await onStarted(started, jobs);
  // jobs.run is started without being awaited, so wait for the job to reach a terminal state.
  for (let i = 0; i < 200 && !['completed', 'failed', 'cancelled'].includes(jobs.get(started.taskId)?.status); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return { ...started, dir, jobs, workspaces, job: jobs.get(started.taskId), asked, handlers, connected };
}

const editCall = (file) => ({ toolCall: { kind: 'edit', title: 'Edit ' + file, locations: [{ path: file }], rawInput: { path: file } }, options: OPTIONS });

test('an edit inside the workspace asks, and the card carries the full arguments', async () => {
  let picked;
  const r = await run({
    answers: ['approve'],
    script: async (h, cwd) => { picked = await h.requestPermission(editCall(path.join(cwd, 'a.txt'))); },
  });
  assert.equal(r.job.status, 'completed');
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0].action, ACTIONS.EDIT);
  assert.deepEqual(r.asked[0].arguments, { path: path.join(r.workspace, 'a.txt') }, 'arguments untruncated');
  assert.deepEqual(picked, { outcome: 'selected', optionId: 'y' });
});

test('a permission request naming only its call id is judged by the call the harness announced', async () => {
  // DeepSeek Harness, measured 2026-09-23: `tool_call` carries the command, and the permission
  // request that follows carries nothing but `toolCallId` (an ACP ToolCallUpdate).
  const r = await run({
    answers: ['approve'],
    script: async (h) => {
      h.sessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash', kind: 'other', status: 'pending',
        rawInput: { command: 'rm -rf build', description: 'clean' } });
      await h.requestPermission({ toolCall: { toolCallId: 'c1' }, options: OPTIONS });
    },
  });
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0].action, ACTIONS.DELETE, 'classified from the announced command, not as an empty call');
  assert.equal(r.asked[0].command, 'rm -rf build');
  assert.deepEqual(r.asked[0].arguments, { command: 'rm -rf build', description: 'clean' });
});

test('fields the permission request states win over what was announced, and finished calls are forgotten', async () => {
  const r = await run({
    answers: ['approve', 'approve'],
    script: async (h) => {
      h.sessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'other', rawInput: { command: 'echo hi' } });
      await h.requestPermission({ toolCall: { toolCallId: 'c1', rawInput: { command: 'git push' } }, options: OPTIONS });
      h.sessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' });
      await h.requestPermission({ toolCall: { toolCallId: 'c1' }, options: OPTIONS });
    },
  });
  assert.equal(r.asked[0].command, 'git push');
  assert.equal(r.asked[0].action, ACTIONS.GIT_PUSH);
  // Nothing remembered for a finished call: an empty request is gated as the unknown it is.
  assert.equal(r.asked[1].command, '');
  assert.equal(r.asked[1].arguments, null);
});

test('an announced read, search or think kind never lets a bare permission request through unasked', async () => {
  for (const kind of ['read', 'search', 'think']) {
    for (const stated of [{ toolCallId: 'c1' }, { toolCallId: 'c1', kind: null }]) {
      const r = await run({
        answers: ['deny'],
        script: async (h) => {
          h.sessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c1', kind, rawInput: { command: 'rm -rf /' } });
          await h.requestPermission({ toolCall: stated, options: OPTIONS });
        },
      });
      assert.equal(r.asked.length, 1, `${kind} ${JSON.stringify(stated)} asks`);
      assert.equal(r.asked[0].command, 'rm -rf /', 'and the card still shows what was announced');
    }
  }
});

test('declining means the harness is told no, not told nothing', async () => {
  let picked;
  await run({ answers: ['deny'], script: async (h, cwd) => { picked = await h.requestPermission(editCall(path.join(cwd, 'a.txt'))); } });
  assert.deepEqual(picked, { outcome: 'selected', optionId: 'n' });
});

test('a timeout or an abort is a refusal, never an allow', async () => {
  for (const answer of ['timeout', 'aborted', undefined]) {
    let picked;
    await run({ answers: [answer], script: async (h, cwd) => { picked = await h.requestPermission(editCall(path.join(cwd, 'a.txt'))); } });
    assert.deepEqual(picked, { outcome: 'selected', optionId: 'n' }, String(answer));
  }
});

test('an edit outside the workspace is refused without asking anyone', async () => {
  let picked;
  const r = await run({ script: async (h) => { picked = await h.requestPermission(editCall('/etc/passwd')); } });
  assert.equal(r.asked.length, 0, 'nobody is asked to approve what is not allowed at all');
  assert.deepEqual(picked, { outcome: 'selected', optionId: 'n' });
  const decided = events(r).find((e) => e.type === 'approval.decided');
  assert.equal(decided.data.automatic, true);
  assert.match(decided.data.reason, /outside/i);
});

test('"allow for this task" covers the same class only, and never a delete or a push', async () => {
  const del = (file) => ({ toolCall: { kind: 'delete', title: 'rm', locations: [{ path: file }], rawInput: { path: file } }, options: OPTIONS });
  const push = { toolCall: { kind: 'execute', title: 'push', rawInput: { command: 'git push' } }, options: OPTIONS };
  const r = await run({
    capabilities: [ACTIONS.EDIT, ACTIONS.DELETE, ACTIONS.GIT_PUSH],
    answers: ['approve_all', 'approve_all', 'approve', 'approve_all', 'approve'],
    script: async (h, cwd) => {
      await h.requestPermission(editCall(path.join(cwd, 'a.txt')));   // asks, stands for edits
      await h.requestPermission(editCall(path.join(cwd, 'b.txt')));   // covered, no question
      await h.requestPermission(del(path.join(cwd, 'a.txt')));        // asks
      await h.requestPermission(del(path.join(cwd, 'b.txt')));        // asks again: deletes never stand
      await h.requestPermission(push);                                 // asks
      await h.requestPermission(push);                                 // asks again: pushes never stand
    },
  });
  assert.deepEqual(r.asked.map((a) => a.action),
    [ACTIONS.EDIT, ACTIONS.DELETE, ACTIONS.DELETE, ACTIONS.GIT_PUSH, ACTIONS.GIT_PUSH]);
});

test('a standing allow does not leak into another task', async () => {
  const first = await run({ capabilities: [ACTIONS.EDIT], answers: ['approve_all'],
    script: async (h, cwd) => { await h.requestPermission(editCall(path.join(cwd, 'a.txt'))); } });
  assert.equal(first.asked.length, 1);
  const second = await run({ capabilities: [ACTIONS.EDIT], answers: ['approve'],
    script: async (h, cwd) => { await h.requestPermission(editCall(path.join(cwd, 'a.txt'))); } });
  assert.equal(second.asked.length, 1, 'the next task is asked from scratch');
});

test('reads and thoughts cost nobody an approval', async () => {
  const r = await run({
    script: async (h, cwd) => {
      await h.requestPermission({ toolCall: { kind: 'read', locations: [{ path: path.join(cwd, 'a.txt') }] }, options: OPTIONS });
      await h.requestPermission({ toolCall: { kind: 'search' }, options: OPTIONS });
      h.sessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { text: 'hmm' } });
    },
  });
  assert.equal(r.asked.length, 0);
});

test('a class the task was never granted is refused, even if the human would have said yes', async () => {
  let picked;
  const r = await run({
    capabilities: [ACTIONS.EDIT],
    answers: ['approve'],
    script: async (h) => { picked = await h.requestPermission({ toolCall: { kind: 'execute', rawInput: { command: 'git push' } }, options: OPTIONS }); },
  });
  assert.equal(r.asked.length, 0);
  assert.deepEqual(picked, { outcome: 'selected', optionId: 'n' });
});

test('the write path is checked again at write time, not only at approval time', async () => {
  const r = await run({
    capabilities: [ACTIONS.EDIT], answers: ['approve'],
    script: async (h, cwd) => {
      await h.requestPermission(editCall(path.join(cwd, 'a.txt')));
      assert.equal(await h.writeTextFile({ path: path.join(cwd, 'a.txt'), content: 'ok' }), null);
      assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'ok', 'the write actually happened');
      assert.deepEqual(await h.readTextFile({ path: path.join(cwd, 'a.txt') }), { content: 'ok' });
      // Approval was for a path inside; this write is not.
      await assert.rejects(() => h.writeTextFile({ path: '/tmp/elsewhere.txt', content: 'no' }), /Outside/);
      await assert.rejects(() => h.readTextFile({ path: '/etc/passwd' }), /Outside/);
    },
  });
  assert.equal(r.job.status, 'completed');
  assert.ok(events(r).some((e) => e.type === 'tool.completed' && e.data.name === 'write_file'));
});

test('a read is served from the worktree, and a line window is honoured', async () => {
  await run({
    script: async (h, cwd) => {
      fs.writeFileSync(path.join(cwd, 'many.txt'), 'one\ntwo\nthree\nfour');
      assert.deepEqual(await h.readTextFile({ path: path.join(cwd, 'many.txt'), line: 2, limit: 2 }), { content: 'two\nthree' });
      await assert.rejects(() => h.readTextFile({ path: path.join(cwd, 'missing.txt') }), /ENOENT/);
      await assert.rejects(() => h.readTextFile({ path: cwd }), /Not a file/);
    },
  });
});

test('the workspace is released and the egress grant revoked however the task ends', async () => {
  const revoked = [], granted = [];
  const egress = { grant: ({ taskId, domains }) => { granted.push({ taskId, domains }); return { token: 'secret-token' }; },
    revoke: (taskId) => { revoked.push(taskId); return 1; } };
  const ok = await run({ capabilities: [ACTIONS.NETWORK], domains: ['registry.npmjs.org'], egress, script: async () => {} });
  assert.equal(ok.job.status, 'completed');
  assert.equal(granted.length, 1);
  assert.deepEqual(granted[0].domains, ['registry.npmjs.org']);
  assert.deepEqual(revoked, [ok.taskId]);
  assert.equal(ok.workspaces.get(ok.taskId).status, 'released');
  assert.equal(fs.existsSync(ok.workspace), false);

  const boom = await run({ capabilities: [ACTIONS.NETWORK], domains: ['a.test'], egress,
    script: async () => { throw new Error('the harness died'); } });
  assert.equal(boom.job.status, 'failed');
  assert.match(boom.job.error, /the harness died/);
  assert.equal(boom.workspaces.get(boom.taskId).status, 'released', 'a crash still gives the workspace back');
  assert.ok(revoked.includes(boom.taskId));
});

test('no egress grant without both the capability and named domains', async () => {
  const granted = [];
  const egress = { grant: (g) => { granted.push(g); return { token: 't' }; }, revoke: () => 0 };
  await run({ capabilities: [ACTIONS.NETWORK], domains: [], egress, script: async () => {} });
  await run({ capabilities: [ACTIONS.EDIT], domains: ['a.test'], egress, script: async () => {} });
  assert.deepEqual(granted, [], 'a task gets the network only when it was granted one and told where');
});

test('the job records what happened, and the proxy token never reaches the record', async () => {
  const egress = { grant: () => ({ token: 'super-secret-token' }), revoke: () => 1 };
  const r = await run({
    capabilities: [ACTIONS.EDIT, ACTIONS.NETWORK], domains: ['a.test'], egress, answers: ['approve'],
    script: async (h, cwd) => {
      h.sessionUpdate({ sessionUpdate: 'tool_call', toolCallId: '1', kind: 'edit', title: 'Edit a.txt' });
      await h.requestPermission(editCall(path.join(cwd, 'a.txt')));
      h.sessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'completed', content: [{ text: 'done' }] });
    },
  });
  const types = events(r).map((e) => e.type);
  for (const wanted of ['job.created', 'job.started', 'tool.started', 'approval.requested', 'approval.decided', 'tool.completed', 'job.completed']) {
    assert.ok(types.includes(wanted), `missing ${wanted}`);
  }
  assert.equal(rawLog(r).includes('super-secret-token'), false, 'the egress token is never written to the job log');
  assert.equal(r.job.result.tools, 1);
  assert.equal(r.job.result.allowed, 1);
});

const rawLog = (r) => fs.readFileSync(path.join(r.dir, 'jobs', r.taskId + '.jsonl'), 'utf8');
const events = (r) => rawLog(r).split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('assistant output retains visible chunks across tool rounds without thoughts or tool data', async () => {
  const r = await run({ script: async (h) => {
    h.sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First. ' } });
    h.sessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE_REASONING' } });
    h.sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', text: 'NOT_TEXT' } });
    h.sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 7 } });
    h.sessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'a', kind: 'other', rawInput: { secret: 'TOOL_INPUT' } });
    h.sessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', content: [{ type: 'text', text: 'TOOL_OUTPUT' }] });
    h.sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Second.' } });
    h.sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Settled.' } });
  } });
  assert.equal(r.job.status, 'completed');
  assert.deepEqual(r.job.assistantOutput, { text: 'First. \n\nSecond. Settled.', truncated: false });
  const rows = events(r);
  assert.ok(rows.findIndex((e) => e.type === 'assistant.output') < rows.findIndex((e) => e.type === 'job.completed'));
  assert.equal(JSON.stringify(r.job.assistantOutput).includes('PRIVATE_REASONING'), false);
  assert.equal(JSON.stringify(r.job.assistantOutput).includes('TOOL_OUTPUT'), false);
  assert.ok(rows.some((e) => e.type === 'tool.completed' && e.data.content === 'TOOL_OUTPUT'), 'tool summary remains separately journaled');
});

test('tiny chunks, split emoji and repeated tool rounds stay bounded at 32 KiB and 64 output events', async () => {
  const r = await run({ script: async (h) => {
    h.sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\uD83D' } });
    h.sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\uDE00' } });
    for (let i = 0; i < 30; i++) {
      h.sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } });
      h.sessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hidden' } });
      h.sessionUpdate({ sessionUpdate: 'tool_call', toolCallId: `c${i}`, kind: 'read' });
      h.sessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: `c${i}`, status: 'completed' });
    }
    for (let i = 0; i < 600; i++) h.sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '😀😀😀😀' } });
    h.sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b'.repeat(40000) } });
  } });
  assert.equal(r.job.status, 'completed');
  assert.ok(r.job.assistantOutput.text.startsWith('😀' + 'x'));
  assert.equal(Buffer.byteLength(r.job.assistantOutput.text), 32 * 1024);
  assert.equal(r.job.assistantOutput.truncated, true);
  const outputRows = events(r).filter((e) => e.type === 'assistant.output');
  assert.ok(outputRows.length <= 64, `${outputRows.length} output events`);
  assert.equal(outputRows.filter((e) => e.data.truncated).length, 1);
  assert.ok(events(r).filter((e) => e.type === 'progress').length < 10, 'chunk progress is coalesced');
});

test('pending assistant output flushes before a prompt failure', async () => {
  const r = await run({ script: async (h) => {
    h.sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial explanation' } });
    throw Error('synthetic failure');
  } });
  assert.equal(r.job.status, 'failed');
  assert.equal(r.job.assistantOutput.text, 'Partial explanation');
  const rows = events(r).map((e) => e.type);
  assert.ok(rows.indexOf('assistant.output') < rows.indexOf('job.failed'));
});

test('graceful cancellation flushes pending output before the cancelled event', async () => {
  let streamed = false;
  const r = await run({
    script: async (h, _cwd, signal) => {
      h.sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial before cancel' } });
      streamed = true;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
    onStarted: async (started, jobs) => {
      for (let i = 0; i < 200 && !streamed; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(streamed, true);
      jobs.cancel(started.taskId);
    },
  });
  assert.equal(r.job.status, 'cancelled');
  assert.equal(r.job.assistantOutput.text, 'Partial before cancel');
  const types = events(r).map((e) => e.type);
  assert.ok(types.indexOf('assistant.output') < types.indexOf('job.cancelled'));
});

test('a finished task records what the harness reported, and what it did not', async () => {
  const r = await run({
    script: async (h) => {
      h.sessionUpdate({ sessionUpdate: 'tool_call', toolCallId: '1', kind: 'execute', title: 'npm test' });
      h.sessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'completed', _meta: { exitCode: 0 } });
      h.sessionUpdate({ sessionUpdate: 'tool_call', toolCallId: '2', kind: 'execute', title: 'npm run lint' });
      h.sessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: '2', status: 'failed', _meta: { exitCode: 1 } });
      h.sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'done' } });
    },
    agent: { name: 'opencode', version: '1.18.31', protocolVersion: 1 },
    promptResult: { stopReason: 'end_turn', _meta: { usage: { inputTokens: 1200, outputTokens: 300 } } },
  });
  const meta = r.job.result.meta;
  assert.equal(meta.harness, 'opencode');
  assert.equal(meta.harnessVersion, '1.18.31');
  assert.deepEqual(meta.usage, { input: 1200, output: 300, total: 1500 });
  assert.equal(meta.commands, 2);
  assert.equal(meta.failedCommands, 1);
  assert.deepEqual(meta.exitCodes.map((e) => [e.name, e.exitCode]), [['npm test', 0], ['npm run lint', 1]]);
  assert.deepEqual(meta.limitations, [], 'a harness that reports everything has nothing to disclaim');
  assert.equal(meta.messageChunks, 1, 'streaming chunks are counted as chunks, not as turns');
  assert.match(r.job.result.identityHash, /^[0-9a-f]{64}$/);
});

test('a silent harness produces an honest record rather than zeroes', async () => {
  const r = await run({ script: async () => {} });
  const meta = r.job.result.meta;
  assert.equal(meta.usage, null);
  assert.equal(meta.harnessVersion, null);
  assert.equal(meta.limitations.length, 3);
  // It still gets an identity — one that says the harness version is unknown, so a later run
  // from a named version is correctly NOT treated as the same configuration.
  assert.match(r.job.result.identityHash, /^[0-9a-f]{64}$/);
});

test('the identity separates a sandboxed run from one spawned beside noevia', async () => {
  const a = await run({ script: async () => {}, agent: { name: 'opencode', version: '1.18.31' } });
  const b = await run({ script: async () => {}, agent: { name: 'opencode', version: '1.18.31' }, sandboxKind: 'sandbox' });
  assert.notEqual(a.job.result.identityHash, b.job.result.identityHash);
});

test('a failure before the harness starts still gives back the workspace and the network', async () => {
  // Writing the first checkpoint touches the disk, so it can fail for ordinary reasons: a full
  // volume, a read-only mount. Before the fix that write sat outside the try/finally, and when
  // it threw the egress token stayed valid and the branch stayed claimed for good.
  const dir = temp('noevia-hjobs-');
  const jobs = createJobs({ dir });
  const workspaces = createCodeWorkspaces({ dir, epoch: 'test' });
  const revoked = [];
  const egress = { grant: () => ({ token: 'secret' }), revoke: (id) => { revoked.push(id); return 1; } };
  const brokenJobs = {
    ...jobs,
    run: (id, work) => jobs.run(id, (ctx) => work({
      ...ctx,
      checkpoint: () => { throw new Error('ENOSPC: no space left on device'); },
    })),
  };
  const harness = createCodeHarness({ jobs: brokenJobs, workspaces, egress, engine: () => ({ baseUrl: 'http://engine.test/v1', model: 'synthetic-coder' }), askApproval: async () => 'deny' });
  const started = await harness.start({
    repoPath: repo(), prompt: 'fix', capabilities: [ACTIONS.NETWORK], domains: ['a.test'],
    connect: async () => ({ agent: {}, prompt: async () => ({ stopReason: 'end_turn' }) }),
  });
  for (let i = 0; i < 200 && !['completed', 'failed', 'cancelled'].includes(jobs.get(started.taskId)?.status); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(jobs.get(started.taskId).status, 'failed');
  assert.deepEqual(revoked, [started.taskId], 'the proxy token must not outlive the task');
  assert.equal(workspaces.get(started.taskId).status, 'released');
  // And the branch is claimable again, rather than blocked for good by a task that never ran.
  const held = workspaces.get(started.taskId);
  assert.ok(workspaces.claim({ taskId: '00000000-0000-4000-8000-000000000002', repoPath: held.repo, branch: held.branch }));
});

test('usage is taken from the harness’s own usage_update, where the real one puts it', async () => {
  const r = await run({
    script: async (h) => {
      h.sessionUpdate({ sessionUpdate: 'available_commands_update', commands: ['build'] });
      h.sessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { text: 'hmm' } });
      h.sessionUpdate({ sessionUpdate: 'usage_update', usage: { inputTokens: 4200, outputTokens: 610 } });
      h.sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'done' } });
    },
    agent: { name: 'OpenCode', version: '1.18.31', protocolVersion: 1 },
    // OpenCode leaves the prompt result's _meta empty; the usage came in the stream.
    promptResult: { stopReason: 'end_turn' },
  });
  assert.deepEqual(r.job.result.meta.usage, { input: 4200, output: 610, total: 4810 });
  assert.equal(r.job.result.meta.limitations.some((l) => /token usage/.test(l)), false);
  assert.equal(r.job.result.meta.messageChunks, 1);
});

test('a granted task reaches the proxy by its endpoint and the engine directly', async () => {
  const egress = { endpoint: 'egress:8040', grant: () => ({ token: 'tok' }), revoke: () => 1 };
  const r = await run({ capabilities: [ACTIONS.NETWORK], domains: ['pypi.org'], egress, script: async () => {} });
  assert.equal(r.connected.proxy.url, 'http://task:tok@egress:8040');
  // Through the proxy the engine would be refused as a private address, and the agent could not think.
  assert.equal(r.connected.proxy.noProxy, 'engine.test');
  const offline = await run({ capabilities: [ACTIONS.EDIT], egress, script: async () => {} });
  assert.equal(offline.connected.proxy, null);
});

test('shared project context reaches the agent ahead of the task, never the task label', async () => {
  const sent = [];
  const r = await run({ context: 'Context shared from the "Lab" project', sent, script: async () => {} });
  assert.equal(sent[0], 'Context shared from the "Lab" project\n\nTask:\nfix the bug');
  assert.equal(r.job.checkpoint.task, 'fix the bug');
  const plain = [];
  await run({ sent: plain, script: async () => {} });
  assert.equal(plain[0], 'fix the bug');
});

test("a networked task's result says which hosts it reached and which were refused", async () => {
  const forgotten = [];
  const egress = { grant: () => ({ token: 't' }), revoke: () => 1,
    activity: (taskId, { forget = false } = {}) => { if (forget) forgotten.push(taskId);
      return { hosts: [{ host: 'github.com', allowed: 0, refused: 2, reason: 'host is not on this task’s list' }], allowed: 0, refused: 2 }; } };
  const r = await run({ capabilities: [ACTIONS.NETWORK], domains: ['pypi.org'], egress, script: async () => {} });
  assert.equal(r.job.result.network.refused, 2);
  assert.equal(r.job.result.network.hosts[0].host, 'github.com');
  assert.deepEqual(forgotten, [r.taskId], 'the tally is dropped when the task ends');
  // No grant, no network section.
  const offline = await run({ script: async () => {} });
  assert.equal('network' in offline.job.result, false);
});
