'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const core = path.resolve(__dirname, '../..');
const facadePath = path.join(core, 'server/llamacpp-autoconfig.cjs');
const oraclePath = path.join(core, 'tests/reference/llamacpp-autoconfig-js.cjs');
const wasmPath = process.env.DAV_PARSE_WASM || path.join(core, 'server/wasm/dav-parse.wasm');
const available = fs.existsSync(wasmPath);
if (!available && process.env.DAV_PARSE_WASM_REQUIRED === '1') throw Error('required dav-parse.wasm is missing');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(oraclePath)).digest('hex'),
  '66b436f5e2fda9719470fbc18bd92d7b1b52eb6e881885167cdbbebd02eaa040');
const invokeCases = api => [
  api.parseMemoryLimit('14g'),
  api.isPromptCacheFree('ordinary', {}),
  api.suggestJs({ meta: { hasChatTemplate: true, arch: 'llama' }, modelBytes: 0, budgetGib: 14 }),
  api.estimateInputsJs({ meta: { hasChatTemplate: true, arch: 'bert' }, modelBytes: 0 }),
];

function child(mode) {
  const oracle = require(oraclePath);
  if (mode.startsWith('global:')) {
    const [, timing, kind] = mode.split(':'), saved = Object.getOwnPropertyDescriptor(globalThis, 'RegExp');
    const expected = invokeCases(oracle), sentinel = new Error('global RegExp must not participate');
    let calls = 0, actual, thrown, api;
    if (timing === 'post') { api = require(facadePath); api.parseMemoryLimit('1g'); }
    try {
      if (kind === 'getter') Object.defineProperty(globalThis, 'RegExp', { configurable: true, get() { calls++; throw sentinel; } });
      else Object.defineProperty(globalThis, 'RegExp', { configurable: true, writable: true, value: function ReplacedRegExp() { calls++; throw sentinel; } });
      if (!api) api = require(facadePath);
      try { actual = invokeCases(api); } catch (error) { thrown = error; }
    } finally { Object.defineProperty(globalThis, 'RegExp', saved); }
    assert.equal(thrown, undefined);
    assert.deepEqual(actual, expected);
    assert.equal(calls, 0, 'neither importing nor evaluating literals consults the global constructor');
    return;
  }
  if (mode === 'prototypeConstructor') {
    const proto = Object.getPrototypeOf(/x/), saved = Object.getOwnPropertyDescriptor(proto, 'constructor');
    const expected = invokeCases(oracle), sentinel = new Error('prototype constructor');
    let calls = 0, actual, thrown;
    try {
      Object.defineProperty(proto, 'constructor', { configurable: true, get() { calls++; throw sentinel; } });
      try { actual = invokeCases(require(facadePath)); } catch (error) { thrown = error; }
    } finally { Object.defineProperty(proto, 'constructor', saved); }
    assert.equal(thrown, undefined); assert.equal(calls, 0); assert.deepEqual(actual, expected);
    return;
  }
  const api = require(facadePath);
  api.parseMemoryLimit('1g'); // Exclude one-time module/lock initialization from business traces.
  const proto = Object.getPrototypeOf(/x/);
  if (mode === 'order') {
    const exec = Object.getOwnPropertyDescriptor(proto, 'exec'), method = Object.getOwnPropertyDescriptor(proto, 'test');
    function capture(fn, name) {
      const trace = [];
      let value;
      try {
        Object.defineProperty(proto, 'exec', { configurable: true, get() {
          trace.push('exec:get'); return function (s) { trace.push('exec:call'); return Reflect.apply(exec.value, this, [s]); };
        } });
        Object.defineProperty(proto, 'test', { configurable: true, get() {
          trace.push('test:get'); return function (s) { trace.push('test:call'); return Reflect.apply(method.value, this, [s]); };
        } });
        const input = { toString() { trace.push('String'); return name === 'parseMemoryLimit' ? '14g' : 'ordinary'; } };
        value = fn[name](input);
      } finally {
        Object.defineProperty(proto, 'exec', exec); Object.defineProperty(proto, 'test', method);
      }
      return { value, trace };
    }
    for (const name of ['parseMemoryLimit', 'isPromptCacheFree']) {
      const old = capture(oracle, name), current = capture(api, name);
      assert.deepEqual(current, old);
      assert.equal(current.trace[0], name === 'parseMemoryLimit' ? 'exec:get' : 'test:get');
      assert.equal(current.trace[1], 'String', 'method lookup precedes original explicit String coercion');
    }
    return;
  }
  if (mode === 'freshReentrant') {
    const saved = Object.getOwnPropertyDescriptor(proto, 'exec');
    function capture(fn) {
      const references = [], trace = [], results = [];
      let active = false;
      try {
        Object.defineProperty(proto, 'exec', { configurable: true, get() {
          const id = references.length; references.push(this); trace.push(['get', id, this.lastIndex]);
          return function (s) {
            trace.push(['call', id, this.lastIndex]); this.lastIndex = 71;
            if (!active) { active = true; results.push(fn.parseMemoryLimit('3g')); active = false; }
            return Reflect.apply(saved.value, this, [s]);
          };
        } });
        results.push(fn.parseMemoryLimit('2g'));
        results.push(fn.parseMemoryLimit('4g'));
      } finally { Object.defineProperty(proto, 'exec', saved); }
      assert.equal(new Set(references).size, references.length, 'each literal evaluation creates an independent object');
      assert.ok(trace.filter(row => row[0] === 'get').every(row => row[2] === 0), 'no retained lastIndex');
      return { trace, results, objects: references.length };
    }
    assert.deepEqual(capture(api), capture(oracle));
    return;
  }
  if (mode === 'userThrows') {
    const exec = Object.getOwnPropertyDescriptor(proto, 'exec'), method = Object.getOwnPropertyDescriptor(proto, 'test');
    const sentinel = Object.assign(new Error('user RegExp hook'), { name: 'AutoconfigProtocolError', code: 'autoconfig_impl' });
    for (const point of ['exec', 'test', 'coercion']) {
      function capture(fn) {
        let thrown;
        try {
          if (point !== 'coercion') Object.defineProperty(proto, point, { configurable: true, get() { throw sentinel; } });
          const input = point === 'coercion' ? { toString() { throw sentinel; } } : 'ordinary';
          try { fn[point === 'test' ? 'isPromptCacheFree' : 'parseMemoryLimit'](input); } catch (error) { thrown = error; }
        } finally { Object.defineProperty(proto, 'exec', exec); Object.defineProperty(proto, 'test', method); }
        return thrown;
      }
      assert.equal(capture(oracle), sentinel); assert.equal(capture(api), sentinel, point + ': exact user error identity');
    }
    return;
  }
  if (mode === 'metadata') {
    const bridge = require(path.join(core, 'server/dav-parse-wasm.cjs'));
    const host = require(path.join(core, 'server/llamacpp-autoconfig-host.cjs'));
    const original = bridge.llamacppAutoconfig;
    let observations = 0, touches = 0, mutate;
    bridge.llamacppAutoconfig = function (op, args) {
      const result = original(op, args);
      if (op === 11 || op === 12) {
        for (const operation of result.reply.batch || []) {
          const request = result.reply.wire === 'state-v2d' ? operation[1] : operation.request;
          if (request.op === 'regexp') {
            observations++; request.data = mutate(request.data);
          }
        }
      }
      return result;
    };
    const mutations = [
      data => ({ ...data, pattern: 'uncompiled-pattern' }),
      data => ({ pattern: data.pattern }),
      data => ({ ...data, stale: true }),
      data => ({ ...data, flags: data.flags + data.flags }),
      data => Object.defineProperty({ flags: data.flags }, 'pattern', { enumerable: true, get() { touches++; throw Error('metadata getter'); } }),
      data => new Proxy(data, { ownKeys() { touches++; throw Error('metadata proxy'); }, getOwnPropertyDescriptor() { touches++; throw Error('metadata proxy'); } }),
    ];
    try {
      for (mutate of mutations) {
        const before = observations;
        const outcome = host.invokeOutcome('parseMemoryLimit', ['14g'], () => bridge);
        assert.ok(outcome.fault instanceof host.AutoconfigProtocolError, 'unknown/malformed metadata mints infrastructure fault');
        assert.ok(observations > before, 'actual Rust regexp instruction was changed');
        assert.throws(() => api.parseMemoryLimit('14g'), error => error.code === 'autoconfig_impl' && error.status === 503);
      }
    } finally { bridge.llamacppAutoconfig = original; }
    assert.equal(touches, 0, 'malformed descriptor getters and Proxy traps are never inspected');
    return;
  }
  throw Error('unknown child control');
}

if (process.env.NOEVIA_REGEXP_LITERAL_CHILD) {
  child(process.env.NOEVIA_REGEXP_LITERAL_CHILD);
} else {
  for (const timing of ['pre', 'post']) for (const kind of ['getter', 'constructor']) {
    test('RegExp literals bypass ' + timing + '-import global ' + kind, { skip: !available && 'dav-parse.wasm not built' }, () => run('global:' + timing + ':' + kind));
  }
  for (const [mode, label] of [
    ['prototypeConstructor', 'RegExp literals do not consult a mutated prototype constructor'],
    ['order', 'literal method getters precede String coercion exactly as the frozen source'],
    ['freshReentrant', 'literal objects remain fresh across lastIndex mutation and synchronous reentrancy'],
    ['userThrows', 'RegExp and coercion user throws retain identity even with infrastructure-like names'],
    ['metadata', 'uncompiled or malformed Rust literal metadata fails closed as infrastructure'],
  ]) test(label, { skip: !available && 'dav-parse.wasm not built' }, () => run(mode));

  test('catalog lookup never coerces keys or inherits lookup entries', () => {
    const { create } = require('../../server/llamacpp-autoconfig-regexp-literals.cjs');
    let touches = 0;
    const object = { [Symbol.toPrimitive]() { touches++; throw Error('coercion'); } };
    for (const [pattern, flags] of [[object, 'i'], ['bert', object], ['__proto__', 'i'], ['bert', 'constructor'], ['toString', 'i']]) {
      assert.equal(create(pattern, flags), undefined);
    }
    assert.equal(touches, 0);
    assert.deepEqual(Object.keys(require('../../server/llamacpp-autoconfig-regexp-literals.cjs')), ['create']);
  });
}
function run(mode) {
  const result = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, NOEVIA_REGEXP_LITERAL_CHILD: mode }, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.signal, null, mode + ': child signal\n' + result.stderr);
  assert.equal(result.status, 0, mode + '\n' + result.stdout + result.stderr);
}
