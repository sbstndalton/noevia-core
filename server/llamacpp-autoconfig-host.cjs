'use strict';
// A mechanical ECMAScript host for Rust's stateless evaluator. No estimator,
// policy table, candidate traversal, arithmetic expression or conservative decision lives here.
// Values (including strings of any length) remain opaque host references.
class AutoconfigProtocolError extends Error {
  constructor(cause) {
    super('Rust autoconfig evaluator protocol failed', { cause });
    this.name = 'AutoconfigProtocolError';
  }
}
const hasOwn = Object.prototype.hasOwnProperty;
const apply = Reflect.apply;
const objectCreate = Object.create;
const objectKeys = Object.keys;
const arrayIncludes = Array.prototype.includes;
const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const getPrototype = Object.getPrototypeOf;
const defineProperty = Object.defineProperty;
const arrayPrototype = Array.prototype;
const arrayEvery = Array.prototype.every;
const arrayIsArray = Array.isArray;
const isProxy = require('node:util').types.isProxy;
const owns = (object, name) => apply(hasOwn, object, [name]);
const define = (object, key, value) => {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
  return object;
};
function binary(operator, a, b) {
  switch (operator) {
    case '+': return a + b; case '-': return a - b; case '*': return a * b;
    case '/': return a / b; case '%': return a % b; case '**': return a ** b;
    case '>': return a > b; case '>=': return a >= b; case '<': return a < b; case '<=': return a <= b;
    case '===': return a === b; case '!==': return a !== b;
    case '==': return a == b; // eslint-disable-line eqeqeq
    case '!=': return a != b; // eslint-disable-line eqeqeq
    default: throw new AutoconfigProtocolError();
  }
}
function unary(operator, value) {
  switch (operator) {
    case '!': return !value; case '+': return +value; case '-': return -value;
    case 'typeof': return typeof value; case 'void': return undefined;
    default: throw new AutoconfigProtocolError();
  }
}

// Build a composition of mechanical operations selected by Rust. There is no
// source evaluation and no input-dependent branch in these callback blocks.
// Ordinary control flow, including the period-search loop, remains in Rust.
function linearBinary(operator, left, right) {
  switch (operator) {
    case '+': return (a,b,c) => left(a,b,c) + right(a,b,c);
    case '-': return (a,b,c) => left(a,b,c) - right(a,b,c);
    case '*': return (a,b,c) => left(a,b,c) * right(a,b,c);
    case '/': return (a,b,c) => left(a,b,c) / right(a,b,c);
    case '%': return (a,b,c) => left(a,b,c) % right(a,b,c);
    case '**': return (a,b,c) => left(a,b,c) ** right(a,b,c);
    case '>': return (a,b,c) => left(a,b,c) > right(a,b,c);
    case '>=': return (a,b,c) => left(a,b,c) >= right(a,b,c);
    case '<': return (a,b,c) => left(a,b,c) < right(a,b,c);
    case '<=': return (a,b,c) => left(a,b,c) <= right(a,b,c);
    case '===': return (a,b,c) => left(a,b,c) === right(a,b,c);
    case '!==': return (a,b,c) => left(a,b,c) !== right(a,b,c);
    case '==': return (a,b,c) => left(a,b,c) == right(a,b,c); // eslint-disable-line eqeqeq
    case '!=': return (a,b,c) => left(a,b,c) != right(a,b,c); // eslint-disable-line eqeqeq
    default: throw new AutoconfigProtocolError();
  }
}
function linearUnary(operator, value) {
  switch (operator) {
    case '!': return (a,b,c) => !value(a,b,c);
    case '+': return (a,b,c) => +value(a,b,c);
    case '-': return (a,b,c) => -value(a,b,c);
    case 'typeof': return (a,b,c) => typeof value(a,b,c);
    case 'void': return (a,b,c) => void value(a,b,c);
    default: throw new AutoconfigProtocolError();
  }
}
function linearTree(tree, environment) {
  const [op, data] = tree;
  switch (op) {
    case 'arg':
      if (data === 0) return a => a;
      if (data === 1) return (a,b) => b;
      if (data === 2) return (a,b,c) => c;
      throw new AutoconfigProtocolError();
    case 'undefined': return () => undefined;
    case 'literal': return () => data;
    case 'load': return () => environment[data];
    case 'binary': return linearBinary(data, linearTree(tree[2], environment), linearTree(tree[3], environment));
    case 'unary': return linearUnary(data, linearTree(tree[2], environment));
    case 'get': {
      const object = linearTree(data, environment), key = linearTree(tree[2], environment);
      return (a,b,c) => object(a,b,c)[key(a,b,c)];
    }
    case 'method': {
      const object = linearTree(data, environment), key = linearTree(tree[2], environment);
      const arguments_ = tree[3].map(argument => linearTree(argument, environment));
      return (a,b,c) => {
        const receiver = object(a,b,c), fn = receiver[key(a,b,c)];
        return apply(fn, receiver, arguments_.map(argument => argument(a,b,c)));
      };
    }
    case 'call': {
      const fn = linearTree(data, environment);
      const arguments_ = tree[2].map(argument => linearTree(argument, environment));
      return (a,b,c) => {
        const callee = fn(a,b,c);
        return apply(callee, undefined, arguments_.map(argument => argument(a,b,c)));
      };
    }
    default: throw new AutoconfigProtocolError();
  }
}



// Non-observable shape facts only. Reject Proxies before any descriptor query.
// Unsafe shapes retain the original iterator/every/getter program in Rust.
function booleanArrayFacts(value) {
  if (isProxy(value) || !arrayIsArray(value)) return { safe: false };
  const prototype = getPrototype(value);
  if (isProxy(prototype) || prototype !== arrayPrototype) return { safe: false };
  if (getOwnDescriptor(value, 'every') !== undefined) return { safe: false };
  const method = getOwnDescriptor(prototype, 'every');
  if (!method || !owns(method, 'value') || method.value !== arrayEvery) return { safe: false };
  const length = getOwnDescriptor(value, 'length').value;
  for (let index = 0; index < length; index++) {
    const descriptor = getOwnDescriptor(value, index);
    if (!descriptor || !owns(descriptor, 'value') || typeof descriptor.value !== 'boolean') return { safe: false };
  }
  return { safe: true, len: length };
}
function booleanChunk(value, start, count) {
  let text = '', nibble = 0;
  for (let index = 0; index < count; index++) {
    if (value[start + index]) nibble |= 1 << (index % 4);
    if (index % 4 === 3 || index + 1 === count) {
      text += '0123456789abcdef'[nibble]; nibble = 0;
    }
  }
  return text;
}


function invocationContext(wasmLoader) {
  let module;
  return {
    step(op, frame) {
      try {
        module ||= wasmLoader();
        return module.llamacppAutoconfig(op, frame).reply;
      } catch (cause) { throw new AutoconfigProtocolError(cause); }
    },
    strict(op, args) {
      let port = null, refused = null;
      try { port = module.llamacppAutoconfig(op, args); }
      catch (err) { refused = String(err?.reason || 'unexpected').slice(0, 40); }
      return { text: port?.text, reply: port ? port.reply : null, refused };
    },
  };
}
function evaluator(initialContext) {
  const contexts = [];
  function execute(functionId, args, parent, context) {
    const step = (op, frame) => context.step(op, frame);
    // Every invocation, including synchronous/reentrant native callbacks, owns its
    // reference namespace. Closures capture actual environments, never another table's IDs.
    let nextRef = 0;
    const values = objectCreate(null), free = [];
    const put = value => {
      let ref;
      if (free.length) { ref = free[free.length - 1]; free.length -= 1; } else ref = ++nextRef;
      values[ref] = value;
      return ref;
    };
    const get = ref => {
      if (!owns(values, ref)) throw new AutoconfigProtocolError();
      return values[ref];
    };
    const environment = Object.create(parent);
    define(environment, '@args', args);
    let message = step(11, { function: functionId, env: put(environment) });
    for (;;) {
      if (!message || typeof message !== 'object') throw new AutoconfigProtocolError();
      if (owns(message, 'done')) return get(message.done);
      if (owns(message, 'throw')) throw get(message.throw);
      if (!Array.isArray(message.batch) || message.batch.length < 1 || message.batch.length > 32) throw new AutoconfigProtocolError();
      let state, frame;
      for (const operation of message.batch) {
        const { request, args: references } = operation;
        state = operation.state; frame = undefined;
        if (!state || !request || !Array.isArray(references)) throw new AutoconfigProtocolError();
        try {
        const input = references.map(get);
        const data = request.data;
        let value;
        switch (request.op) {
          case 'booleanArrayFacts': frame = { facts: booleanArrayFacts(input[0]) }; break;
          case 'booleanChunk': frame = { bits: booleanChunk(input[0], data.start, data.count) }; break;
          case 'literal': value = data; break;
          case 'undefined': value = undefined; break;
          case 'regexp': value = new RegExp(data.pattern, data.flags); break;
          case 'object': value = {}; break;
          case 'array': value = []; break;
          case 'scope': value = Object.create(input[0]); break;
          case 'parent': value = Object.getPrototypeOf(input[0]); break;
          case 'cloneScope':
            value = Object.create(Object.getPrototypeOf(input[0]), Object.getOwnPropertyDescriptors(input[0]));
            break;
          case 'load': value = input[0][data]; break;
          case 'declare': define(input[1], data, input[0]); value = input[0]; break;
          case 'store': {
            let owner = input[1];
            while (owner && !owns(owner, data)) owner = Object.getPrototypeOf(owner);
            if (!owner) throw new AutoconfigProtocolError();
            owner[data] = input[0]; value = input[0]; break;
          }
          case 'destructure':
            if (input[0] == null) throw new TypeError("Cannot destructure property '" + data + "' of '" + (input[0] === null ? 'object null' : String(input[0])) + "' as it is " + String(input[0]) + '.');
            value = input[0]; break;
          case 'get': value = input[0][input[1]]; break;
          case 'set': input[0][input[1]] = input[2]; value = input[2]; break;
          case 'define': value = define(input[0], input[1], input[2]); break;
          case 'append': value = define(input[0], input[0].length, input[1]); break;
          case 'hole': input[0].length++; value = input[0]; break;
          case 'spread': {
            value = input[0];
            if (input[1] != null) {
              const source = Object(input[1]);
              for (const key of Reflect.ownKeys(source)) {
                if (Object.getOwnPropertyDescriptor(source, key)?.enumerable) define(value, key, source[key]);
              }
            }
            break;
          }
          case 'arraySpread':
            value = input[0];
            for (const item of input[1]) define(value, value.length, item);
            break;
          case 'iterator': {
            const iterator = input[0][Symbol.iterator]();
            if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) throw new TypeError('Result of the Symbol.iterator method is not an object');
            value = { iterator, next: iterator.next };
            break;
          }
          case 'next':
            value = Reflect.apply(input[0].next, input[0].iterator, []);
            if ((typeof value !== 'object' && typeof value !== 'function') || value === null) throw new TypeError('Iterator result ' + String(value) + ' is not an object');
            break;
          case 'call': value = Reflect.apply(input[0], input[1], input.slice(2)); break;
          case 'construct': value = Reflect.construct(input[0], input.slice(2)); break;
          case 'binary': value = binary(data, input[0], input[1]); break;
          case 'unary': value = unary(data, input[0]); break;
          case 'increment': { let n = input[0]; if (data === 1) ++n; else --n; value = n; break; }
          case 'template': value = input[0] + `${input[1]}` + data; break;
          case 'closureLinear':
            value = linearTree(data.tree, input[0]);
            defineProperty(value, 'length', { value: data.arity, configurable: true });
            break;
          case 'closure': {
            const captured = input[0];
            value = (...callArgs) => execute(data.entry, callArgs, captured, contexts.at(-1) || context);
            defineProperty(value, 'length', { value: data.arity, configurable: true });
            defineProperty(value, 'name', { value: data.name, configurable: true });
            break;
          }
          case 'test':
            frame = { truth: data === 'undefined' ? input[0] === undefined : data === 'nullish' ? input[0] == null : !!input[0] };
            break;
          default: throw new AutoconfigProtocolError();
        }
        if (!frame) { values[operation.ref] = value; frame = { value: operation.ref }; }
      } catch (thrown) {
        // Infrastructure faults never enter the historical estimator's catch handlers.
        if (thrown instanceof AutoconfigProtocolError) throw thrown;
        frame = { thrown: put(thrown) };
        }
        if (owns(frame, 'thrown')) break;
      }
      const remapped = objectCreate(null);
      const remap = ref => {
        if (ref < 8_000_000_000_000_000) return ref;
        if (!owns(remapped, ref)) remapped[ref] = put(get(ref));
        return remapped[ref];
      };
      state = { ...state, env: remap(state.env), stack: state.stack.map(remap), catches: state.catches.map(c => [c[0], c[1], remap(c[2])]) };
      if (state.period) state.period = { ...state.period, seq: remap(state.period.seq) };
      if (owns(frame, 'value')) frame.value = remap(frame.value);
      // Live registers only: no processed-prefix history and no recursively copied input tree.
      const live = [state.env, ...state.stack, ...state.catches.map(c => c[2])];
      if (state.period) live[live.length] = state.period.seq;
      if (owns(frame, 'value')) live[live.length] = frame.value;
      if (owns(frame, 'thrown')) live[live.length] = frame.thrown;
      for (const key of objectKeys(values)) {
        const ref = +key;
        if (!apply(arrayIncludes, live, [ref])) { delete values[ref]; if (ref < 8_000_000_000_000_000) free[free.length] = ref; }
      }
      message = step(12, { state, frame });
    }
  }
  const globals = Object.create(globalThis);
  define(globals, '__stringify', value => { try { return JSON.stringify(value); } catch { return undefined; } });
  define(globals, '__strict', (op, args) => contexts.at(-1).strict(op, args));
  const exports = execute(0, [], globals, initialContext);
  return (name, args, context) => {
    contexts.push(context);
    try {
      if (!owns(exports, name)) throw new AutoconfigProtocolError();
      return args === undefined ? exports[name] : Reflect.apply(exports[name], undefined, args);
    } finally { contexts.pop(); }
  };
}
// Preserve the original module closure, including the public mutable candidate array.
// Each call and each callback still receives its own opaque-reference table.
let sharedEvaluator;
function invoke(name, args, wasmLoader) {
  const context = invocationContext(wasmLoader);
  sharedEvaluator ||= evaluator(context);
  return sharedEvaluator(name, args, context);
}
module.exports = { invoke, AutoconfigProtocolError };
