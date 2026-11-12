'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createInferenceMachineRoutes} = require('./routes/inference-machines.cjs');
const {createClient} = require('./rerank-settings.cjs');
const secret = 'synthetic-front-token-for-integration';
const env = {NOEVIA_PROJECT_STORE_PORT:'19091', NOEVIA_PROJECT_STORE_TOKEN:secret};
const view = {machines:[{id:'local',services:['reranker']}],services:[{id:'reranker',machine:'local'}]};
function probe(client) {
  let response, reads = 0;
  const route = createInferenceMachineRoutes({
    secret, json:(_res,status,body) => { response = {status,body}; },
    readJson:async () => { reads++; return {health:false,view}; },
    machines:{chatTarget:() => null},
    effective:{reranker:() => client.run(() => client.effectiveEnv().RERANK_BASE_URL)},
  });
  const request = headers => ({method:'POST',url:'/internal/inference-machines/probes',headers,socket:{remoteAddress:'127.0.0.1'}});
  return {async run(headers = {'x-noevia-store-token':secret}) {
    assert.equal(await route(request(headers),{}),true);
    return {...response,reads};
  }};
}
test('native machine probes await the E2 snapshot and refresh the effective URL on each call', async () => {
  let next = 0;
  const client = createClient({env,fetchImpl:async () => new Response(JSON.stringify({
    revision:'0'.repeat(32)+':'+(++next),
    env:{RERANK_API_KEY:'',RERANK_BASE_URL:`http://synthetic-${next}:8080`},
    view:{enabled:true,source:'deployment',choice:'tei',options:[]},
  }))});
  const p = probe(client);
  for (const n of [1,2]) {
    const response = await p.run();
    assert.equal(response.status,200);
    assert.deepEqual(response.body,{...view,services:[{...view.services[0],url:`http://synthetic-${n}:8080`}]});
  }
});
test('machine probes fail closed when the E2 native owner is unavailable', async () => {
  const client = createClient({env,fetchImpl:async () => { throw Error('synthetic outage'); }});
  const response = await probe(client).run();
  assert.equal(response.status,503);
  assert.deepEqual(response.body,{error:'Inference machine probes are unavailable.'});
});
test('machine probes retain private authentication before reading native settings', async () => {
  const p = probe({run:() => assert.fail('untrusted native read')});
  for (const headers of [{}, {'x-noevia-store-token':'wrong'}, {'x-noevia-store-token':secret,'x-forwarded-for':''}]) {
    const response = await p.run(headers);
    assert.equal(response.status,404);
    assert.equal(response.reads,0);
  }
});
