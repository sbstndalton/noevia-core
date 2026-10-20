'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Expose the lexical decoder only in this in-memory test module. The production
// bridge keeps its public export table and legacy validator unchanged.
function privateBridgeForTest() {
  const filename = path.join(__dirname, 'dav-parse-wasm.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const marker = 'module.exports = { llamacppPresetsValues';
  assert.ok(source.includes(marker), 'bridge export anchor is present');
  const instrumented = new Module(filename, module);
  instrumented.filename = filename;
  instrumented.paths = Module._nodeModulePaths(__dirname);
  instrumented._compile(source.replace(marker, 'module.exports = { autoconfigDeltaReply, llamacppPresetsValues'), filename);
  return instrumented.exports;
}

function freshHostForControl() {
  const filename = path.join(__dirname, 'llamacpp-autoconfig-host.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const fresh = new Module(filename, module);
  fresh.filename = filename;
  fresh.paths = Module._nodeModulePaths(__dirname);
  fresh._compile(source, filename);
  return fresh.exports;
}

function invokeHost(name, args, makeBusinessPort) {
  const isolatedHost = freshHostForControl();
  const businessPort = makeBusinessPort();
  let bootstrapReached = false, functionOneReached = false;
  const state = (pc, stack = []) => ({ pc, env: 1, stack, catches: [], mode: 2, target: 14, period: null, sum: null });
  const bootstrap = [
    { state: state(12), request: { op: 'object', data: null }, args: [], ref: 2 },
    { state: state(12), request: { op: 'closure', data: { entry: 1, arity: 0, name: 'anything' } }, args: [1], ref: 3 },
    { state: state(12), request: { op: 'literal', data: 'anything' }, args: [], ref: 4 },
    { state: state(12, [2]), request: { op: 'set', data: null }, args: [2, 4, 3], ref: 5 },
  ];
  const loader = () => ({ llamacppAutoconfig(op, frame) {
    if (op === 11 && frame.function === 0) {
      bootstrapReached = true;
      return { reply: { batch: bootstrap } };
    }
    if (op === 12 && bootstrapReached && !functionOneReached) return { reply: { done: 2 } };
    if (op === 11 && frame.function === 1) functionOneReached = true;
    return businessPort.llamacppAutoconfig(op, frame);
  } });
  const outcome = isolatedHost.invokeOutcome(name, args, loader);
  assert.equal(bootstrapReached, true, 'real exported invocation completed function-0 bootstrap');
  assert.equal(functionOneReached, true, 'real function-1 evaluator was entered');
  return outcome;
}

function tracedPrivateBridge() {
  const filename = path.join(__dirname, 'dav-parse-wasm.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const marker = 'module.exports = { llamacppPresetsValues';
  assert.ok(source.includes(marker), 'bridge export anchor is present');
  let instrumentedSource = source.replace("'use strict';", `\
'use strict';\
const __v2dTrace = [];\
const __v2dStringify = JSON.stringify, __v2dParse = JSON.parse, __v2dKeys = Object.keys, __v2dIsArray = Array.isArray;\
`);
  instrumentedSource = instrumentedSource
    .replace('const AUTOCONFIG_ATOM = JSON.stringify;', "const AUTOCONFIG_ATOM = value => { __v2dTrace.push(['atom', value]); return __v2dStringify(value); };")
    .replace('const AUTOCONFIG_PARSE = JSON.parse;', "const AUTOCONFIG_PARSE = text => { __v2dTrace.push(['parse', text]); return __v2dParse(text); };")
    .replace('const AUTOCONFIG_KEYS = Object.keys;', "const AUTOCONFIG_KEYS = value => { const keys = __v2dKeys(value); __v2dTrace.push(['keys', keys]); return keys; };")
    .replace('const AUTOCONFIG_ARRAY = Array.isArray;', "const AUTOCONFIG_ARRAY = value => { const result = __v2dIsArray(value); __v2dTrace.push(['array', result]); return result; };")
    .replace('function invokeRaw(input, call, max = MAX_INPUT_BYTES) {', "function invokeRaw(input, call, max = MAX_INPUT_BYTES) { __v2dTrace.push(['input', Array.from(input)]);")
    .replace(marker, 'module.exports = { __v2dTrace, llamacppAutoconfig, autoconfigDeltaReply, DavParseError, llamacppPresetsValues');
  const instrumented = new Module(filename, module);
  instrumented.filename = filename;
  instrumented.paths = Module._nodeModulePaths(__dirname);
  instrumented._compile(instrumentedSource, filename);
  return instrumented.exports;
}
const bridge = privateBridgeForTest();
const tuple = (pc = 12, stack = []) => [pc, 7, stack, [], 2, 14, null, null];
function row(delta, request = { op: 'literal', data: 'value' }, args = [], ref = 2) {
  return [delta, request, args, ref];
}
function fullRow(state, request, args = [], ref = 2) { return row([255, ...state], request, args, ref); }

test('v2d preflight captures grammar and bounded lengths without reading request.data or expanding states', () => {
  let lengthReads = 0, opReads = 0, dataReads = 0, cellReads = 0;
  const shared = new Proxy([1], { get(target, key, receiver) {
    if (key === 'length') lengthReads++;
    if (key === '0') cellReads++;
    return Reflect.get(target, key, receiver);
  } });
  const request = { get op() { opReads++; return 'literal'; }, get data() { dataReads++; return 'never preflight'; } };
  const first = fullRow(tuple(12, shared), request, shared, 2);
  const next = row([1, 13], { op: 'literal', data: 'next' }, [], 3);
  const packet = { wire: 'state-v2d', batch: [first, next] };
  const originalBatch = packet.batch, originalFirst = packet.batch[0], originalDelta = originalFirst[0];
  const decoded = bridge.autoconfigDeltaReply(packet);
  assert.equal(decoded.wire, 'state-v2d');
  assert.equal(decoded.batch, originalBatch);
  assert.equal(decoded.batch[0], originalFirst);
  assert.equal(decoded.batch[0][0], originalDelta);
  assert.equal(Object.getPrototypeOf(decoded), null);
  assert.equal(Object.getPrototypeOf(decoded.stateDeltas), null);
  assert.equal(Object.getPrototypeOf(decoded.stateDeltas[0]), null);
  assert.equal(Object.hasOwn(decoded.stateDeltas[0], 'state'), false);
  assert.equal(decoded.batchCount, 2);
  assert.equal(decoded.stateDeltas[0].argsCount, 1);
  assert.equal(decoded.stateDeltas[1].fields[0], 13);
  assert.equal(lengthReads, 1, 'the shared parser-owned vector length is read once');
  assert.equal(opReads, 1, 'request.op is preflighted once');
  assert.equal(dataReads, 0, 'request.data is never touched during preflight');
  assert.equal(cellReads, 3, 'shared cell is validated in stack, args, and inherited stack positions');
  originalDelta[1] = 999;
  assert.equal(decoded.stateDeltas[0].fields[0], 12, 'captured changed scalars survive later packet mutation');
});

test('a malformed last row fails before any request.data getter is touched', () => {
  let dataReads = 0;
  const request = { op: 'literal', get data() { dataReads++; return 'x'; } };
  const packet = { wire: 'state-v2d', batch: [fullRow(tuple(), request), row([256], { op: 'literal', data: null })] };
  assert.throws(() => bridge.autoconfigDeltaReply(packet), error => error instanceof bridge.DavParseError && error.reason === 'reply');
  assert.equal(dataReads, 0);
});

test('live successful result reference is read twice after the preflight read', () => {
  let refReads = 0, opReads = 0, dataReads = 0, finalFrame;
  const request = { get op() { opReads++; return 'literal'; }, get data() { dataReads++; return 'ok'; } };
  const operation = fullRow(tuple(), request, [], 2);
  Object.defineProperty(operation, '3', { configurable: true, enumerable: true, get() { refReads++; return 2; } });
  const decoded = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [operation] });
  const outcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, args) {
    if (op === 11) return { reply: decoded };
    finalFrame = args.frame;
    return { reply: { done: args.frame.value } };
  } }));
  assert.equal(outcome.value, 'ok');
  assert.equal(refReads, 3, 'one preflight read and two independent successful store/frame reads');
  assert.equal(opReads, 2, 'separate preflight and dispatch reads');
  assert.equal(dataReads, 1, 'one late request.data read');
  assert.deepEqual(finalFrame, { value: 2 });
});

test('user data getter throw has identity and performs no late operation.ref reads', () => {
  const marker = new Error('user-data-stop');
  let refReads = 0, dataReads = 0, finalFrame;
  const request = { op: 'literal', get data() { dataReads++; throw marker; } };
  const operation = fullRow(tuple(), request, [], 2);
  Object.defineProperty(operation, '3', { configurable: true, enumerable: true, get() { refReads++; return 2; } });
  const decoded = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [operation] });
  const outcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, args) {
    if (op === 11) return { reply: decoded };
    finalFrame = args.frame;
    return { reply: { done: args.frame.thrown } };
  } }));
  assert.equal(outcome.value, marker);
  assert.equal(finalFrame.thrown, 2);
  assert.equal(refReads, 1, 'only the separate preflight read occurs on throw');
  assert.equal(dataReads, 1);
});

test('first user throw sends the last executed state, not the later batch state', () => {
  const marker = new Error('middle-stop');
  const first = fullRow(tuple(10), { op: 'literal', data: 'first' }, [], 2);
  const middle = row([1, 20], { op: 'throw', get data() { throw marker; } }, [], 3);
  const last = row([1, 30], { op: 'literal', data: 'unreached' }, [], 4);
  const decoded = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [first, middle, last] });
  let continuation;
  const outcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, args) {
    if (op === 11) return { reply: decoded };
    continuation = args;
    return { reply: { done: args.frame.thrown } };
  } }));
  assert.equal(outcome.value, marker);
  assert.equal(continuation.state.pc, 20);
  assert.equal(continuation.frame.thrown, 2);
});


test('negative native PC is rejected before any business data getter', () => {
  let dataReads = 0;
  const first = fullRow(tuple(), { op: 'literal', get data() { dataReads++; return 'first'; } });
  const last = row([1, -1], { op: 'literal', data: 'bad-pc' }, [], 3);
  assert.throws(() => bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [first, last] }),
    error => error instanceof bridge.DavParseError && error.reason === 'reply');
  assert.equal(dataReads, 0);
});

test('parser lengths reject negative, fractional and non-finite proxy values', () => {
  for (const length of [-1, 1.5, NaN]) {
    const hostile = new Proxy([], { get(target, key, receiver) {
      if (key === 'length') return length;
      return Reflect.get(target, key, receiver);
    } });
    const packet = { wire: 'state-v2d', batch: [fullRow(tuple(12, hostile), { op: 'literal', data: null })] };
    assert.throws(() => bridge.autoconfigDeltaReply(packet), error => error instanceof bridge.DavParseError && error.reason === 'reply');
  }
});

test('new decoder rejects object-valued Proxy lengths without Number hooks or coercion', () => {
  let coercions = 0, indexReads = 0, dataReads = 0;
  const hostileLength = { valueOf() { coercions++; return coercions < 4 ? 1 : 1_000_000; } };
  const batch = new Proxy([], { get(target, key, receiver) {
    if (key === 'length') return hostileLength;
    if (typeof key === 'string' && /^\d+$/.test(key)) { indexReads++; return fullRow(tuple(), { op: 'literal', get data() { dataReads++; return 'unread'; } }); }
    return Reflect.get(target, key, receiver);
  } });
  const original = Number.isSafeInteger;
  Number.isSafeInteger = () => true;
  try {
    assert.throws(() => bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch }),
      error => error instanceof bridge.DavParseError && error.reason === 'reply');
  } finally { Number.isSafeInteger = original; }
  assert.equal(coercions, 0);
  assert.equal(indexReads, 0);
  assert.equal(dataReads, 0);
});

test('new decoder rejects boxed masks and references without numeric coercion', () => {
  let coercions = 0, dataReads = 0;
  const boxed = { valueOf() { coercions++; return 255; } };
  const maskRow = fullRow(tuple(), { op: 'literal', get data() { dataReads++; return 'unread'; } });
  maskRow[0][0] = boxed;
  const referenceRow = fullRow(tuple(), { op: 'literal', get data() { dataReads++; return 'unread'; } }, [boxed]);
  const original = Number.isSafeInteger;
  Number.isSafeInteger = () => true;
  try {
    for (const row of [maskRow, referenceRow]) assert.throws(
      () => bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [row] }),
      error => error instanceof bridge.DavParseError && error.reason === 'reply');
  } finally { Number.isSafeInteger = original; }
  assert.equal(coercions, 0);
  assert.equal(dataReads, 0);
});

test('each parser-owned proxy length is snapshotted once even when it changes', () => {
  let lengthReads = 0;
  const changing = new Proxy([], { get(target, key, receiver) {
    if (key === 'length') return ++lengthReads === 1 ? 0 : 1;
    return Reflect.get(target, key, receiver);
  } });
  const decoded = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [fullRow(tuple(12, changing), { op: 'literal', data: null })] });
  assert.equal(lengthReads, 1);
  assert.equal(decoded.stateDeltas[0].stackCount, 0);
});


test('a live row-selection trap is branded as a protocol fault', () => {
  const operation = fullRow(tuple(), { op: 'literal', data: 'never reached' });
  const decoded = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [operation] });
  Object.defineProperty(operation, '1', { configurable: true, get() { throw new Error('row-selection-trap'); } });
  const outcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, args) {
    if (op === 11) return { reply: decoded };
    return { reply: { done: args.frame.value } };
  } }));
  assert.equal(typeof outcome.fault, 'object');
  assert.equal(outcome.value, undefined);
});


test('same parser-owned row and argument proxy lengths are not reread by the host', () => {
  let rowLengthReads = 0, argsLengthReads = 0;
  const operation = new Proxy(fullRow(tuple(), { op: 'literal', data: 'proxy-lengths' }, []), {
    get(target, key, receiver) {
      if (key === 'length') rowLengthReads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const args = operation[2];
  operation[2] = new Proxy(args, { get(target, key, receiver) {
    if (key === 'length') argsLengthReads++;
    return Reflect.get(target, key, receiver);
  } });
  const decoded = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [operation] });
  assert.equal(rowLengthReads, 1);
  assert.equal(argsLengthReads, 1);
  const outcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, call) {
    if (op === 11) return { reply: decoded };
    return { reply: { done: call.frame.value } };
  } }));
  assert.equal(outcome.value, 'proxy-lengths');
  assert.equal(rowLengthReads, 1);
  assert.equal(argsLengthReads, 1);
});

test('legacy private reply batch remains accepted by a direct host port', () => {
  const operation = { state: { pc: 12, env: 1, stack: [], catches: [], mode: 2, target: 14, period: null, sum: null },
    request: { op: 'literal', data: 'legacy-v1' }, args: [], ref: 2 };
  const outcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, call) {
    if (op === 11) return { reply: { batch: [operation] } };
    return { reply: { done: call.frame.value } };
  } }));
  assert.equal(outcome.value, 'legacy-v1');
});


test('nested period and sum zero references retain the legacy remap identity path', () => {
  const state = tuple();
  state[6] = { seq: 0, return_pc: 0, len: 0, p: 0, i: 0, need: 0, chunks: [] };
  state[7] = { cache: { seq: 0 }, raw: [0, 0, 0, 0, 0, 0, 0, 0], numbers: [0, 0, 0, 0, 0, 0], total: 0 };
  const decoded = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [fullRow(state, { op: 'literal', data: 'zero-nested' })] });
  const outcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, call) {
    if (op === 11) return { reply: decoded };
    assert.equal(call.state.period.seq, 0);
    assert.equal(call.state.sum.cache.seq, 0);
    assert.deepEqual(call.state.sum.raw, [0, 0, 0, 0, 0, 0, 0, 0]);
    return { reply: { done: call.frame.value } };
  } }));
  assert.equal(outcome.value, 'zero-nested');
});


test('last-row op, ref and arg failures all precede the first business data getter', () => {
  for (const makeBadRow of [
    () => row([0], { op: 17, data: null }, [], 3),
    () => row([0], { op: 'literal', data: null }, [], -1),
    () => row([0], { op: 'literal', data: null }, [0], 3),
  ]) {
    let dataReads = 0;
    const first = fullRow(tuple(), { op: 'literal', get data() { dataReads++; return 'first'; } });
    const packet = { wire: 'state-v2d', batch: [first, makeBadRow()] };
    assert.throws(() => bridge.autoconfigDeltaReply(packet), error => error instanceof bridge.DavParseError && error.reason === 'reply');
    assert.equal(dataReads, 0);
  }
});

test('earlier data getter changes to later argument cells remain live', () => {
  const args = [1, 1];
  const firstValue = function () { return 'live-argument'; };
  const first = fullRow(tuple(), { op: 'literal', get data() { args[0] = 2; args[1] = 2; return firstValue; } }, [], 2);
  const later = row([0], { op: 'call', data: null }, args, 3);
  const decoded = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [first, later] });
  const outcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, call) {
    if (op === 11) return { reply: decoded };
    return { reply: { done: call.frame.value } };
  } }));
  assert.equal(outcome.value, 'live-argument');
});

test('earlier data getter changes to later valid and invalid result refs are observed', () => {
  const validFirst = fullRow(tuple(), { op: 'literal', get data() { validLater[3] = 2; return 'first'; } }, [], 2);
  const validLater = row([0], { op: 'literal', data: 'live-result-ref' }, [], 3);
  const valid = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [validFirst, validLater] });
  const validOutcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, call) {
    if (op === 11) return { reply: valid };
    return { reply: { done: call.frame.value } };
  } }));
  assert.equal(validOutcome.value, 'live-result-ref');

  const invalidArgs = [1];
  const badArgsFirst = fullRow(tuple(), { op: 'literal', get data() { invalidArgs[0] = 0; return 'first'; } }, [], 2);
  const badArgsLater = row([0], { op: 'literal', data: 'unreached' }, invalidArgs, 3);
  const badArgs = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [badArgsFirst, badArgsLater] });
  const badArgsOutcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, call) {
    if (op === 11) return { reply: badArgs };
    return { reply: { done: call.frame.value } };
  } }));
  assert.equal(badArgsOutcome.fault.name, 'AutoconfigProtocolError');

  const badRefFirst = fullRow(tuple(), { op: 'literal', get data() { badRefLater[3] = -1; return 'first'; } }, [], 2);
  const badRefLater = row([0], { op: 'literal', data: 'unreached' }, [], 3);
  const badRef = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [badRefFirst, badRefLater] });
  const badRefOutcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, call) {
    if (op === 11) return { reply: badRef };
    return { reply: { done: call.frame.value } };
  } }));
  assert.equal(badRefOutcome.fault.name, 'AutoconfigProtocolError');
});

test('mask metadata is captured while vector cells stay live, and frozen packets are reusable', () => {
  const stack = [1], packet = { wire: 'state-v2d', batch: [fullRow(tuple(12, stack), { op: 'literal', data: 'ok' })] };
  const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const key of Object.keys(value)) freeze(value[key]);
      Object.freeze(value);
    }
    return value;
  };
  freeze(packet);
  const first = bridge.autoconfigDeltaReply(packet), again = bridge.autoconfigDeltaReply(packet);
  assert.equal(first.batch, packet.batch);
  assert.equal(again.batch, packet.batch);
  assert.equal(first.stateDeltas[0].mask, 255);
  assert.notEqual(first.stateDeltas[0], again.stateDeltas[0]);

  const mutableStack = [1];
  const mutablePacket = { wire: 'state-v2d', batch: [fullRow(tuple(12, mutableStack), { op: 'literal', data: 'ok' })] };
  const decoded = bridge.autoconfigDeltaReply(mutablePacket);
  mutablePacket.batch[0][0][0] = 0;
  mutableStack[0] = 8;
  const outcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, call) {
    if (op === 11) return { reply: decoded };
    assert.deepEqual(call.state.stack, [8]);
    return { reply: { done: call.frame.value } };
  } }));
  assert.equal(outcome.value, 'ok');
});

test('replaced row and args are checked against fixed preflight counts', () => {
  const original = fullRow(tuple(), { op: 'literal', data: 'old' }, [1]);
  const packet = { wire: 'state-v2d', batch: [original] };
  const decoded = bridge.autoconfigDeltaReply(packet);
  packet.batch[0] = row([0], { op: 'literal', data: 'replacement' }, [1], 2);
  const good = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, call) {
    if (op === 11) return { reply: decoded };
    return { reply: { done: call.frame.value } };
  } }));
  assert.equal(good.value, 'replacement');

  const short = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [fullRow(tuple(), { op: 'literal', data: 'old' }, [1])] });
  short.batch[0][2] = [];
  const bad = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, call) {
    if (op === 11) return { reply: short };
    return { reply: { done: call.frame.value } };
  } }));
  assert.equal(bad.fault.name, 'AutoconfigProtocolError');
});

test('host captures and bounds exposed delta metadata before use', () => {
  for (const [field, bad] of [['argsCount', -1], ['argsCount', 1.5], ['argsCount', Infinity],
    ['stackCount', -1], ['stackCount', 1.5], ['stackCount', Infinity],
    ['catchCount', -1], ['catchCount', 1.5], ['catchCount', Infinity]]) {
    let dataReads = 0;
    const decoded = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [fullRow(tuple(), {
      op: 'literal', get data() { dataReads++; return 'must not read'; },
    }, [1])] });
    decoded.stateDeltas[0][field] = bad;
    const outcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, call) {
      if (op === 11) return { reply: decoded };
      return { reply: { done: call.frame.value } };
    } }));
    assert.equal(outcome.fault.name, 'AutoconfigProtocolError', `${field}=${bad} is rejected at row selection`);
    assert.equal(dataReads, 0);
  }
});

test('host uses the selected numeric metadata snapshot after argument getters mutate it', () => {
  let descriptor;
  const args = new Proxy([1], { get(target, key, receiver) {
    if (key === '0' && descriptor) {
      descriptor.mask = 0;
      descriptor.argsCount = Infinity;
      descriptor.stackCount = Infinity;
      descriptor.catchCount = Infinity;
    }
    return Reflect.get(target, key, receiver);
  } });
  const decoded = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [fullRow(tuple(12, [1]), {
    op: 'literal', data: 'selected-state',
  }, args)] });
  descriptor = decoded.stateDeltas[0];
  const outcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, call) {
    if (op === 11) return { reply: decoded };
    assert.deepEqual(call.state.stack, [1]);
    return { reply: { done: call.frame.value } };
  } }));
  assert.equal(outcome.value, 'selected-state');
  assert.equal(descriptor.mask, 0);
  assert.equal(descriptor.argsCount, Infinity);
});

test('host delta path does not consult mutable Number.isSafeInteger after preflight', () => {
  const decoded = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [fullRow(tuple(), {
    op: 'literal', data: 'number-method-untouched',
  })] });
  const original = Number.isSafeInteger;
  let calls = 0;
  Number.isSafeInteger = () => { calls++; throw new Error('mutable Number hook'); };
  let outcome;
  try {
    outcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, call) {
      if (op === 11) return { reply: decoded };
      return { reply: { done: call.frame.value } };
    } }));
  } finally { Number.isSafeInteger = original; }
  assert.equal(calls, 0);
  assert.equal(outcome.value, 'number-method-untouched');
});

test('nested Sum remapping preserves the legacy spread and getter order', () => {
  const trace = [], cache = { get seq() { trace.push('cache.seq'); return 0; } };
  const raw = new Proxy([0, 0, 0, 0, 0, 0, 0, 0], { get(target, key, receiver) {
    if (key === 'length') trace.push('raw.length');
    return Reflect.get(target, key, receiver);
  } });
  const sum = { get cache() { trace.push('sum.cache'); return cache; }, get raw() { trace.push('sum.raw'); return raw; } };
  const decoded = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: [fullRow(tuple())] });
  decoded.stateDeltas[0].fields[7] = sum;
  const outcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, call) {
    if (op === 11) return { reply: decoded };
    return { reply: { done: call.frame.value } };
  } }));
  assert.equal(outcome.value, 'value');
  assert.deepEqual(trace, ['sum.cache', 'sum.raw', 'sum.cache', 'cache.seq', 'sum.cache', 'cache.seq', 'sum.raw', 'raw.length']);
});


test('actual private port keeps the original serializer input except its marker and parses the complete reply once', () => {
  const traced = tracedPrivateBridge();
  assert.equal(traced.llamacppAutoconfig.length, 2);
  const result = traced.llamacppAutoconfig(11, { function: 0, env: 1 });
  const trace = traced.__v2dTrace;
  const inputEvent = trace.find(event => event[0] === 'input');
  assert.ok(inputEvent);
  const bytes = Uint8Array.from(inputEvent[1]);
  assert.equal(bytes[0], 11);
  assert.equal(new TextDecoder().decode(bytes.subarray(1)), '{"function":0,"env":1,"wire":"state-v2d"}');
  const parseEvents = trace.filter(event => event[0] === 'parse');
  assert.equal(parseEvents.length, 1);
  assert.equal(parseEvents[0][1], result.text, 'the captured parser sees the whole actual reply text once');
  const inputIndex = trace.indexOf(inputEvent), parseIndex = trace.indexOf(parseEvents[0]);
  const serializerTrace = trace.slice(0, inputIndex);
  assert.deepEqual(serializerTrace, [
    ['array', false], ['keys', ['function', 'env', 'wire']],
    ['array', false], ['atom', 'function'], ['atom', 0],
    ['array', false], ['atom', 'env'], ['atom', 1],
    ['array', false], ['atom', 'wire'], ['atom', 'state-v2d'],
    ['array', false],
  ]);
  assert.ok(parseIndex > inputIndex);
  assert.equal(result.reply.wire, 'state-v2d');
});


test('live liveness scans the actual fresh mapped stack length after its define hook truncates it', () => {
  const start = tuple();
  const rows = [fullRow(start, { op: 'literal', data: 'r2' }, [], 2)];
  for (let ref = 3; ref <= 8; ref++) rows.push(row([0], { op: 'literal', data: 'r' + ref }, [], ref));
  rows.push(row([4, [8]], { op: 'literal', data: 'last' }, [], 9));
  const decoded = bridge.autoconfigDeltaReply({ wire: 'state-v2d', batch: rows });
  const originalDefine = Object.defineProperty;
  let continuations = 0, truncatedMappedStackValue;
  Object.defineProperty = function (target, key, descriptor) {
    const result = Reflect.apply(originalDefine, Object, [target, key, descriptor]);
    if (Array.isArray(target) && (key === 0 || key === '0') && descriptor.value === 8) {
      truncatedMappedStackValue = descriptor.value;
      target.length = 0;
    }
    return result;
  };
  let outcome;
  try {
    outcome = invokeHost('anything', [], () => ({ llamacppAutoconfig(op, call) {
      if (op === 11) return { reply: decoded };
      continuations++;
      if (continuations === 1) return { reply: { batch: [{
        state: { pc: 1, env: 1, stack: [], catches: [], mode: 2, target: 1, period: null, sum: null },
        request: { op: 'literal', data: 'must not read freed ref' }, args: [8], ref: 10,
      }] } };
      return { reply: { done: call.frame.value } };
    } }));
  } finally { Object.defineProperty = originalDefine; }
  assert.equal(truncatedMappedStackValue, 8, 'the hook truncates the actual mapped stack value 8');
  assert.equal(continuations, 1);
  assert.equal(outcome.fault.name, 'AutoconfigProtocolError', 'ref 8 must be freed after the mapped stack was truncated');
});
