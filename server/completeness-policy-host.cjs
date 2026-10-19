'use strict';
// Mechanical host for the Rust completeness policy. No check names, statuses, transition
// tables, report templates, evidence-selection predicates or review decisions live here.
// Values stay behind per-invocation handles; each callback/reentrant report has its own frame.
const { DavParseError } = require('./dav-parse-wasm.cjs');
const MAX_FRAME_BYTES = 64 * 1024;
const METHODS = new Set(['filter', 'map', 'some', 'find', 'includes', 'join', 'every']);
const ENTRIES = new Set([0,1,2,3,4,5,6,10,11,12,13,14,15,16,17,18,19,20,21,22,23]);
const fail = () => { throw new DavParseError('completeness policy protocol refused', 'reply'); };
function executePolicy(port, entry, args, confirmation) {
  const values = [];
  function retain(value) {
    const id = values.length; values[id] = value;
    const kind = value === null ? 'null' : typeof value;
    const out = { ref: id, kind, truth: !!value };
    if (kind === 'string') { out.prefix = value.slice(0,64); out.length = value.length; }
    return out;
  }
  function raw(descriptor) {
    const id = descriptor?.ref;
    if (!Number.isSafeInteger(id) || id < 0 || id >= values.length) return fail();
    return values[id];
  }
  function inputs(list) {
    if (!Array.isArray(list) || list.length > 32) return fail();
    const out = [];
    for (let i = 0; i < list.length; i++) out[i] = raw(list[i]);
    return out;
  }
  function run(program, args) {
    if (!ENTRIES.has(program) || !Array.isArray(args) || args.length > 32) return fail();
    const registers = [];
    for (let i = 0; i < args.length; i++) registers[i] = retain(args[i]);
    let frame = { state: { program, pc: 0, registers } };
    for (;;) {
      // Only descriptors/continuations are serialized, never job objects, evidence or strings
      // beyond a fixed prefix. There is deliberately no total input/output acceptance cap.
      if (Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME_BYTES) return fail();
      const reply = port.completenessPolicy(frame);
      if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return fail();
      if (Object.hasOwn(reply,'done')) return raw(reply.done);
      if (Object.hasOwn(reply,'throw')) {
        if (typeof reply.throw?.message !== 'string') return fail();
        if(reply.throw.class==='TypeError')throw new TypeError(reply.throw.message);
        if(reply.throw.class!=='Error'||![400,502].includes(reply.throw.status))return fail();
        throw Object.assign(Error(reply.throw.message), {status: reply.throw.status});
      }
      const request = reply.request, continuation = reply.continuation;
      if (!request || !continuation || continuation.program !== program || !Number.isSafeInteger(continuation.pc)
        || continuation.pc <= frame.state.pc || continuation.pc > 512 || !Number.isSafeInteger(continuation.destination)
        || continuation.destination < 0 || continuation.destination >= 32
        || !Array.isArray(continuation.registers) || continuation.registers.length !== 32) return fail();
      let value;
      switch (request.operation) {
        case 'literal': value = request.value; break;
        case 'get': {
          const key = Object.hasOwn(request.key || {},'literal') ? request.key.literal : raw(request.key?.reference);
          value = raw(request.target)[key]; break;
        }
        case 'method': {
          if (!METHODS.has(request.name)) return fail();
          const target = raw(request.target), args = inputs(request.arguments);
          if (request.callback !== null) {
            const callback = request.callback;
            if (!callback || !ENTRIES.has(callback.program)) return fail();
            const captures = inputs(callback.captures);
            args[args.length] = (first) => run(callback.program, [first, ...captures]);
          }
          // A real property/method call retains getters, custom collection methods, sparse
          // iteration and callback invocation behavior, including synchronous exceptions.
          const method=target[request.name];
          if(typeof method!=='function'){if(typeof request.failure!=='string')return fail();throw new TypeError(request.failure);}
          value = Reflect.apply(method,target,args); break;
        }
        case 'evaluate': value = run(request.program, inputs(request.arguments)); break;
        case 'object': {
          if (!Array.isArray(request.fields) || request.fields.length > 16) return fail();
          value = {};
          for (const field of request.fields) {
            if (!Array.isArray(field) || field.length !== 2 || typeof field[0] !== 'string' || field[0] === '__proto__') return fail();
            Object.defineProperty(value,field[0],{value:raw(field[1]),enumerable:true,writable:true,configurable:true});
          }
          break;
        }
        case 'array': value = inputs(request.values); break;
        case 'template': {
          if (!Array.isArray(request.parts) || request.parts.length > 16) return fail();
          value = '';
          for (const part of request.parts) {
            value += Object.hasOwn(part,'literal') ? part.literal : `${raw(part.reference)}`;
          }
          break;
        }
        case 'identity': value = inputs(request.arguments)[0]; break;
        case 'undefined': value = undefined; break;
        case 'spread': {const expectedArtifacts=inputs(request.arguments)[0];value=[...expectedArtifacts];break;}
        case 'string': value = `${inputs(request.arguments)[0]}`; break;
        case 'greater_zero': value = inputs(request.arguments)[0] > 0; break;
        case 'is_array': value = Array.isArray(inputs(request.arguments)[0]); break;
        case 'json_stringify': value = JSON.stringify(inputs(request.arguments)[0]); break;
        case 'confirmation': value = confirmation(...inputs(request.arguments)); break;
        default: return fail();
      }
      frame = { state: continuation, answer: retain(value) };
    }
  }
  return run(entry,args);
}
module.exports = { executePolicy, MAX_FRAME_BYTES };
