'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const family = require('./llamacpp-autoconfig-linear-family.cjs');
const baseline = require('../tests/reference/llamacpp-linear-composer.cjs');
const operators = ['+', '-', '*', '/', '%', '**', '>', '>=', '<', '<=', '===', '!==', '==', '!='];
const arg = n => ['arg', n], literal = value => ['literal', value], load = key => ['load', key];
const indexed = (outer, inner, mirror = false) => {
  const member = ['get', load('object'), ['binary', inner, arg(1), load('divisor')]];
  return ['binary', outer, mirror ? member : arg(0), mirror ? arg(0) : member];
};
const pair = outer => ['binary', outer, ['get', arg(0), literal(1)], ['get', arg(1), literal(1)]];
function outcome(callback, args) {
  try { return { value: callback(...args) }; }
  catch (error) { return { error: [error.name, error.message] }; }
}

test('all generic template/operator combinations match the historical mechanical composer', () => {
  for (const outer of operators) {
    for (const inner of operators) for (const mirror of [false, true]) {
      const tree = indexed(outer, inner, mirror), object = Object.create(null);
      for (const key of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'true', 'false', '1.5', 'NaN', 'Infinity']) object[key] = 2;
      const environment = { object, divisor: 2 }, current = family.build(tree, environment);
      assert.equal(typeof current, 'function', outer + '/' + inner + '/' + mirror);
      assert.deepEqual(outcome(current, [3, 3]), outcome(baseline.build(tree, environment), [3, 3]));
    }
    const tree = pair(outer);
    assert.deepEqual(outcome(family.build(tree, {}), [[0, 2], [0, 3]]),
      outcome(baseline.build(tree, {}), [[0, 2], [0, 3]]));
    const simple = ['binary', outer, arg(0), arg(1)];
    for (const args of [[-0, 0], [NaN, 1], [Infinity, -Infinity], [-1, 2], [1n, 2n], [1n, 2], ['2', 2], [undefined, null]]) {
      assert.deepEqual(outcome(family.build(simple, {}), args), outcome(baseline.build(simple, {}), args));
    }
  }
  assert.deepEqual(Object.keys(family), ['build'], 'runtime exports only the builder');
});

test('atomic selectors preserve opaque literal identity, every argument and live environment loads', () => {
  const value = {}, atoms = [arg(0), arg(1), arg(2), ['undefined'], literal(-0), literal(value), load('binding')];
  const args = [NaN, Infinity, value], environment = { binding: -0 };
  for (const atom of atoms) {
    const tree = ['binary', '===', atom, atom], current = family.build(tree, environment), old = baseline.build(tree, environment);
    assert.deepEqual(outcome(current, args), outcome(old, args));
  }
  assert.equal(family.build(['binary', '===', literal(value), arg(0)], environment)(value), true);
  const tree = ['binary', '/', literal(1), load('binding')];
  const current = family.build(tree, environment), old = baseline.build(tree, environment);
  assert.equal(current(), -Infinity);
  environment.binding = 0;
  assert.equal(current(), Infinity);
  assert.deepEqual(outcome(current, []), outcome(old, []));
  const sentinel = new Error('live binding getter');
  Object.defineProperty(environment, 'binding', { get() { throw sentinel; } });
  assert.throws(() => current(), error => error === sentinel);
});

function indexedTrace(build, mode, mirror) {
  const member = ['get', load('object'), ['binary', '%', arg(1), load('divisor')]];
  const tree = ['binary', '===', mirror ? member : load('left'), mirror ? load('left') : member];
  const trace = [], first = {}, changed = {}, object = {}, environment = {}, sentinel = new Error('index sentinel');
  let callback, active = false, once = mode === 'throw', left = first, divisor = 2;
  Object.defineProperty(environment, 'left', { get() { trace.push('left'); return left; } });
  Object.defineProperty(environment, 'object', { get() { trace.push('object'); return object; } });
  Object.defineProperty(environment, 'divisor', { get() { trace.push('divisor'); return divisor; } });
  for (const key of ['0', '1']) Object.defineProperty(object, key, { get() {
    trace.push('index:' + key); left = changed;
    if (once) { once = false; throw sentinel; }
    if (mode === 'elementReentrant' && !active) { active = true; trace.push('nested:' + callback(first, 0)); active = false; }
    return first;
  } });
  callback = build(tree, environment);
  const index = { [Symbol.toPrimitive](hint) {
    trace.push('coerce:' + hint);
    if (mode === 'coercionReentrant' && !active) { active = true; trace.push('nested:' + callback(first, 0)); active = false; }
    return 3;
  } };
  let initial, identicalError = false;
  try { initial = callback(first, index); }
  catch (error) { initial = 'throw'; identicalError = error === sentinel; }
  divisor = 1;
  return { initial, identicalError, retained: callback(first, 3), trace };
}
function pairTrace(build) {
  const trace = [], tree = ['binary', '-', ['get', load('left'), load('leftKey')], ['get', load('right'), load('rightKey')]];
  const environment = {}, left = {}, right = {}, sentinel = new Error('pair sentinel');
  let callback, active = false, once = true;
  for (const [name, value] of [['left', left], ['right', right]]) Object.defineProperty(environment, name, { get() { trace.push(name); return value; } });
  for (const name of ['leftKey', 'rightKey']) Object.defineProperty(environment, name, { get() { trace.push(name); return { [Symbol.toPrimitive](hint) { trace.push(name + ':' + hint); return 1; } }; } });
  Object.defineProperty(left, 1, { get() {
    trace.push('get:left');
    if (!active) {
      active = true;
      // Reenter the same callback with getters still live; prevent recursion.
      try { trace.push('nested:' + callback()); } catch (error) { trace.push('nestedError:' + (error === sentinel)); }
      active = false;
    }
    return { [Symbol.toPrimitive](hint) { trace.push('number:left:' + hint); return 2; } };
  } });
  Object.defineProperty(right, 1, { get() {
    trace.push('get:right');
    if (once) { once = false; throw sentinel; }
    return { [Symbol.toPrimitive](hint) { trace.push('number:right:' + hint); return 3; } };
  } });
  callback = build(tree, environment);
  return { value: callback(), again: callback(), trace };
}
test('ordered locals preserve both operand orders, property-key coercions, throws and nested activations', () => {
  for (const mode of ['normal', 'throw', 'elementReentrant', 'coercionReentrant']) for (const mirror of [false, true]) {
    const expected = indexedTrace(baseline.build, mode, mirror);
    assert.deepEqual(indexedTrace(family.build, mode, mirror), expected, mode + '/' + mirror);
    if (mode === 'throw') assert.equal(expected.identicalError, true);
  }
  assert.deepEqual(pairTrace(family.build), pairTrace(baseline.build));
});

test('private construction invokes no mutable collection methods or inherited numeric setters', () => {
  const tree = indexed('===', '%'), environment = { object: [false, true], divisor: 2 };
  const define = Object.defineProperty, descriptor = Object.getOwnPropertyDescriptor;
  const original0 = descriptor(Array.prototype, '0'), original7 = descriptor(Array.prototype, '7');
  const methods = ['push', 'map', 'slice', 'every'], originals = methods.map(name => Array.prototype[name]);
  const originalIterator = Array.prototype[Symbol.iterator], originalKeys = Object.keys, originalIsArray = Array.isArray;
  let hits = 0, callback, value;
  const unexpected = () => { hits++; throw new Error('private collection hook'); };
  try {
    define(Array.prototype, '0', { configurable: true, set: unexpected });
    define(Array.prototype, '7', { configurable: true, set: unexpected });
    for (let index = 0; index < methods.length; index++) Array.prototype[methods[index]] = unexpected;
    Array.prototype[Symbol.iterator] = unexpected; Object.keys = unexpected; Array.isArray = unexpected;
    callback = family.build(tree, environment);
    value = callback(true, 3);
  } finally {
    if (original0) define(Array.prototype, '0', original0); else delete Array.prototype[0];
    if (original7) define(Array.prototype, '7', original7); else delete Array.prototype[7];
    for (let index = 0; index < methods.length; index++) Array.prototype[methods[index]] = originals[index];
    Array.prototype[Symbol.iterator] = originalIterator; Object.keys = originalKeys; Array.isArray = originalIsArray;
  }
  assert.equal(hits, 0);
  assert.equal(value, true);
  for (const tree of [null, {}, ['binary', '__proto__', arg(0), arg(1)], ['binary', '+', ['arg', 3], arg(1)],
    ['binary', '+', ['call', arg(0), []], arg(1)], ['binary', '+', ['unary', '-', arg(0)], arg(1)], ['get', arg(0), literal(0)]]) {
    assert.equal(family.build(tree, {}), null, 'unsupported whole tree stays with the composer');
  }
});

test('deterministic generator check detects stale output without reading business sources', () => {
  const generator = path.join(__dirname, '../tools/gen-llamacpp-linear-family.cjs');
  const positive = spawnSync(process.execPath, [generator, '--check'], { encoding: 'utf8' });
  assert.equal(positive.status, 0, positive.stderr);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-linear-family-'));
  try {
    fs.mkdirSync(path.join(root, 'tools')); fs.mkdirSync(path.join(root, 'server'));
    const isolated = path.join(root, 'tools', path.basename(generator));
    fs.copyFileSync(generator, isolated);
    fs.writeFileSync(path.join(root, 'server/llamacpp-autoconfig-linear-family.cjs'), "'use strict';\n");
    const negative = spawnSync(process.execPath, [isolated, '--check'], { encoding: 'utf8' });
    assert.equal(negative.status, 1, 'stale output must fail --check');
    assert.match(negative.stderr, /out of date/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
