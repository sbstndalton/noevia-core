'use strict';
// Synchronous projections are private calls to the native registry, with no stale/local fallback.
const crypto = require('node:crypto');

const KEY = 'inference:machines';
const LOCAL_ID = 'local';
/** Every part of noevia a machine can be named for, and how it moves. */
const SERVICES = Object.freeze({
  chatFast: { mode: 'chat', role: 'fast' },
  chatSmart: { mode: 'chat', role: 'smart' },
  chatCode: { mode: 'chat', role: 'code' },
  chatCreative: { mode: 'chat', role: 'creative' },
  vision: { mode: 'chat', role: 'vision' },
  decision: { mode: 'runtime' },
  sensitivity: { mode: 'runtime' },
  embedding: { mode: 'reindex' },
  reranker: { mode: 'runtime' },
  ocr: { mode: 'runtime' },
  documents: { mode: 'runtime' },
});
const SERVICE_IDS = Object.freeze(Object.keys(SERVICES));
/** #1840: the chat role -> its service id. */
const CHAT_ROLE_SERVICE = Object.freeze(Object.fromEntries(Object.entries(SERVICES).filter(([, d]) => d.mode === 'chat').map(([id, d]) => [d.role, id])));
function createInferenceMachines({ onChange = () => {} } = {}) {
  const { call, callAsync } = require('./native-machines-client.cjs');
  const epoch = call({ op: 'session' }).epoch;
  let sequence = 0;
  const ask = (op, args = {}) => call({ op, ...args });
  const mutate = (body, actor) => { const out = ask('mutate', { body, actor }); if(body.action === 'assign') onChange(String(body.service || '')); return out; };
  return {
    native: true,
    notifyChanges: services => { for(const service of services) onChange(service); },
    view: () => ask('view'),
    add: (body, actor) => callAsync({op:'mutate',body:{...body,action:'add'},actor}),
    update: async (body, actor) => { const before = ask('machine',{id:body.id}); const out = await callAsync({op:'mutate',body:{...body,action:'update'},actor}); if(before && before.address.toLowerCase() !== out.machine?.address?.toLowerCase()) for(const service of out.services || []) if(service.machine === out.machine.id) onChange(service.id); return out; },
    remove: (body, actor) => mutate({ ...body, action: 'remove' }, actor),
    assign: (body, actor) => mutate({ ...body, action: 'assign' }, actor),
    machine: id => ask('machine', { id }),
    assignmentOf: service => ask('assignmentOf', { service }),
    urlFor: service => ask('urlFor', { service }),
    chatTarget: role => ask('chatTarget', { role }),
    rerankProtocol: () => ask('rerankProtocol'),
    rerankTarget: () => ask('rerankTarget'),
    embeddingMachine: () => ask('embeddingMachine'),
    runtimeContextSource: () => ask('runtimeSource'),
    refreshRuntimeContextSource: () => ask('runtimeSource'),
    beginTurn: machine => {
      const token = crypto.randomUUID(), turnSequence = ++sequence;
      let done = false, pending = false;
      const release = () => {
        if (done || pending) return;
        try { ask('turnEnd', { epoch, token, sequence: turnSequence }); done = true; }
        catch { pending = true; setTimeout(() => { pending = false; release(); }, 1000).unref(); }
      };
      try { ask('turnBegin', { epoch, token, machine, sequence: turnSequence }); } catch (err) { release(); throw err; }
      return release;
    },
  };
}

module.exports = { createInferenceMachines, SERVICES, SERVICE_IDS, CHAT_ROLE_SERVICE, LOCAL_ID, KEY };
