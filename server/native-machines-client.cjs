'use strict';
// Private native owner client. Existing synchronous readers share one I/O worker; each
// bounded call has its own response buffer so a late reply cannot answer a newer request.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const CAP = 1024 * 1024;
const READ_DEADLINE = 2500;
const WRITE_DEADLINE = 20000;
const unavailable = () => Object.assign(Error('Inference machines are unavailable.'), { status: 503, code: 'machinesUnavailable' });
if (!isMainThread) {
  const { readCappedJson } = require('./http.cjs');
  parentPort.on('message', async ({ buffer, port, token, body, wait }) => {
    const control = new Int32Array(buffer, 0, 2);
    let answer;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/inference-machines`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-noevia-store-token': token }, body: JSON.stringify(body), signal: AbortSignal.timeout(wait - 100) });
      const value = await readCappedJson(r, CAP - 32);
      answer = { status: r.status, value };
    } catch { answer = { status: 503, value: { error: 'Inference machines are unavailable.', code: 'machinesUnavailable' } }; }
    const bytes = Buffer.from(JSON.stringify(answer));
    if (bytes.length > CAP) { Atomics.store(control, 0, -1); Atomics.notify(control, 0); return; }
    new Uint8Array(buffer, 8).set(bytes);
    Atomics.store(control, 1, bytes.length); Atomics.store(control, 0, 1); Atomics.notify(control, 0);
  });
  if (workerData?.ready) { const ready = new Int32Array(workerData.ready); Atomics.store(ready,0,1); Atomics.notify(ready,0); }
} else {
  let worker, configured, completedBuffer;
  function configure({port,token}) { if(configured) throw new Error('Native machines client is already configured.'); configured={port:Number(port),token}; }
  function call(body) {
    const port = configured?.port ?? Number(process.env.NOEVIA_PROJECT_STORE_PORT), token = configured?.token ?? process.env.NOEVIA_PROJECT_STORE_TOKEN;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || token.length < 32) throw unavailable();
    if (!worker) {
      const ready = new SharedArrayBuffer(4), state = new Int32Array(ready);
      worker = new Worker(__filename,{workerData:{ready}}); worker.on('error', () => { worker = null; }); worker.unref();
      // Starting the I/O worker is a separate one-time boot operation, before the RPC deadline.
      Atomics.wait(state,0,0,10000); if (Atomics.load(state,0)!==1) throw unavailable();
    }
    const buffer = completedBuffer || new SharedArrayBuffer(CAP + 8), control = new Int32Array(buffer, 0, 2);
    completedBuffer = null; Atomics.store(control,0,0); Atomics.store(control,1,0);
    const wait = ['mutate','tune','tuneAbort'].includes(body.op) ? WRITE_DEADLINE : READ_DEADLINE;
    worker.postMessage({ buffer, port, token, body, wait });
    const deadline = require('node:perf_hooks').performance.now() + wait;
    while (Atomics.load(control,0) === 0) { const left = deadline - require('node:perf_hooks').performance.now(); if(left <= 0) break; Atomics.wait(control,0,0,left); }
    if (Atomics.load(control, 0) !== 1) throw unavailable();
    completedBuffer = buffer;
    let answer; try { answer = JSON.parse(Buffer.from(buffer, 8, Atomics.load(control, 1)).toString('utf8')); } catch { throw unavailable(); }
    const { status, value } = answer;
    if (status !== 200 && !['mutate','tune','tuneAbort'].includes(body.op)) throw unavailable();
    if (status !== 200) throw Object.assign(Error(value?.error || 'Inference machines are unavailable.'), { ...value, status });
    if (!valid(body.op, value)) throw unavailable();
    return value;
  }
  async function callAsync(body) {
    const port = configured?.port ?? Number(process.env.NOEVIA_PROJECT_STORE_PORT), token = configured?.token ?? process.env.NOEVIA_PROJECT_STORE_TOKEN;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || token.length < 32) throw unavailable();
    let response, value;
    try {
      response = await fetch(`http://127.0.0.1:${port}/v1/inference-machines`, {method:'POST',headers:{'content-type':'application/json','x-noevia-store-token':token},body:JSON.stringify(body),signal:AbortSignal.timeout(WRITE_DEADLINE)});
      value = await require('./http.cjs').readCappedJson(response,CAP);
    } catch { throw unavailable(); }
    if (response.status !== 200) throw Object.assign(Error(value?.error || 'Inference machines are unavailable.'), {...value,status:response.status});
    if (!valid(body.op,value)) throw unavailable();
    return value;
  }
  function valid(op, value) {
    const object = value && typeof value === 'object' && !Array.isArray(value);
    const view = object && Array.isArray(value.machines) && Array.isArray(value.services);
    switch(op) {
      case 'session': return object && Number.isSafeInteger(value.epoch) && value.epoch > 0;
      case 'view': case 'mutate': return view;
      case 'machine': return value === null || object && ['id','name','address'].every(key => typeof value[key] === 'string');
      case 'assignmentOf': return object && typeof value.machine === 'string';
      case 'chatTarget': return value === null || object && typeof value.machine?.id === 'string' && typeof value.baseUrl === 'string' && typeof value.model === 'string' && Number.isInteger(value.port);
      case 'urlFor': return value === null || typeof value === 'string';
      case 'rerankTarget': return value === null || object && typeof value.url === 'string' && ['tei','llamacpp'].includes(value.protocol);
      case 'rerankProtocol': return value === null || ['tei','llamacpp'].includes(value);
      case 'embeddingMachine': return object && typeof value.machine === 'string' && (value.url === null || typeof value.url === 'string');
      case 'runtimeSource': return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
      case 'turnBegin': case 'turnEnd': return object && value.ok === true;
      case 'tune': case 'tuneStatus': case 'tuneAbort': return value === null || object && typeof value.id === 'string' && ['running','done','failed','aborted','interrupted'].includes(value.state);
      case 'tuneResult': return value === null || object && typeof value.machineId === 'string' && typeof value.model === 'string';
      default: return false;
    }
  }
  module.exports = { call, callAsync, configure };
}
