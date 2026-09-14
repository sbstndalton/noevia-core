'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelManager } = require('./model-manager.cjs');

test('disabled manager rejects provider-specific operations', async () => {
  const manager = createModelManager({ kind: 'none', baseUrl: '', apiKey: '', fetchJson: async () => ({ ok: true }) });
  assert.equal(manager.enabled, false);
  await assert.rejects(manager.request('/api/v1/models'), /disabled/);
});

test('lemonade manager scopes URL and authentication', async () => {
  let call;
  const manager = createModelManager({
    kind: 'lemonade',
    baseUrl: 'http://inference.local/',
    apiKey: 'secret',
    fetchJson: async (...args) => {
      call = args;
      return { ok: true };
    },
  });
  await manager.request('/api/v1/models', { headers: { 'X-Test': 'yes' } }, 5000);
  assert.equal(call[0], 'http://inference.local/api/v1/models');
  assert.equal(call[1].headers.Authorization, 'Bearer secret');
  assert.equal(call[1].headers['X-Test'], 'yes');
  assert.equal(call[2], 5000);
});

test('pull sends model_name/recipe/checkpoint and a pollable job request', async () => {
  // Lemonade's /v1/pull 400s on {checkpoint} alone (model_name and recipe are
  // required to register an unknown HF checkpoint), and without
  // stream+subscribe=false it blocks on the whole download instead of
  // handing back a job id for /v1/downloads to poll.
  let call;
  const manager = createModelManager({
    kind: 'lemonade',
    baseUrl: 'http://inference.local',
    apiKey: '',
    fetchJson: async (...args) => {
      call = args;
      return { ok: true, body: { id: 'model:user.Qwen3-0.6B-GGUF-Q4_K_M' } };
    },
  });
  await manager.pull({ modelName: 'user.Qwen3-0.6B-GGUF-Q4_K_M', checkpoint: 'unsloth/Qwen3-0.6B-GGUF:Q4_K_M', recipe: 'llamacpp' });
  assert.equal(call[0], 'http://inference.local/api/v1/pull');
  const body = JSON.parse(call[1].body);
  assert.deepEqual(body, {
    model_name: 'user.Qwen3-0.6B-GGUF-Q4_K_M',
    checkpoint: 'unsloth/Qwen3-0.6B-GGUF:Q4_K_M',
    recipe: 'llamacpp',
    stream: true,
    subscribe: false,
  });
});

test('hardware query uses only the configured inference endpoint with bounded timeout',async()=>{
 let call;const manager=createModelManager({kind:'lemonade',baseUrl:'http://synthetic-manager',apiKey:'test-only',fetchJson:async(...args)=>{call=args;return{ok:true};}});
 await manager.systemInfo();assert.equal(call[0],'http://synthetic-manager/v1/system-info');assert.equal(call[1].body,undefined);assert.equal(call[2],8000);
});
test('hardware report keeps shared pools separate and drops private metadata',()=>{
 const {modelHardware}=require('./model-hardware.cjs');
 const result=modelHardware({'Physical Memory':'32 GB',model_storage:{path:'/private/model/path'},cloud:{key:'PRIVATE_CANARY'},devices:{cpu:{name:'Synthetic CPU'},amd_gpu:[{name:'Integrated GPU',available:true,vram_gb:2,virtual_mem_gb:16}],nvidia_gpu:[{name:'Unavailable',available:false,vram_gb:24}]}});
 assert.equal(result.systemGB,32);assert.equal(result.gpus.length,1);assert.equal(result.gpus[0].capacityGB,2);assert.equal(result.gpus[0].sharedGB,16);assert.ok(!JSON.stringify(result).includes('PRIVATE_CANARY'));assert.ok(!JSON.stringify(result).includes('/private/'));
});
test('malformed and ambiguous hardware values stay unknown',()=>{
 const {modelHardware}=require('./model-hardware.cjs');assert.throws(()=>modelHardware(null));
 const result=modelHardware({'Physical Memory':'32',devices:{amd_gpu:[{name:'GPU',available:true,vram_gb:NaN,virtual_mem_gb:-2}]}});
 assert.equal(result.systemGB,null);assert.equal(result.gpus[0].capacityGB,null);assert.equal(result.gpus[0].sharedGB,null);
});
