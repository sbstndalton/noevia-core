'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const ac = require('./llamacpp-autoconfig.cjs');
const old = require('../tests/reference/llamacpp-autoconfig-js.cjs');
const args = () => ({ meta: { arch:'llama', contextLength:8192, embeddingLength:4096, blockCount:4, headCount:32, headCountKv:8, hasChatTemplate:true }, modelBytes:1024 ** 3, budgetGib:14, options:{'cache-ram':-1} });
const capture = fn => {
  try { return { value: fn() }; }
  catch(error) { return { error:{name:error.name,message:error.message,code:error.code,status:error.status} }; }
};
test('all legacy callable exports, key order and function arities remain compatible', () => {
  const keys = Object.keys(old);
  assert.deepEqual(Object.keys(ac).slice(0, keys.length), keys);
  for (const key of keys) if (typeof old[key] === 'function') {
    assert.equal(typeof ac[key], 'function', key);
    assert.equal(ac[key].length, old[key].length, key + ': function arity');
  }
});
test('legacy raw estimator names invoke the Rust program without strict serialization', () => {
  for (const name of ['suggestJs','estimateInputsJs','estimateFootprintJs']) {
    const input = args(); let serialized = 0;
    input.unused = input;
    input.toJSON = () => { serialized++; throw new Error('raw API must not serialize'); };
    assert.deepEqual(ac[name](input), old[name](input), name);
    assert.equal(serialized, 0);
    for (const value of [undefined,null,0,'primitive']) assert.deepEqual(capture(()=>ac[name](value)),capture(()=>old[name](value)),name + ':' + String(value));
  }
});
test('raw helper domains and default arguments are preserved', () => {
  for (const value of [undefined,null,'',0,-1,1n,[1024],{toString(){return '-1';}},NaN,Infinity,-0]) {
    assert.deepEqual(capture(()=>ac.cacheRamMibOf(value)),capture(()=>old.cacheRamMibOf(value)));
    assert.deepEqual(capture(()=>ac.parseMemoryLimit(value)),capture(()=>old.parseMemoryLimit(value)));
  }
  for (const model of [undefined,null,Symbol('embed'),'chat']) for (const options of [undefined,{},null,{rerank:{toString(){return ' ON ';}}}]) {
    assert.deepEqual(capture(()=>ac.isPromptCacheFree(model,options)),capture(()=>old.isPromptCacheFree(model,options)));
  }
  for (const meta of [undefined,null,0,{},args().meta]) for (const ctx of [undefined,4096,Infinity,-0]) {
    assert.deepEqual(capture(()=>ac.kvCacheBytes(meta,ctx)),capture(()=>old.kvCacheBytes(meta,ctx)));
  }
});
test('legacy conservative helpers are Rust decisions over the full raw domain', () => {
  const raw = args();
  const suggestion = old.suggestJs(raw), inputs = old.estimateInputsJs(raw), footprint = old.estimateFootprintJs(raw);
  for (const [name,pairs] of [
    ['suggestionIsConservative',[[undefined,null],[{error:'synthetic'},null],[suggestion,suggestion]]],
    ['inputsAreConservative',[[undefined,null],[inputs,inputs],[inputs,null]]],
    ['footprintIsConservative',[[undefined,null],[footprint,null],[{totalGib:NaN},null],[{cacheRamUnbounded:true},null]]],
  ]) for (const pair of pairs) assert.deepEqual(capture(()=>ac[name](...pair)),capture(()=>old[name](...pair)),name);
});
test('KV type metadata retains shared identity and mutation semantics', () => {
  const table = ac.KV_TYPE_BYTES, saved = old.KV_TYPE_BYTES.f16;
  assert.equal(ac.KV_TYPE_BYTES,table);
  try {
    table.f16 = 4; old.KV_TYPE_BYTES.f16 = 4;
    assert.deepEqual(ac.estimateFootprintJs(args()),old.estimateFootprintJs(args()));
    assert.equal(ac.KV_TYPE_BYTES.f16,4);
  } finally { table.f16 = saved; old.KV_TYPE_BYTES.f16 = saved; }
});


test('every original helper fixture also runs through its public Rust wrapper', () => {
  const fixtures = require('../tests/fixtures/llamacpp-autoconfig.v1.json');
  const functions = {
    4: input => { const value = ac.cacheRamMibOf(input.value); return value === Infinity ? {unbounded:true} : {mib:value}; },
    5: input => ({free:ac.isPromptCacheFree(input.model, input.options)}),
    6: input => { const value = ac.parseMemoryLimit(input.value); return {gib:value === Infinity ? 'Infinity' : value}; },
  };
  for (const [index, row] of fixtures.helpers.entries()) {
    assert.equal(JSON.stringify(functions[row.op](JSON.parse(row.wire))), row.reply, 'helper row ' + index);
  }
});
test('public KV metadata accessor reads preserve exact call order', () => {
  const previous = Object.getOwnPropertyDescriptor(ac.KV_TYPE_BYTES, 'f16');
  const oldPrevious = Object.getOwnPropertyDescriptor(old.KV_TYPE_BYTES, 'f16');
  const run = (module, trace) => {
    Object.defineProperty(module.KV_TYPE_BYTES, 'f16', { configurable: true, enumerable: true,
      get() { trace.push('read f16'); return { valueOf() { trace.push('coerce f16'); return 2; } }; } });
    return capture(() => module.estimateFootprintJs({ ...args(), options: {'cache-type-k':'f16','cache-type-v':'f16','cache-ram':-1} }));
  };
  try {
    const before = [], after = [];
    assert.deepEqual(run(ac, after), run(old, before));
    assert.deepEqual(after, before);
    assert.ok(before.length > 0);
  } finally {
    Object.defineProperty(ac.KV_TYPE_BYTES, 'f16', previous);
    Object.defineProperty(old.KV_TYPE_BYTES, 'f16', oldPrevious);
  }
});
test('conservative helper property traces and exceptions match the original functions', () => {
  for (const name of ['suggestionIsConservative','footprintIsConservative','inputsAreConservative']) {
    const run = module => {
      const trace = [], error = new Error('conservative property stop');
      const value = new Proxy({}, {get(target,key) { trace.push(String(key)); throw error; }});
      const result = capture(() => module[name](value, value));
      return {result,trace};
    };
    assert.deepEqual(run(ac),run(old),name);
  }
});

test('raw public wrappers normalize only faults minted by their current invocation', () => {
  const wasm = require('./dav-parse-wasm.cjs'), host = require('./llamacpp-autoconfig-host.cjs');
  const saved = wasm.llamacppAutoconfig, fail = () => { throw new Error('synthetic loader failure'); };
  const earlier = host.invokeOutcome('cacheRamMibOf',[0],fail).fault;
  assert.ok(earlier);
  let publicFault;
  wasm.llamacppAutoconfig = fail;
  try {
    for (const [name,values] of [
      ['cacheRamMibOf',[1024]],['parseMemoryLimit',['1g']],['isPromptCacheFree',['chat',{}]],
      ['kvCacheBytes',[args().meta,4096]],['suggestJs',[args()]],['estimateInputsJs',[args()]],
      ['estimateFootprintJs',[args()]],['suggestionIsConservative',[{},null]],
      ['footprintIsConservative',[{},null]],['inputsAreConservative',[{},null]],
    ]) {
      assert.throws(()=>ac[name](...values),error => {
        publicFault = error;
        return error.code === 'autoconfig_impl' && error.status === 503 && error.name === 'AutoconfigImplError';
      },name);
    }
  } finally { wasm.llamacppAutoconfig = saved; }
  for (const error of [
    Object.assign(new Error('mimic'),{name:'AutoconfigProtocolError',code:'autoconfig_impl'}),
    new host.AutoconfigProtocolError(new Error('user-created instance')),
    earlier, publicFault,
  ]) {
    for (const name of ['suggest','estimateInputs','estimateFootprint','suggestJs','estimateInputsJs','estimateFootprintJs']) {
      const input = {get meta(){throw error;}};
      assert.throws(()=>ac[name](input),thrown => thrown === error,name + ': preserve exact thrown object');
    }
  }
});
