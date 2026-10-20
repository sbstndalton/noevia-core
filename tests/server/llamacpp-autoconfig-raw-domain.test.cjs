'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ac = require('../../server/llamacpp-autoconfig.cjs');
const wasm = require('../../server/dav-parse-wasm.cjs');
const oracle = require('../reference/llamacpp-autoconfig-js.cjs');
const options = { wasmLoader: () => wasm };
let oldApi = oracle, oldOptions = options;
if (process.env.NOEVIA_FROZEN_CORE_ROOT) {
  const path = require('node:path'), root = process.env.NOEVIA_FROZEN_CORE_ROOT;
  const file = path.join(root, 'server/wasm/dav-parse.wasm');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), 'c5c300907dba8ed36b38bbfcd92dc33f18be77319712504106abb09d5b8ce05b');
  const source = path.join(root, 'server/llamacpp-autoconfig.cjs');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), '5557439a8e0e063b07f0c4b34d3a0ba38da82e988992afba2a795025c616118f');
  const oldWasm = require(path.join(root, 'server/dav-parse-wasm.cjs'));
  const held = process.env.DAV_PARSE_WASM;
  try { process.env.DAV_PARSE_WASM = file; oldWasm.llamacppAutoconfig(4, {}); }
  finally { if (held === undefined) delete process.env.DAV_PARSE_WASM; else process.env.DAV_PARSE_WASM = held; }
  oldApi = require(source);
  oldOptions = { wasmLoader: () => oldWasm };
}
const frozenHash = '66b436f5e2fda9719470fbc18bd92d7b1b52eb6e881885167cdbbebd02eaa040';
const base = () => ({ meta: { arch: 'llama', contextLength: 8192, embeddingLength: 4096, blockCount: 32, headCount: 32, headCountKv: 8, hasChatTemplate: true }, modelBytes: 1024 ** 3, budgetGib: 14, options: { 'cache-ram': '-1' } });
const capture = fn => {
  try { return { value: fn() }; }
  catch (error) { return { error: { name: error.name, message: error.message, code: error.code, status: error.status } }; }
};
function compare(name, factory, methods = ['estimateFootprint']) {
  for (const method of methods) {
    const old = factory(), now = factory();
    const warn = console.warn; console.warn = () => {};
    let expected, actual;
    try { expected = capture(() => oldApi[method](old.args, oldOptions)); actual = capture(() => ac[method](now.args, options)); }
    finally { console.warn = warn; }
    assert.deepEqual(actual, expected, name + ': ' + method);
    assert.deepEqual(now.trace || [], old.trace || [], name + ': exact reads/coercions/' + method);
    if (old.after) assert.deepEqual(now.after(), old.after(), name + ': retained callback environments');
  }
}
test('the raw-domain oracle is checksum frozen', () => {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../reference/llamacpp-autoconfig-js.cjs'))).digest('hex'), frozenHash);
});
test('property reads, repeated getters and original stringify happen in frozen order', () => {
  compare('proxy order', () => {
    const trace = [], args = base();
    for (const field of ['meta', 'options']) {
      args[field] = new Proxy(args[field], {
        get: (o, k, r) => { trace.push(field + '.get:' + String(k)); return Reflect.get(o, k, r); },
        ownKeys: o => { trace.push(field + '.keys'); return Reflect.ownKeys(o); },
        getOwnPropertyDescriptor: (o, k) => { trace.push(field + '.descriptor:' + String(k)); return Reflect.getOwnPropertyDescriptor(o, k); },
      });
    }
    args.meta.nextnPredictLayers = 1;
    Object.defineProperty(args.meta, 'unused', { enumerable: true, get() { trace.push('unused'); return 7; } });
    return { args, trace };
  }, ['estimateFootprint', 'estimateInputs', 'suggest']);
  compare('changing getters', () => {
    const trace = [], args = base(); let count = 0;
    Object.defineProperty(args.meta, 'fullAttentionInterval', { enumerable: true, get() { trace.push(++count); return count % 2 ? 4 : null; } });
    return { args, trace };
  });
});
test('custom coercions and original exceptions preserve type, message and order', () => {
  compare('coercions', () => {
    const args = base(), trace = [];
    args.options['ctx-size'] = { [Symbol.toPrimitive](hint) { trace.push('ctx:' + hint); return 4096; } };
    args.options['cache-type-k'] = { toString() { trace.push('type:string'); return 'Q8_0'; } };
    args.options['cache-ram'] = { toString() { trace.push('cache:string'); return '-1'; } };
    return { args, trace };
  });
  compare('early getter throw', () => {
    const args = base(), trace = [];
    Object.defineProperty(args.meta, 'contextLength', { enumerable: true, get() { trace.push('throw'); throw new RangeError('synthetic metadata getter'); } });
    return { args, trace };
  });
  compare('draft spread getter throw', () => {
    const args = base(), trace = []; args.meta.nextnPredictLayers = 1;
    Object.defineProperty(args.meta, 'unused', { enumerable: true, get() { trace.push('spread throws'); throw new SyntaxError('synthetic spread getter'); } });
    return { args, trace };
  });
  for (const raw of [undefined, null, 4, 'primitive']) compare('parameter ' + String(raw), () => ({ args: raw }));
});
test('toJSON and irrelevant BigInt/cycles stay after native estimation', () => {
  compare('toJSON', () => {
    const args = base(), trace = [];
    args.toJSON = function () { trace.push('toJSON'); this.options['ctx-size'] = 4096; return { meta: {}, options: { 'cache-ram': '-1' } }; };
    return { args, trace };
  });
  compare('cycle', () => { const args = base(); args.unused = args; return { args }; });
  compare('BigInt', () => { const args = base(); args.unused = 1n; return { args }; });
});
test('near-cap and above-cap scalar inputs keep the old conservative answer', () => {
  for (const extra of [4 * 1024 * 1024 - 512, 4 * 1024 * 1024 - 128, 4 * 1024 * 1024 + 128, 8 * 1024 * 1024]) {
    compare('bytes ' + extra, () => { const args = base(); args.meta.unused = 'x'.repeat(extra); return { args }; });
  }
});
test('raw non-finite values, dense negative zeros and summary metadata stay accepted', () => {
  for (const value of [NaN, Infinity, -Infinity, -0]) {
    compare('raw ' + String(value), () => { const args = base(); args.options['ctx-size'] = value; return { args }; });
  }
  compare('dense -0', () => { const args = base(); args.meta.headCountKv = Array(5000).fill(-0); return { args }; });
  compare('summary objects', () => { const args = base(); args.meta.headCountKv = { count: 5000, mode: 4 }; args.meta.slidingWindowPattern = { count: 5000, period: 8 }; return { args }; });
});
test('period callbacks retain each iteration binding and reentrant calls stay isolated', () => {
  compare('captured every callbacks', () => {
    const args = base(), callbacks = [];
    args.meta.blockCount = 4; args.meta.slidingWindow = 1024;
    const seq = [false, true, false, true];
    seq.every = function (callback) { callbacks.push(callback); return Array.prototype.every.call(this, callback); };
    args.meta.slidingWindowPattern = seq;
    return { args, after: () => callbacks.map(fn => fn(false, 2)) };
  });
  compare('reentrant getter', () => {
    const args = base(), trace = [];
    Object.defineProperty(args.meta, 'keyLength', { enumerable: true, get() {
      trace.push(ac.estimateFootprintForAutotune({ modelBytes: 0, options: { 'cache-ram': 0 } }, options).totalGib);
      return 128;
    } });
    return { args, trace };
  });
});
test('direct autotune estimate shares raw behavior and does no strict serialization', () => {
  const args = base(); let calls = 0;
  args.toJSON = () => { calls++; throw new Error('must not serialize direct estimator'); };
  args.unused = args;
  assert.deepEqual(ac.estimateFootprintForAutotune(args, options), oracle.estimateFootprintJs(args));
  assert.equal(calls, 0);
});


test('public candidate-array identity and mutations affect the shared estimator closure', () => {
  const original = oracle.CTX_CANDIDATES.slice(), candidate = ac.CTX_CANDIDATES;
  assert.equal(ac.CTX_CANDIDATES, candidate);
  try {
    candidate.splice(0, candidate.length, 4096);
    oracle.CTX_CANDIDATES.splice(0, oracle.CTX_CANDIDATES.length, 4096);
    const args = base();
    assert.deepEqual(ac.suggest(args, options), oracle.suggest(args, options));
    assert.equal(ac.suggest(args, options).rows.length, 1);
  } finally {
    candidate.splice(0, candidate.length, ...original);
    oracle.CTX_CANDIDATES.splice(0, oracle.CTX_CANDIDATES.length, ...original);
  }
});
test('reentrant calls with different strict loaders restore the outer invocation context', () => {
  const args = base(); let inner = 0, outer = 0;
  const strictMissing = { wasmLoader: () => ({ llamacppAutoconfig(op, frame) {
    if (op <= 3) { outer++; throw Object.assign(new Error('strict unavailable'), { reason: 'input' }); }
    return wasm.llamacppAutoconfig(op, frame);
  } }) };
  Object.defineProperty(args.meta, 'keyLength', { get() {
    inner++;
    assert.equal(ac.estimateFootprintForAutotune({ modelBytes: 0, options: { 'cache-ram': 0 } }, options).totalGib, 1.05);
    return 128;
  } });
  assert.equal(ac.estimateFootprint(args, strictMissing).cacheRamUnbounded, true);
  assert.ok(inner >= 2);
  assert.equal(outer, 1);
});


test('period fast facts reject Proxies, accessors, holes and custom methods without observable reads', () => {
  const make = kind => {
    const args = base(), trace = [], seq = [false, true, false, true];
    args.meta.blockCount = 4; args.meta.slidingWindow = 1024;
    if (kind === 'proxy') args.meta.slidingWindowPattern = new Proxy(seq, {
      get(o,k,r) { trace.push('get:' + String(k)); return Reflect.get(o,k,r); },
      getOwnPropertyDescriptor(o,k) { trace.push('descriptor:' + String(k)); return Reflect.getOwnPropertyDescriptor(o,k); },
    });
    if (kind === 'accessor') {
      Object.defineProperty(seq, '1', { configurable: true, enumerable: true, get() { trace.push('index1'); return true; } });
      args.meta.slidingWindowPattern = seq;
    }
    if (kind === 'holes') { delete seq[1]; args.meta.slidingWindowPattern = seq; }
    if (kind === 'inherited') {
      delete seq[1]; const prototype = Object.create(Array.prototype); prototype[1] = true;
      Object.setPrototypeOf(seq, prototype); args.meta.slidingWindowPattern = seq;
    }
    if (kind === 'prototypeProxy') {
      const prototype = new Proxy(Array.prototype, { get(o,k,r) { trace.push('prototype:' + String(k)); return Reflect.get(o,k,r); }, getOwnPropertyDescriptor(o,k) { trace.push('prototype descriptor:' + String(k)); return Reflect.getOwnPropertyDescriptor(o,k); } });
      Object.setPrototypeOf(seq, prototype); args.meta.slidingWindowPattern = seq;
    }
    if (kind === 'customEvery') {
      seq.every = function (callback) { trace.push('callback arity:' + callback.length); return Array.prototype.every.call(this, callback); };
      args.meta.slidingWindowPattern = seq;
    }
    return { args, trace };
  };
  for (const kind of ['proxy','accessor','holes','inherited','prototypeProxy','customEvery']) compare(kind, () => make(kind));
});
test('prototype every accessors stay on the exact slow path', () => {
  const original = Object.getOwnPropertyDescriptor(Array.prototype, 'every'), marker = Symbol('synthetic every trace');
  try {
    Object.defineProperty(Array.prototype, 'every', { configurable: true, get() {
      if (this[marker]) this[marker].push('prototype.every getter');
      return original.value;
    } });
    compare('prototype every mutation', () => {
      const args = base(), trace = [], seq = [false, true, false, true];
      seq[marker] = trace;
      args.meta.blockCount = 4; args.meta.slidingWindow = 1024; args.meta.slidingWindowPattern = seq;
      return { args, trace };
    });
  } finally { Object.defineProperty(Array.prototype, 'every', original); }
});
test('a throwing operation stops its entire prepared primitive batch', () => {
  compare('batch exception fence', () => {
    const args = base(), trace = [];
    Object.defineProperty(args.options, 'ctx-size', { get() { trace.push('context throws'); throw new Error('synthetic batch fence'); } });
    Object.defineProperty(args.options, 'cache-type-k', { get() { trace.push('must not read cache'); return 'f16'; } });
    Object.defineProperty(args.meta, 'blockCount', { get() { trace.push('must not read block count'); return 32; } });
    return { args, trace };
  });
});
test('live opaque reference IDs are recycled across large array prefixes', () => {
  const args = base(); args.meta.headCountKv = Array(5000).fill(-0); let max = 0;
  const measured = { wasmLoader: () => ({ llamacppAutoconfig(op, frame) {
    if (op === 11) max = Math.max(max, frame.env);
    if (op === 12) {
      const state = frame.state;
      max = Math.max(max, state.env, ...state.stack, ...(state.period ? [state.period.seq] : []), ...(frame.frame.value ? [frame.frame.value] : []));
    }
    return wasm.llamacppAutoconfig(op, frame);
  } }) };
  assert.equal(ac.estimateFootprint(args, measured).cacheRamUnbounded, true);
  assert.ok(max < 512, 'IDs stay bounded instead of counting the processed prefix: ' + max);
});

test('scalar-loop optimization falls back for coercion hooks and per-layer head sequences', () => {
  compare('object KV head count', () => {
    const args = base(), trace = [];
    const head = { [Symbol.toPrimitive](hint) { trace.push('head:' + hint); return 8; } };
    args.meta.blockCount = 4; args.meta.slidingWindow = 1024;
    args.meta.slidingWindowPattern = [false,true,false,true];
    args.meta.headCountKv = [head,head,4];
    return { args, trace };
  });
  const contextNumber = function (hint) { this.trace.push('ctx:' + hint); return 8192; };
  compare('object native context', () => {
    const args = base(), trace = [];
    args.meta.contextLength = { trace, [Symbol.toPrimitive]: contextNumber };
    args.meta.blockCount = 4; args.meta.slidingWindow = 1024;
    args.meta.slidingWindowPattern = [false,true,false,true];
    return { args, trace };
  });
  compare('head sequence accessor', () => {
    const args = base(), trace = [], heads = [8,8,8,8];
    Object.defineProperty(heads, '1', { get() { trace.push('head index1'); return 8; }, enumerable: true });
    args.meta.blockCount = 4; args.meta.slidingWindow = 1024;
    args.meta.slidingWindowPattern = [false,true,false,true]; args.meta.headCountKv = heads;
    return { args, trace };
  });
  for (const value of [Infinity, -0, NaN]) compare('raw coefficient ' + value, () => {
    const args = base(); args.meta.blockCount = 4; args.meta.slidingWindow = 1024;
    args.meta.slidingWindowPattern = [false,true,false,true]; args.meta.keyLength = value;
    return { args };
  });
});
test('Boolean windows preserve non-dividing periods and cross the fixed cache size', () => {
  for (const [length, period] of [[35,3],[70,13],[4097,7],[9000,8]]) compare('window ' + length + '/' + period, () => {
    const args = base();
    args.meta.blockCount = length; args.meta.slidingWindow = 1024;
    args.meta.slidingWindowPattern = Array.from({length}, (_,i) => i % period !== period - 1);
    return { args };
  });
});

test('abrupt for-of bodies close raw iterators with original exception precedence', () => {
  // Warm the shared module before substituting this intrinsic.
  ac.kvCacheBytes({}, 1);
  for (const mode of ['normal-return','return-getter-throws','return-call-throws','return-not-callable','return-primitive','next-throws','done-throws','value-throws']) {
    const run = api => {
      const trace = [], original = new Error('original iteration failure'), secondary = new Error('secondary close failure');
      const values = [8], saved = Map.prototype.set;
      values[Symbol.iterator] = function() {
        let count = 0;
        const iterator = { next() {
          trace.push('next');
          if (mode === 'next-throws') throw original;
          if (count++) return {done:true};
          return {
            get done() { trace.push('done'); if (mode === 'done-throws') throw original; return false; },
            get value() { trace.push('value'); if (mode === 'value-throws') throw original; return 8; },
          };
        }};
        Object.defineProperty(iterator,'return',{get() {
          trace.push('get return');
          if (mode === 'return-getter-throws') throw secondary;
          if (mode === 'return-not-callable') return 4;
          return function() {
            trace.push('call return');
            if (mode === 'return-call-throws') throw secondary;
            return mode === 'return-primitive' ? 4 : {};
          };
        }});
        return iterator;
      };
      Map.prototype.set = function() { trace.push('set'); throw original; };
      let thrown;
      try { api.kvCacheBytes({...base().meta,headCountKv:values},4096); }
      catch(error) { thrown = {sameOriginal:error===original,name:error.name,message:error.message}; }
      finally { Map.prototype.set = saved; }
      return {trace,thrown};
    };
    const expected = run(oldApi), actual = run(ac);
    assert.deepEqual(actual,expected,mode);
    assert.equal(expected.thrown.sameOriginal,true,mode);
    assert.equal(expected.trace.includes('get return'),!['next-throws','done-throws','value-throws'].includes(mode),mode);
  }
});
