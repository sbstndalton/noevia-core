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
