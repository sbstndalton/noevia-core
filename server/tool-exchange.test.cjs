'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { createToolExchange } = require('./tool-exchange.cjs');

// Execute the actual complete chat handler (chat.cjs) with every collaborator
// injected: no server boot, credentials, corpus, filesystem writes, or network.
// The streaming loop, permission gate and SSE pairing are real.
const { createChatHandler } = require('./chat.cjs');
const contextDir=fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'chat-handler-test-'));
test.after(()=>fs.rmSync(contextDir,{recursive:true,force:true}));

function fixture({ rounds, decision = 'approve', execute, fallback = false, cancel = false, effort, reasoningOnly = false, skills = [], native = false, preambleText = '', routedIds = null, contextLimit = 32768 } = {}) {
  const resolvedFor = [];
  const events = [], executions = [], approvals = [], requests = [], audits = [], toolCounts = [];
  let round = 0, allApproved = false;
  const res = new EventEmitter();
  res.writeHead = () => {};
  res.write = (line) => events.push(JSON.parse(line.slice(6)));
  res.end = () => { res.writableEnded = true; res.emit('finish'); };
  function completion(options) {
    requests.push(JSON.parse(options.body));
    return rounds[round++] || [];
  }
  const context = {
    modelManager:{enabled:true,health:async()=>({ok:true,body:{all_models_loaded:[{model_name:'synthetic-model',loaded:true,recipe_options:{ctx_size:contextLimit}}]}})},
    reasoningEffort: require('./reasoning-effort.cjs'), createToolExchange,
    crypto: require('node:crypto'), HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default',
    // The handler compacts a tool result before the model sees it; this
    // fixture is the handler's dependency manifest, so both names live here.
    reduceToolResult: require('./tool-result-reduce.cjs').reduceToolResult, TOOL_RESULT_CAP: 8000,
    currentWorkspace: () => ({ userId: 'synthetic-user',dir:contextDir }),
    requestScope: { getStore: () => ({ workspace: { userId: 'synthetic-user' } }) },
    getProject: (id) => ({ id, model: 'synthetic-model', reasoningEffort: effort }),
    skillsIndexFor: () => skills, getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid', label: 'Mock' }),
    providerHeaders: () => ({}),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false }, chatToolRouter: { select: async (ids) => (routedIds ? { ids: routedIds, routed: true } : { ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'],
    CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [], toolPolicy: { mode: (_user, _name, write) => (write ? 'ask' : 'allow') },
    resolveTools: (project) => { resolvedFor.push(project.toolboxes); return { tools: ['read', 'write'].map(name => ({ function: { name } })), dropped: [] }; },
    isWriteTool: name => name !== 'read',
    chatWideApproved: () => allApproved,
    awaitApproval: async (request) => {
      approvals.push(request);
      if (cancel) res.emit('close');
      if (decision === 'approve_all') { allApproved = true; return 'approve'; }
      return decision;
    },
    authService: { audit: (...args) => audits.push(args) },
    recordToolUse: (_workspace, name) => toolCounts.push(name),
    executeToolCall: async (_project, name, args, allowed) => {
      assert.ok(allowed.has(name));
      executions.push({ name, args });
      return execute ? execute(name, args, executions.length) : 'result-' + executions.length;
    },
    fetch: async (url, options) => {
      assert.equal(url, 'http://fixture.invalid/v1/chat/completions');
      const requestBody=JSON.parse(options.body);
      if(requestBody.stream===false && requestBody.messages?.some(message=>String(message.content||'').includes('Summarize conversation history'))) {
        requests.push(requestBody);
        return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'Earlier synthetic constraints and decisions.'}}]})};
      }
      if (fallback && JSON.parse(options.body).stream) return { ok: true, body: (async function* () {})() };
      if (fallback) { const calls=completion(options); return {ok:true,status:200,json:async()=>({choices:[{message:{...(reasoningOnly && !calls.length ? {reasoning_content:'Synthetic internal plan: maybe search, then consider alternatives.'} : {}),tool_calls:calls.map(tc=>({id:tc.id,function:{name:tc.name,arguments:tc.args}}))}}]})}; }
      const calls = completion(options);
      // Split both argument deltas and SSE transport chunks.
      const deltas = calls.flatMap((tc, index) => [
        { index, id: tc.id, function: { name: tc.name, arguments: tc.args.slice(0, 2) } },
        { index, function: { arguments: tc.args.slice(2) } },
      ]);
      const wire = !calls.length ? 'data: ' + JSON.stringify({ choices: [{ delta: { ...(reasoningOnly ? {reasoning_content:'Synthetic internal plan: maybe search, then consider alternatives.'} : {content:'Finished.'}) } }] }) + '\n\n' : (preambleText ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: preambleText } }] }) + '\n\n' : '') + deltas.map(tc => 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [tc] } }] }) + '\n\n').join('');
      return { ok: true, body: (async function* () {
        yield Buffer.from(wire.slice(0, 17)); yield Buffer.from(wire.slice(17));
      })() };
    },
    fetchJson: async (url, options) => {
      assert.ok(fallback, 'unexpected fallback');
      return { ok: true, body: { choices: [{ message: { tool_calls: completion(options).map(tc => ({
        id: tc.id, function: { name: tc.name, arguments: tc.args },
      })) } }] } };
    },
  };
  if(native){
    let loaded=false;
    context.modelManager=require('./model-manager.cjs').createModelManager({kind:'llamacpp',baseUrl:'http://fixture.invalid',fetchJson:async url=>{
      if(url.endsWith('/models/load'))loaded=true;
      return {ok:true,status:200,body:url.includes('/props?')?{default_generation_settings:{n_ctx:32768},total_slots:1,build_info:'synthetic-native'}:{data:[{id:'synthetic-model',status:{value:loaded?'loaded':'unloaded'}}]}};
    }});
  }
  const { handleChat } = createChatHandler({
    fs, path: require('node:path'), rag: { filesContext: async () => null }, prefill: { recordSample() {} }, diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    autoRoles: () => null, lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    visionProbe: async () => ({ supported: false, reason: 'none' }), visionDescriptions: new Map(), allToolboxes: () => [], recordUsage() {},
    ...context,
  });
  return {
    events, executions, approvals, requests, audits, toolCounts, resolvedFor,
    async run(projectId = 'synthetic-project', body = {}) {
      round = 0; res.writableEnded = false;
      await handleChat({}, res, { message: 'synthetic fixture', projectId, chatId: 'synthetic-chat', ...body });
      assert.equal(events.some(e => e.type === 'error'), false, JSON.stringify(events.filter(e=>e.type==='error')));
    },
  };
}
const call = (id, name = 'write', args = '{"a":1,"nested":{"x":2,"y":3}}') => ({ id, name, args });
const equivalent = '{"nested": {"y":3,"x":2}, "a":1}';

for (const fallback of [false, true]) {
  test(`duplicates within/across rounds retain IDs and SSE pairing (fallback=${fallback})`, async () => {
    const f = fixture({ fallback, rounds: [
      [call('a'), call('b', 'write', equivalent)], [call('c')], [call('d')],
    ] });
    await f.run();
    assert.equal(f.executions.length, 1);
    assert.equal(f.approvals.length, 1);
    assert.deepEqual(f.events.filter(e => e.type === 'tool_result').map(e => [e.index, e.text]),
      [[0, 'result-1'], [1, 'result-1'], [2, 'result-1'], [3, 'result-1']]);
    assert.deepEqual(f.requests[2].messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['a', 'b', 'c']);
    assert.equal(f.audits.filter(a => a[0] === 'tool.write').length, 1);
    // Usage counts calls that actually ran: a deduplicated repeat is not a
    // second call, so the count matches executions rather than chips.
    assert.deepEqual(f.toolCounts, ['write']);
    await f.run();
    await f.run('another-project');
    assert.equal(f.executions.length, 3, 'later exchanges execute again');
  });
}

test('different names, values and array order remain distinct', async () => {
  const f = fixture({ rounds: [[call('a', 'read', '{"v":[1,2]}'), call('b', 'read', '{"v":[2,1]}'),
    call('c', 'write', '{"v":[1,2]}'), call('d', 'write', '{"v":[1,3]}')]], fallback: true });
  await f.run();
  assert.equal(f.executions.length, 4);
  assert.equal(f.approvals.length, 2, 'Allow once does not grant different writes');
});

for (const decision of ['deny', 'timeout']) {
  test(`${decision} is reused without another approval or execution`, async () => {
    const f = fixture({ decision, rounds: [[call('a')], [call('b', 'write', equivalent)], [call('c')]] });
    await f.run();
    assert.equal(f.approvals.length, 1);
    assert.equal(f.executions.length, 0);
    const results = f.events.filter(e => e.type === 'tool_result');
    assert.equal(results.length, 3);
    assert.ok(results.every(e => e.text === results[0].text && e.text.startsWith('ERROR')));
  });
}

test('Allow for this chat still permits distinct writes; duplicates never execute again', async () => {
  const f = fixture({ decision: 'approve_all', rounds: [[call('a'), call('b'), call('c', 'write', '{"a":2}')]] });
  await f.run();
  assert.equal(f.approvals.length, 1);
  assert.equal(f.executions.length, 2);
});

for (const throws of [false, true]) {
  test(`failed writes are not retried (throws=${throws}) and reads refresh after the attempt`, async () => {
    let reads = 0;
    const f = fixture({ rounds: [
      [call('r1', 'read'), call('r2', 'read'), call('w1')],
      [call('r3', 'read'), call('w2'), call('r4', 'read')],
    ], execute: (name) => {
      if (name === 'read') return 'snapshot-' + ++reads;
      if (throws) throw new Error('uncertain write outcome');
      return 'ERROR: uncertain write outcome';
    } });
    await f.run();
    assert.equal(f.executions.length, 3);
    assert.equal(reads, 2);
    assert.equal(f.approvals.length, 1);
    assert.deepEqual(f.events.filter(e => e.type === 'tool_result' && e.name === 'read').map(e => e.text),
      ['snapshot-1', 'snapshot-1', 'snapshot-2', 'snapshot-2']);
  });
}

test('successful writes invalidate reads; denials do not', async () => {
  for (const decision of ['approve', 'deny']) {
    const f = fixture({ decision, rounds: [[call('r1', 'read'), call('w'), call('r2', 'read')]] });
    await f.run();
    assert.equal(f.executions.filter(c => c.name === 'read').length, decision === 'approve' ? 2 : 1);
  }
});

test('invalid JSON, non-object arguments and disabled tools never reach approval or execution', async () => {
  const f = fixture({ rounds: [[...['{bad', 'null', '[]', '1', '"text"'].flatMap((args, i) =>
    [call('bad' + i, 'write', args), call('repeat' + i, 'write', args)]), call('disabled', 'unknown')]] });
  await f.run();
  assert.equal(f.executions.length, 0);
  assert.equal(f.approvals.length, 0);
  assert.equal(f.events.filter(e => e.type === 'tool_result').length, 11);
  assert.ok(f.events.filter(e => e.type === 'tool_result').every(e => e.text.startsWith('ERROR')));
});

test('disconnect during approval stops execution and subsequent calls', async () => {
  const f = fixture({ cancel: true, rounds: [[call('a'), call('b', 'write', '{"a":2}')]] });
  await f.run();
  assert.equal(f.executions.length, 0);
  assert.equal(f.approvals.length, 1);
  assert.equal(f.events.some(e => e.type === 'done'), false);
});

test('independent exchange instances cannot reuse another user result', async () => {
  const opts = { allowed: new Set(['read']), isWrite: () => false, signal: new AbortController().signal };
  const a = createToolExchange(opts), b = createToolExchange(opts);
  assert.equal(await a(call('a', 'read'), async () => 'user A private fixture'), 'user A private fixture');
  assert.equal(await b(call('b', 'read'), async () => 'user B private fixture'), 'user B private fixture');
});

test('empty arguments equal an empty object; special keys are retained in the signature', async () => {
  const run = createToolExchange({ allowed: new Set(['read']), isWrite: () => false, signal: new AbortController().signal });
  let count = 0;
  const execute = async () => String(++count);
  for (const args of ['', '{}', '{"__proto__":1}', '{"__proto__":2}', '{"v":[{"b":2,"a":1}]}', '{"v":[{"a":1,"b":2}]}']) {
    await run(call('id', 'read', args), execute);
  }
  assert.equal(count, 4);
});

test('failed reads reuse their error until an attempted write allows a fresh read', async () => {
  const f = fixture({ rounds: [[call('a', 'read'), call('b', 'read'), call('w')], [call('c', 'read')]],
    execute: name => name === 'read' ? 'ERROR: temporarily unavailable' : 'written' });
  await f.run();
  assert.equal(f.executions.filter(c => c.name === 'read').length, 2);
});

for (const fallback of [false,true]) test(`high hints reach every real handler tool round and fallback body (${fallback})`, async()=>{
  const result=fixture({effort:'high',fallback,rounds:[[{id:'r1',name:'read',args:'{}'}],[]]});
  await result.run();
  assert.ok(result.requests.length >= 2);
  for(const request of result.requests){
    assert.equal(request.max_tokens,4096);
    assert.equal(request.reasoning_effort,undefined);
    assert.equal(request.messages[0].content,'Think through this step by step before answering.');
  }
});

for(const fallback of [false,true])test(`reasoning-only output stays separate from the final answer (${fallback})`,async()=>{
 const f=fixture({fallback,reasoningOnly:true,rounds:[[],[]]});await f.run();
 assert.ok(f.events.some(e=>e.type==='reasoning' && e.text.includes('Synthetic internal plan')));
 const final=f.events.filter(e=>e.type==='delta').map(e=>e.text).join('');
 assert.ok(final.includes('without a final answer'));
 assert.ok(!final.includes('Synthetic internal plan'));
});
test('reasoning-only tool continuation preserves completed tool results without promoting narration',async()=>{
 const f=fixture({reasoningOnly:true,rounds:[[call('read1','read','{}')],[]]});await f.run();
 assert.equal(f.executions.length,1);assert.ok(f.events.some(e=>e.type==='tool_result'));
 assert.ok(f.events.some(e=>e.type==='delta'&&e.text.includes('without a final answer')));
 assert.ok(!f.events.some(e=>e.type==='delta'&&e.text.includes('Synthetic internal plan')));
});


test('actual chat request indexes the exact skill filename even when its display name differs',async()=>{
 const f=fixture({skills:[{file:'weekly-review.md',name:'Project summary',description:'Review notes',version:'2'}],rounds:[[]]});await f.run();
 const prompt=f.requests[0].messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
 assert.ok(prompt.includes('"file":"weekly-review.md"'));
 assert.ok(prompt.includes('"name":"Project summary"'));
 assert.ok(prompt.includes('read_project_file'));
 assert.equal(f.executions.length,0);
});

for(const decision of ['approve','deny','approve_all'])test(`native manager preserves write approval action ${decision}`,async()=>{
 const f=fixture({native:true,decision,rounds:[[call('native-a'),call('native-b','write','{"a":2}')]]});
 await f.run();assert.equal(f.executions.length,decision==='deny'?0:2);assert.equal(f.approvals.length,decision==='approve_all'?1:2);assert.equal(f.events.find(e=>e.type==='context').limit,32768);
});

test('text streamed before a tool call is marked as preamble, the final answer is not', async () => {
  const f = fixture({ rounds: [[call('p1', 'read', '{}')], []], preambleText: 'Let me look that up.' });
  await f.run();
  const pre = f.events.filter(e => e.type === 'preamble');
  assert.equal(pre.length, 1);
  assert.equal(pre[0].text, 'Let me look that up.');
  const idx = f.events.findIndex(e => e.type === 'preamble');
  assert.ok(f.events.slice(idx).some(e => e.type === 'delta' && e.text !== 'Let me look that up.'));
});

test('routed toolboxes replace the project selection for this exchange only when the router routed', async () => {
  const routed = fixture({ rounds: [[]], routedIds: ['offline-wikipedia'] });
  await routed.run();
  assert.deepEqual(routed.resolvedFor, [['offline-wikipedia']]);
  const plain = fixture({ rounds: [[]] });
  await plain.run();
  // Unrouted: the project's own selection (here the default, core) plus any connected connectors.
  assert.equal(JSON.stringify(plain.resolvedFor), '[["core"]]');
});

test('account-wide custom instructions reach the system message; removing them removes them', async () => {
  const file = require('node:path').join(contextDir, 'account-instructions.json');
  fs.writeFileSync(file, JSON.stringify({ text: 'Answer in British English.', updatedAt: 1 }));
  try {
    const f = fixture({ rounds: [[]] });
    await f.run();
    const system = f.requests[0].messages.find((m) => m.role === 'system');
    assert.match(system.content, /custom instructions for all chats[\s\S]*Answer in British English\./);
  } finally { fs.rmSync(file, { force: true }); }
  const plain = fixture({ rounds: [[]] });
  await plain.run();
  assert.doesNotMatch(JSON.stringify(plain.requests[0].messages), /British English/);
});

test('an oversized tool result is compacted for the model, and the chip still shows the real output', async () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({
    id: i, name: `note-${i}.md`, path: `/Notes/note-${i}.md`, mime: 'text/markdown', comment: '',
  }));
  const raw = JSON.stringify(rows);
  const f = fixture({ rounds: [[{ id: 'c1', name: 'read', args: '{}' }], []], execute: () => raw });
  await f.run();

  const toolMsg = f.requests[1].messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'the second round carries the tool result');
  assert.ok(toolMsg.content.length < raw.length, 'the model sees less than the raw result');
  assert.match(toolMsg.content, /records, tab-separated/, 'and is told how to read it');
  assert.match(toolMsg.content, /omitted because they were empty/, 'and what was dropped');
  assert.match(toolMsg.content, /^id\tname\tpath\tmime$/m, 'keys are hoisted to one header row');

  // The chip is the user's view and comes from the real result, not the
  // model's copy — a reduction must never change what the user is shown.
  const chip = f.events.find((e) => e.type === 'tool_result');
  assert.equal(chip.text, raw.slice(0, 300));
});

test('a small tool result reaches the model byte-identical', async () => {
  const f = fixture({ rounds: [[{ id: 'c1', name: 'read', args: '{}' }], []], execute: () => 'result-plain' });
  await f.run();
  assert.equal(f.requests[1].messages.find((m) => m.role === 'tool').content, 'result-plain');
});

test('the real handler compacts again before an oversized tool continuation', async () => {
  const raw='tool-result '.repeat(650);
  const f=fixture({contextLimit:8000,rounds:[[{id:'c1',name:'read',args:'{}'}],[]],execute:()=>raw});
  const history=[{role:'user',content:'Earlier request '+ 'a'.repeat(3600)},{role:'assistant',content:'Earlier answer '+ 'b'.repeat(3600)}];
  await f.run('synthetic-project',{history});
  const summaryRequest=f.requests.find(request=>request.stream===false&&request.messages?.some(message=>String(message.content||'').includes('Summarize conversation history')));
  assert.ok(summaryRequest,'a continuation summary was requested');
  const continuation=f.requests.find(request=>request.stream===true&&request.messages?.some(message=>message.role==='tool'));
  assert.ok(continuation,'the tool continuation was sent after compaction');
  assert.match(continuation.messages.find(message=>message.content?.startsWith('Earlier conversation and completed-step summary'))?.content||'',/Earlier synthetic constraints/);
  assert.deepEqual(continuation.messages.slice(-3).map(message=>message.role),['user','assistant','tool']);
  assert.ok(f.events.some(event=>event.type==='status'&&/Compacting context before the next tool step/.test(event.text)));
});
