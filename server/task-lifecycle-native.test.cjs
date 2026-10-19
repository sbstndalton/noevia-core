'use strict';
// Full host error surfaces against checksum-bound independent JS, not candidate-generated answers.
const test = require('node:test'), assert = require('node:assert/strict');
const lc = require('./task-lifecycle.cjs');
const old = require('../tests/reference/task-lifecycle-oracle.cjs');
const wasm = require('./dav-parse-wasm.cjs');
function capture(fn) {
  try { return { value: fn() }; }
  catch (error) {
    return { error: { name: error.name, message: error.message, code: error.code,
      status: error.status, from: error.from, to: error.to } };
  }
}
function same(method, args, label) {
  assert.deepStrictEqual(capture(() => lc[method](...args)), capture(() => old[method](...args)), label);
}
function quiet(fn) {
  const warn = console.warn; console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
}
test('production has no JS policy exports; metadata is the Rust read model in original order', () => {
  for (const name of ['canTransitionJs', 'transitionJs', 'assertStageMoveJs', 'foldEventsJs', 'deriveLifecycleJs']) {
    assert.equal(Object.hasOwn(lc, name), false, name);
  }
  assert.deepStrictEqual(lc.STATES, old.STATES);
  assert.deepStrictEqual(Object.keys(lc.TRANSITIONS), Object.keys(old.TRANSITIONS));
  assert.deepStrictEqual(lc.TRANSITIONS, old.TRANSITIONS);
  assert.deepStrictEqual([...lc.AUTHORITY_TYPES], [...old.AUTHORITY_TYPES]);
});
test('pair policy preserves exact raw error values, messages and refusal precedence', () => {
  const cyclic = {}; cyclic.self = cyclic;
  const values = [...old.STATES, undefined, null, true, 1, 1n, NaN, Infinity, Symbol('synthetic'),
    {}, [], ['planned'], new String('planned'), { toJSON: () => 'planned' }, cyclic, () => {}];
  quiet(() => {
    for (const from of values) for (const to of values) {
      for (const method of ['canTransition', 'transition', 'assertStageMove']) same(method, [from, to], method + ' raw pair');
    }
    const options = { wasmLoader: () => { throw new TypeError('synthetic loader failure'); } };
    for (const args of [['planned', 'merged'], ['bad', 'planned'], ['planned', 'bad'], ['reviewing', 'merged']]) {
      for (const method of ['canTransition', 'transition', 'assertStageMove']) same(method, [...args, options], method + ' loader');
    }
  });
});
test('single steps preserve no-op raw references and all policy errors without JS decisions', () => {
  const state = {}; state.toJSON = () => 'planned';
  const values = [...old.STATES, undefined, null, true, 1, 1n, NaN, {}, state];
  const hash = 'a'.repeat(64);
  for (const from of values) {
    const events = [null, 1, {}, { type: 1 }, { type: 'ignored' }, { type: 'task.revision' },
      ...['job.started','job.completed','job.failed','job.cancelled','job.interrupted'].map(type => ({type})),
      ...['implementing','verifying','reviewing',undefined,1n,{},'x'.repeat(100)].map(stage => ({type:'progress',data:{stage}})),
      ...[...old.STATES,undefined,{},state].flatMap(to => [
        {type:'task.stage',data:{from,to,reportHash:hash}},
        {type:'task.stage',data:{from:'bad',to,reportHash:hash}},
        {type:'task.stage',data:{from,to,reportHash:[hash]}},
      ])];
    for (const event of events) for (const authoritative of [false,true]) same('step',[from,event,{authoritative}],'raw single step');
  }
  same('step',[state,{type:'unknown'.repeat(1_400_000)}], 'unknown event type is an unbounded no-op');
});
test('fold diagnostics preserve all exact metadata and initial labels', () => {
  const stage = (from,to,reportHash) => ({type:'task.stage',data:{from,to,reportHash}});
  const journals = [
    [{type:'job.completed'}],
    [{type:'job.started'},{type:'job.failed'},{type:'job.completed'}],
    [stage('planned','implementing'),stage('planned','verifying')],
    [stage('planned','implementing'),stage('implementing','reviewing')],
    [stage('planned','merged')],
    [stage('planned','implementing'),stage('implementing',{})],
  ];
  for (const events of journals) {
    same('deriveLifecycle',[events],'derive error');
    same('safeDeriveLifecycle',[events],'safe derive error');
    for (const authoritative of [false,true]) same('foldEvents',[events,'planned',{authoritative}],'fold error');
  }
  for (const from of [null,{},1n,'unknown',Symbol('synthetic')]) same('foldEvents',[[] ,from],'fromState label');
  for (const events of [1,{},'string',new Set()]) {
    same('deriveLifecycle',[events],'non-array derive');
    same('safeDeriveLifecycle',[events],'safe never catches unrelated TypeError');
    same('foldEvents',[events],'non-array fold');
  }
});
test('first policy failure precedes later cyclic, BigInt and over-cap fields; successful policies retain refusals', () => {
  const cyclic={};cyclic.self=cyclic;
  const huge='x'.repeat(wasm.MAX_TASK_LIFECYCLE_BYTES+1);
  quiet(() => {
    for (const stage of [cyclic,1n,huge]) {
      const later={type:'progress',data:{stage}};
      same('deriveLifecycle',[[{type:'job.completed'},later]],'early error before wire refusal');
      same('deriveLifecycle',[[{type:'job.started'},later]],'wire refusal after successful policy');
      same('safeDeriveLifecycle',[[{type:'job.started'},later]],'safe wire refusal');
    }
    const unstringifiable = {type:'progress',data:{stage:1n}};
    same('deriveLifecycle',[[{type:'job.started'},unstringifiable,{type:'job.failed'},{type:'job.completed'}]],
      'later policy error precedes earlier unstringifiable no-op');
    const throwing = { get type() { throw new TypeError('synthetic getter'); } };
    same('safeDeriveLifecycle',[[throwing]],'safe does not catch raw getter errors');
  });
});

test('malformed diagnostic context is refused, including forged locations and unbounded indices', () => {
  const check = (op,args,reply) => wasm.taskLifecycleDiagnosticReply(op,args,reply);
  for (const reply of [
    {throws:'unknown_state',diagnostic:{site:'pair'}},
    {throws:'illegal',diagnostic:{site:'move',current:'planned'}},
    {throws:'illegal',diagnostic:{site:'move',current:'blocked',target:'verifying'}},
    {throws:'illegal',diagnostic:{site:'move',current:'planned',target:'verifying',event:0}},
    {throws:'stale',diagnostic:{site:'stale',current:'planned',extra:'ignored'}},
    {throws:'illegal',diagnostic:{site:'fromState'}},
  ]) assert.throws(() => check(6,['planned',{},false,false],reply), {reason:'reply'});
  for (const index of [-1,1,Number.MAX_SAFE_INTEGER,Infinity]) {
    assert.throws(() => check(5,[[{type:'job.completed'}]],
      {throws:'illegal',diagnostic:{site:'move',event:index,current:'planned',target:'verifying'}}), {reason:'reply'});
  }
  assert.deepStrictEqual(check(4,[[],'bad',false],{throws:'unknown_state',diagnostic:{site:'fromState'}}),
    {throws:'unknown_state',diagnostic:{site:'fromState'}});
});

function compareGetterStep(make, label, authoritative = false) {
  const run = (module) => {
    const { state, event, trace } = make();
    const result = capture(() => module.step(state, event, { authoritative }));
    return { result, preservesRawIdentity: Object.hasOwn(result, 'value') && result.value === state, trace };
  };
  assert.deepStrictEqual(run(lc), run(old), label);
}
function getterSequence(trace, name, values) {
  let n = 0;
  return () => {
    trace.push(name + ':' + n);
    const value = values[Math.min(n++, values.length - 1)];
    if (value instanceof Error) throw value;
    return value;
  };
}
test('2082: raw stage getters retain captured targets, cached data, lazy coercions and error metadata', () => {
  for (const first of ['shipped', undefined, null]) {
    for (const second of ['blocked', new TypeError('second target must not be read')]) {
      compareGetterStep(() => {
        const trace = [], data = { from: 'planned', get to() { return to(); } };
        const to = getterSequence(trace, 'to', [first, second]);
        const getData = getterSequence(trace, 'data', [data, new TypeError('second data must not be read')]);
        return { state: 'planned', event: { type: 'task.stage', get data() { return getData(); } }, trace };
      }, 'captured unknown target');
    }
  }
  for (const targets of [
    ['implementing', 'blocked', 'implementing'],
    ['implementing', 'reviewing', 'reviewing', 'blocked'],
    ['reviewing', 'reviewing', 'reviewing', 'blocked'],
    ['reviewing', 'reviewing', 'implementing', 'merged'],
    ['implementing', 'blocked', undefined],
  ]) for (const hashes of [[null], ['a'.repeat(64)], ['a'.repeat(64), 1n],
    ['a'.repeat(64), Symbol('hash')], ['a'.repeat(64), { toString() { return 'a'.repeat(64); } }]]) {
    compareGetterStep(() => {
      const trace = [], to = getterSequence(trace, 'to', targets), hash = getterSequence(trace, 'hash', hashes);
      return { state: 'implementing', event: { type: 'task.stage', data: {
        from: 'implementing', get to() { return to(); }, get reportHash() { return hash(); },
      } }, trace };
    }, 'lazy stage target and hash reads');
  }
  compareGetterStep(() => {
    const trace = [], from = getterSequence(trace, 'from', ['wrong', 'message-value', 'metadata-value']);
    const to = getterSequence(trace, 'to', ['implementing', 'blocked']);
    const data = { get from() { return from(); }, get to() { return to(); } };
    const getData = getterSequence(trace, 'data', [data, new TypeError('cached data')]);
    return { state: 'planned', event: { type: 'task.stage', get data() { return getData(); } }, trace };
  }, 'stale formatter retains original from/from/to rereads');
});
test('2082: progress identity and event type getters preserve original read order and raw errors', () => {
  compareGetterStep(() => {
    const trace = [], state = {}, stage = getterSequence(trace, 'stage', ['implementing', state]);
    return { state, trace, event: { type: 'progress', data: { get stage() { return stage(); } } } };
  }, 'raw advance identity precedes known-state validation');
  for (const state of ['planned', 'implementing', undefined, null]) for (const stages of [
    ['implementing', 'verifying'], ['ignored', new TypeError('unread second stage')],
    ['verifying', new TypeError('second stage error')],
  ]) compareGetterStep(() => {
    const trace = [], stage = getterSequence(trace, 'stage', stages);
    return { state, trace, event: { type: 'progress', data: { get stage() { return stage(); } } } };
  }, 'canonical progress predicate then actual advance');
  for (const types of [
    ['ignored', 'task.stage'], ['ignored', 'ignored', 'task.revision'],
    ['ignored', 'ignored', 'ignored', 'progress'],
    ['ignored', 'ignored', 'ignored', 'ignored', 'job.cancelled'],
    ['ignored', 'ignored', 'ignored', 'ignored', 'ignored', 'job.interrupted'],
    ['ignored', new TypeError('second type')],
    [undefined, new TypeError('unread type')],
  ]) for (const authoritative of [false, true]) compareGetterStep(() => {
    const trace = [], type = getterSequence(trace, 'type', types);
    const data = { from: 'planned', to: 'implementing', stage: 'implementing' };
    return { state: 'planned', trace, event: {
      get type() { return type(); }, get data() { trace.push('data'); return data; },
    } };
  }, 'event type read schedule', authoritative);
  for (const method of ['deriveLifecycle', 'safeDeriveLifecycle']) {
    const run = (module) => capture(() => module[method]([{ type: 'task.stage', get data() {
      throw new TypeError('raw getter error');
    } }]));
    assert.deepStrictEqual(run(lc), run(old), method + ' propagates non-policy exception');
  }
});

test('2082: changing valid stage targets retain every lazy branch and first-failure order', () => {
  const choices = [...old.STATES, null, undefined, new TypeError('later target getter')];
  for (const state of ['planned', 'implementing', 'reviewing']) {
    for (const first of old.STATES) for (const second of choices) for (const third of choices) {
      compareGetterStep(() => {
        const trace = [], to = getterSequence(trace, 'to', [first, second, third, 'blocked']);
        const hash = getterSequence(trace, 'hash', ['a'.repeat(64), 'bad']);
        return { state, trace, event: { type: 'task.stage', data: {
          from: state, get to() { return to(); }, get reportHash() { return hash(); },
        } } };
      }, 'lazy stage matrix ' + state + '/' + first);
    }
  }
});
