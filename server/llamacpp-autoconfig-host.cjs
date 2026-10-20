'use strict';
// A mechanical ECMAScript host for Rust's stateless evaluator. No estimator,
// policy table, candidate traversal, arithmetic expression or conservative decision lives here.
// Values (including strings of any length) remain opaque host references.
const { build: buildLinearFamily } = require('./llamacpp-autoconfig-linear-family.cjs');
const { create: createRegExpLiteral } = require('./llamacpp-autoconfig-regexp-literals.cjs');
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
const defineProperty = Object.defineProperty;
const arrayIsArray = Array.isArray;
const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const isProxy = require('node:util').types.isProxy;
const NativeDataView = DataView, NativeArrayBuffer = ArrayBuffer, nativeBigInt = BigInt;
const getFloat64 = DataView.prototype.getFloat64, setFloat64 = DataView.prototype.setFloat64;
const getBigUint64 = DataView.prototype.getBigUint64, setBigUint64 = DataView.prototype.setBigUint64;
const bigintString = BigInt.prototype.toString;
const owns = (object, name) => apply(hasOwn, object, [name]);
const define = (object, key, value) => {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
  return object;
};
function privateMap(array, transform, start = 0) {
  const result = [];
  for (let index=start;index<array.length;index++) define(result,index-start,transform(array[index],index));
  return result;
}
const privateSlice = (array,start) => privateMap(array,value=>value,start);
// These vectors never cross a wire or dynamic reflection boundary. A fresh
// null-prototype literal avoids inherited numeric setters without invoking a
// mutable native method; captured apply consumes the same indexed values.
function privateArgs(array, transform) {
  const result = { __proto__: null, length: 0 };
  let length = 0;
  for (let index = 0; index < array.length; index++) result[length++] = transform(array[index], index);
  result.length = length;
  return result;
}
function privateArgsBounded(array, count, transform) {
  const result = { __proto__: null, length: 0 };
  let length = 0;
  for (let index = 0; index < count; index++) result[length++] = transform(array[index], index);
  result.length = length;
  return result;
}
function privateMapBounded(array, count, transform, start = 0) {
  const result = [];
  for (let index = start; index < count; index++) define(result, index - start, transform(array[index], index));
  return result;
}
function privateSafeInteger(value, minimum, maximum) {
  return typeof value === 'number' && value >= minimum && value <= maximum && value % 1 === 0;
}

function binary(operator, a, b, fault) {
  switch (operator) {
    case '+': return a + b; case '-': return a - b; case '*': return a * b;
    case '/': return a / b; case '%': return a % b; case '**': return a ** b;
    case '>': return a > b; case '>=': return a >= b; case '<': return a < b; case '<=': return a <= b;
    case '===': return a === b; case '!==': return a !== b;
    case '==': return a == b; // eslint-disable-line eqeqeq
    case '!=': return a != b; // eslint-disable-line eqeqeq
    default: throw fault();
  }
}
function unary(operator, value, fault) {
  switch (operator) {
    case '!': return !value; case '+': return +value; case '-': return -value;
    case 'typeof': return typeof value; case 'void': return undefined;
    default: throw fault();
  }
}

// Build a composition of mechanical operations selected by Rust. There is no
// source evaluation and no input-dependent branch in these callback blocks.
// Ordinary control flow, including the period-search loop, remains in Rust.
function linearBinary(operator, left, right, fault) {
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
    default: throw fault();
  }
}
function linearUnary(operator, value, fault) {
  switch (operator) {
    case '!': return (a,b,c) => !value(a,b,c);
    case '+': return (a,b,c) => +value(a,b,c);
    case '-': return (a,b,c) => -value(a,b,c);
    case 'typeof': return (a,b,c) => typeof value(a,b,c);
    case 'void': return (a,b,c) => void value(a,b,c);
    default: throw fault();
  }
}
function linearTreeComposed(tree, environment, fault) {
  const op=tree[0], data=tree[1];
  switch (op) {
    case 'arg':
      if (data === 0) return a => a;
      if (data === 1) return (a,b) => b;
      if (data === 2) return (a,b,c) => c;
      throw fault();
    case 'undefined': return () => undefined;
    case 'literal': return () => data;
    case 'load': return () => environment[data];
    case 'binary': return linearBinary(data, linearTreeComposed(tree[2], environment, fault), linearTreeComposed(tree[3], environment, fault), fault);
    case 'unary': return linearUnary(data, linearTreeComposed(tree[2], environment, fault), fault);
    case 'get': {
      const object = linearTreeComposed(data, environment, fault), key = linearTreeComposed(tree[2], environment, fault);
      return (a,b,c) => object(a,b,c)[key(a,b,c)];
    }
    case 'method': {
      const object = linearTreeComposed(data, environment, fault), key = linearTreeComposed(tree[2], environment, fault);
      const arguments_ = privateArgs(tree[3],argument => linearTreeComposed(argument, environment, fault));
      return (a,b,c) => {
        const receiver = object(a,b,c), fn = receiver[key(a,b,c)];
        return apply(fn, receiver, privateArgs(arguments_,argument => argument(a,b,c)));
      };
    }
    case 'call': {
      const fn = linearTreeComposed(data, environment, fault);
      const arguments_ = privateArgs(tree[2],argument => linearTreeComposed(argument, environment, fault));
      return (a,b,c) => {
        const callee = fn(a,b,c);
        return apply(callee, undefined, privateArgs(arguments_,argument => argument(a,b,c)));
      };
    }
    default: throw fault();
  }
}

function linearTree(tree, environment, fault) {
  return buildLinearFamily(tree, environment) || linearTreeComposed(tree, environment, fault);
}



// Number payloads preserve raw bits. Collection methods execute through the
// original program rather than a host-side identity or shape assumption.
function numberBits(value) {
  const view = new NativeDataView(new NativeArrayBuffer(8));
  apply(setFloat64, view, [0, value, false]);
  const text = apply(bigintString, apply(getBigUint64, view, [0, false]), [16]);
  return ('0000000000000000' + text).slice(-16);
}
function bitsNumber(text) {
  const view = new NativeDataView(new NativeArrayBuffer(8));
  apply(setBigUint64, view, [0, nativeBigInt('0x' + text), false]);
  return apply(getFloat64, view, [0, false]);
}
function booleanArrayFacts(value) {
  // Method spelling cannot prove brand or behavior: periodOf must perform
  // the original every lookups, calls and callbacks.
  return { safe: false };
}

// Only the already-evaluated scalar Sum asks for these fresh prefix facts.
// No method/brand/length lookup or coercion occurs; proof failure uses the
// original sum loop. Until chunks are consumed, all remaining work is private
// bookkeeping and primitive numeric arithmetic, with no user callback or yield.
function ownBooleanPrefixFacts(value, count, fault) {
  if (typeof count !== 'number' || count < 0 || count > 9007199254740991 || count % 1 !== 0) throw fault();
  if (value === null || typeof value !== 'object' || isProxy(value)) return { safe: false };
  for (let index = 0; index < count; index++) {
    const descriptor = getOwnDescriptor(value, index);
    if (!descriptor || !owns(descriptor, 'value') || typeof descriptor.value !== 'boolean') return { safe: false };
  }
  return { safe: true, len: count };
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
  const faults = new WeakSet();
  const fault = cause => { const error = new AutoconfigProtocolError(cause); faults.add(error); return error; };
  return {
    fault,
    isFault: error => (typeof error === 'object' && error !== null) && faults.has(error),
    step(op, frame) {
      try {
        module ||= wasmLoader();
        return module.llamacppAutoconfig(op, frame).reply;
      } catch (cause) { throw fault(cause); }
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
    const fault = cause => context.fault(cause);
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
      if (!owns(values, ref)) throw context.fault();
      return values[ref];
    };
    const environment = Object.create(parent);
    define(environment, '@args', args);
    let message = step(11, { function: functionId, env: put(environment) });
    for (;;) {
      if (!message || typeof message !== 'object') throw context.fault();
      if (owns(message, 'done')) return get(message.done);
      if (owns(message, 'throw')) throw get(message.throw);
      const deltaWire = message.wire === 'state-v2d';
      const batch = deltaWire ? message.batch : undefined;
      let batchCount;
      if (deltaWire) {
        batchCount = message.batchCount;
        if (!arrayIsArray(batch) || !privateSafeInteger(batchCount, 1, 32)
          || !message.stateDeltas || typeof message.stateDeltas !== 'object') throw context.fault();
      } else if (!arrayIsArray(message.batch) || message.batch.length < 1 || message.batch.length > 32) throw context.fault();
      let state, frame, activeState = deltaWire ? [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined] : null;
      let lastStackCount = 0, lastCatchCount = 0, hasSelectedDelta = false;
      for (let operationIndex=0;deltaWire ? operationIndex<batchCount : operationIndex<message.batch.length;operationIndex++) {
        let operation, request, references, descriptor, argsCount;
        if (deltaWire) {
          try {
            operation = batch[operationIndex];
            descriptor = message.stateDeltas[operationIndex];
            if (!descriptor || typeof descriptor !== 'object') throw context.fault();
            const mask = descriptor.mask, selectedArgsCount = descriptor.argsCount;
            const selectedStackCount = descriptor.stackCount, selectedCatchCount = descriptor.catchCount;
            const fields = descriptor.fields;
            if (!privateSafeInteger(mask, 0, 255)
              || !privateSafeInteger(selectedArgsCount, 0, 256)
              || !privateSafeInteger(selectedStackCount, 0, 256)
              || !privateSafeInteger(selectedCatchCount, 0, 8)
              || !fields || typeof fields !== 'object') throw context.fault();
            argsCount = selectedArgsCount;
            lastStackCount = selectedStackCount;
            lastCatchCount = selectedCatchCount;
            hasSelectedDelta = true;
            for (let bit = 0; bit < 8; bit++) if (mask & (1 << bit)) activeState[bit] = fields[bit];
            const operationLength = operation === descriptor.row ? 4 : (arrayIsArray(operation) ? operation.length : 0);
            if (!arrayIsArray(operation) || !privateSafeInteger(operationLength, 4, 4)) throw context.fault();
            request = operation[1]; references = operation[2];
            if (!request || typeof request !== 'object' || arrayIsArray(request) || !arrayIsArray(references)) throw context.fault();
            if (references !== descriptor.args) {
              const currentLength = references.length;
              if (!privateSafeInteger(currentLength, argsCount, 9_007_199_254_740_991)) throw context.fault();
            }
          } catch (error) { if (context.isFault(error)) throw error; throw context.fault(); }
        } else {
          operation = message.batch[operationIndex];
          const { request: legacyRequest, args: legacyReferences } = operation;
          request = legacyRequest; references = legacyReferences; state = operation.state;
          if (!state || !request || !arrayIsArray(references)) throw context.fault();
        }
        frame = undefined;
        try {
        const input = deltaWire
          ? privateArgsBounded(references, argsCount, reference => {
            if (!privateSafeInteger(reference, 1, 9_007_199_254_740_991)) throw context.fault();
            return get(reference);
          })
          : privateArgs(references,get);
        const data = request.data;
        const requestOp = request.op;
        if (deltaWire && typeof requestOp !== 'string') throw context.fault();
        let value;
        switch (requestOp) {
          case 'numberFacts': frame = { numbers: privateMap(input,value => value === null ? { kind: 'null' } : typeof value === 'number' ? { kind: 'number', bits: numberBits(value) } : { kind: 'other' }) }; break;
          case 'floatBits': value = bitsNumber(data); break;
          case 'booleanArrayFacts': frame = { facts: booleanArrayFacts(input[0]) }; break;
          case 'ownBooleanPrefixFacts': frame = { facts: ownBooleanPrefixFacts(input[0], data?.count, fault) }; break;
          case 'booleanChunk': frame = { bits: booleanChunk(input[0], data.start, data.count) }; break;
          case 'literal': value = data; break;
          case 'undefined': value = undefined; break;
          case 'regexp': {
            // Only compiler-bound literal metadata is accepted. No global
            // constructor or caller key coercion participates in literal creation.
            if (data === null || typeof data !== 'object' || isProxy(data) || arrayIsArray(data)) throw fault();
            const keys = objectKeys(data), pattern = getOwnDescriptor(data, 'pattern'), flags = getOwnDescriptor(data, 'flags');
            if (keys.length !== 2 || !pattern || !flags || !owns(pattern, 'value') || !owns(flags, 'value')
              || !pattern.enumerable || !flags.enumerable) throw fault();
            value = createRegExpLiteral(pattern.value, flags.value);
            if (value === undefined) throw fault();
            break;
          }
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
            if (!owner) throw context.fault();
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
              const keys=Reflect.ownKeys(source);
              for (let keyIndex=0;keyIndex<keys.length;keyIndex++) {
                const key=keys[keyIndex];
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
          case 'call': value = Reflect.apply(input[0], input[1], privateSlice(input,2)); break;
          case 'throw': throw input[0];
          case 'construct': value = Reflect.construct(input[0], privateSlice(input,2)); break;
          case 'binary': value = binary(data, input[0], input[1], fault); break;
          case 'unary': value = unary(data, input[0], fault); break;
          case 'increment': { let n = input[0]; if (data === 1) ++n; else --n; value = n; break; }
          case 'template': value = input[0] + `${input[1]}` + data; break;
          case 'closureLinear':
            value = linearTree(data.tree, input[0], fault);
            defineProperty(value, 'length', { value: data.arity, configurable: true });
            break;
          case 'closure': {
            const captured = input[0];
            value = (...callArgs) => execute(data.entry, callArgs, captured, contexts[contexts.length-1] || context);
            defineProperty(value, 'length', { value: data.arity, configurable: true });
            defineProperty(value, 'name', { value: data.name, configurable: true });
            break;
          }
          case 'test':
            frame = { truth: data === 'undefined' ? input[0] === undefined : data === 'nullish' ? input[0] == null : !!input[0] };
            break;
          default: throw context.fault();
        }
        if (!frame) {
          if (deltaWire) {
            const resultRef = operation[3];
            if (!privateSafeInteger(resultRef, 0, 9_007_199_254_740_991)) throw context.fault();
            values[resultRef] = value;
            const frameRef = operation[3];
            if (!privateSafeInteger(frameRef, 0, 9_007_199_254_740_991)) throw context.fault();
            frame = { value: frameRef };
          } else { values[operation.ref] = value; frame = { value: operation.ref }; }
        }
      } catch (thrown) {
        // Infrastructure faults never enter the historical estimator's catch handlers.
        if (context.isFault(thrown)) throw thrown;
        frame = { thrown: put(thrown) };
        }
        if (owns(frame, 'thrown')) break;
      }
      if (deltaWire) {
        if (!hasSelectedDelta) throw context.fault();
        state = { pc: activeState[0], env: activeState[1], stack: activeState[2], catches: activeState[3],
          mode: activeState[4], target: activeState[5], period: activeState[6], sum: activeState[7] };
      }
      const remapped = objectCreate(null);
      const remap = ref => {
        if (ref < 8_000_000_000_000_000) return ref;
        if (!owns(remapped, ref)) remapped[ref] = put(get(ref));
        return remapped[ref];
      };
      if (deltaWire) {
        const checkedReference = (ref, allowZero = false) => {
          if (!privateSafeInteger(ref, allowZero ? 0 : 1, 9_007_199_254_740_991)) throw context.fault();
          return remap(ref);
        };
        try {
          state = { ...state, env: checkedReference(state.env),
            stack: privateMapBounded(state.stack, lastStackCount, ref => checkedReference(ref)),
            catches: privateMapBounded(state.catches, lastCatchCount, tuple => {
              if (!arrayIsArray(tuple)) throw context.fault();
              let pc, depth, env;
              try { pc = tuple[0]; depth = tuple[1]; env = tuple[2]; } catch { throw context.fault(); }
              if (!privateSafeInteger(pc, -9_007_199_254_740_991, 9_007_199_254_740_991) || !privateSafeInteger(depth, -9_007_199_254_740_991, 9_007_199_254_740_991) || !privateSafeInteger(env, 1, 9_007_199_254_740_991)) throw context.fault();
              return [pc, depth, checkedReference(env)];
            }) };
          if (state.period) state.period = { ...state.period, seq: checkedReference(state.period.seq, true) };
          if (state.sum) {
            const checkedRaw = raw => {
              if (!arrayIsArray(raw)) throw context.fault();
              const rawCount = raw.length;
              if (!privateSafeInteger(rawCount, 0, 8) || (rawCount !== 0 && rawCount !== 8)) throw context.fault();
              return privateMapBounded(raw, rawCount, ref => checkedReference(ref, true));
            };
            state.sum = { ...state.sum, cache: { ...state.sum.cache, seq: checkedReference(state.sum.cache.seq, true) },
              raw: checkedRaw(state.sum.raw) };
          }
        } catch (error) { if (context.isFault(error)) throw error; throw context.fault(); }
      } else {
        state = { ...state, env: remap(state.env), stack: privateMap(state.stack,remap), catches: privateMap(state.catches,c => [c[0], c[1], remap(c[2])]) };
        if (state.period) state.period = { ...state.period, seq: remap(state.period.seq) };
        if (state.sum) state.sum = { ...state.sum, cache: { ...state.sum.cache, seq: remap(state.sum.cache.seq) }, raw: privateMap(state.sum.raw,remap) };
      }
      if (owns(frame, 'value')) frame.value = deltaWire
        ? (privateSafeInteger(frame.value, 0, 9_007_199_254_740_991) ? remap(frame.value) : (() => { throw context.fault(); })())
        : remap(frame.value);
      // Live registers only: no processed-prefix history and no recursively copied input tree.
      const live = [state.env];
      for(let i=0;i<state.stack.length;i++) define(live,live.length,state.stack[i]);
      for(let i=0;i<state.catches.length;i++) define(live,live.length,state.catches[i][2]);
      if (state.period) define(live,live.length,state.period.seq);
      if (state.sum) { define(live,live.length,state.sum.cache.seq); for (let i=0;i<state.sum.raw.length;i++) define(live,live.length,state.sum.raw[i]); }
      if (owns(frame, 'value')) define(live,live.length,frame.value);
      if (owns(frame, 'thrown')) define(live,live.length,frame.thrown);
      const valueKeys=objectKeys(values);
      for (let keyIndex=0;keyIndex<valueKeys.length;keyIndex++) {
        const key=valueKeys[keyIndex];
        const ref = +key;
        if (!apply(arrayIncludes, live, [ref])) { delete values[ref]; if (ref < 8_000_000_000_000_000) define(free,free.length,ref); }
      }
      message = step(12, { state, frame });
    }
  }
  const globals = Object.create(globalThis);
  define(globals, '__stringify', value => { try { return JSON.stringify(value); } catch { return undefined; } });
  define(globals, '__strict', (op, args) => contexts[contexts.length-1].strict(op, args));
  const exports = execute(0, [], globals, initialContext);
  return (name, args, context) => {
    define(contexts,contexts.length,context);
    try {
      if (!owns(exports, name)) throw context.fault();
      return args === undefined ? exports[name] : Reflect.apply(exports[name], undefined, args);
    } finally { contexts.length-=1; }
  };
}
// Preserve the original module closure, including the public mutable candidate array.
// Each call and each callback still receives its own opaque-reference table.
let sharedEvaluator;
function invokeOutcome(name, args, wasmLoader) {
  const context = invocationContext(wasmLoader);
  try {
    sharedEvaluator ||= evaluator(context);
    return { value: sharedEvaluator(name, args, context) };
  } catch (error) {
    if (context.isFault(error)) return { fault: error };
    throw error;
  }
}
module.exports = { invokeOutcome, AutoconfigProtocolError };
