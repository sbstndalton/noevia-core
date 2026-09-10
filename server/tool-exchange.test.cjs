'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createToolExchange } = require('./tool-exchange.cjs');

// Execute the actual complete chat handler in an isolated VM: no server boot,
// credentials, corpus, filesystem writes, or network. Only its collaborators
// are mocked; the streaming loop, permission gate and SSE pairing are real.
const source = fs.readFileSync(require.resolve('./index.cjs'), 'utf8');
const handler = source.slice(source.indexOf('async function handleChat('), source.indexOf('// ── Routing'));

function fixture({ rounds, decision = 'approve', execute, fallback = false, cancel = false, effort } = {}) {
  const events = [], executions = [], approvals = [], requests = [], audits = [];
  let round = 0, allApproved = false;
  const res = new EventEmitter();
  res.writeHead = () => {};
  res.write = (line) => events.push(JSON.parse(line.slice(6)));
  res.end = () => { res.writableEnded = true; };
  function completion(options) {
    requests.push(JSON.parse(options.body));
    return rounds[round++] || [];
  }
  const context = {
    reasoningEffort: require('./reasoning-effort.cjs'),
    AbortController, AbortSignal, TextDecoder, console, createToolExchange,
    crypto: require('node:crypto'), HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default',
    currentWorkspace: () => ({ userId: 'synthetic-user' }),
    requestScope: { getStore: () => ({ workspace: { userId: 'synthetic-user' } }) },
    getProject: (id) => ({ id, model: 'synthetic-model', reasoningEffort: effort }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid', label: 'Mock' }),
    providerHeaders: () => ({}),
    resolveTools: () => ({ tools: ['read', 'write'].map(name => ({ function: { name } })), dropped: [] }),
    isWriteTool: name => name !== 'read',
    chatWideApproved: () => allApproved,
    awaitApproval: async (request) => {
      approvals.push(request);
      if (cancel) res.emit('close');
      if (decision === 'approve_all') { allApproved = true; return 'approve'; }
      return decision;
    },
    authService: { audit: (...args) => audits.push(args) },
    executeToolCall: async (_project, name, args, allowed) => {
      assert.ok(allowed.has(name));
      executions.push({ name, args });
      return execute ? execute(name, args, executions.length) : 'result-' + executions.length;
    },
    fetch: async (url, options) => {
      assert.equal(url, 'http://fixture.invalid/v1/chat/completions');
      if (fallback && JSON.parse(options.body).stream) return { ok: true, body: (async function* () {})() };
      if (fallback) { const calls=completion(options); return {ok:true,status:200,json:async()=>({choices:[{message:{tool_calls:calls.map(tc=>({id:tc.id,function:{name:tc.name,arguments:tc.args}}))}}]})}; }
      const calls = completion(options);
      // Split both argument deltas and SSE transport chunks.
      const deltas = calls.flatMap((tc, index) => [
        { index, id: tc.id, function: { name: tc.name, arguments: tc.args.slice(0, 2) } },
        { index, function: { arguments: tc.args.slice(2) } },
      ]);
      const wire = !calls.length ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Finished.' } }] }) + '\n\n' : deltas.map(tc => 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [tc] } }] }) + '\n\n').join('');
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
  vm.createContext(context);
  vm.runInContext(handler, context);
  return {
    events, executions, approvals, requests, audits,
    async run(projectId = 'synthetic-project') {
      round = 0; res.writableEnded = false;
      await context.handleChat({}, res, { message: 'synthetic fixture', projectId, chatId: 'synthetic-chat' });
      assert.equal(events.some(e => e.type === 'error'), false);
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
    assert.equal(request.max_tokens,8192);
    assert.equal(request.reasoning_effort,undefined);
    assert.equal(request.messages[0].content,'Think through this step by step before answering.');
  }
});
