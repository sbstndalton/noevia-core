'use strict';
const assert=require('node:assert/strict');
process.env.NOEVIA_PROJECT_STORE_PORT='7777';
process.env.NOEVIA_PROJECT_STORE_TOKEN='synthetic-native-token-0123456789abcdef';
const machines=require('../../server/inference-machines.cjs').createInferenceMachines();
for(const read of [()=>machines.view(),()=>machines.chatTarget('fast'),()=>machines.urlFor('decision'),()=>machines.assignmentOf('chatFast'),()=>machines.machine('missing'),()=>machines.runtimeContextSource()]) assert.throws(read,e=>e.status===503&&e.code==='machinesUnavailable');
const chat=require('../../server/chat-machines.cjs').createChatMachines({machines});
assert.throws(()=>chat.target('fast'),e=>e.status===503);
const decision=require('../../server/decision-settings.cjs').createDecisionSettings({store:{get:()=>null},env:{COWORK_DECISION_URL:'http://127.0.0.1:8040'},machineUrl:()=>machines.urlFor('decision')});
assert.throws(()=>decision.get(),e=>e.status===503);
// The reranker's settings and placement come from the native settings owner (it reads the machine
// registry itself); with no answer from it every read refuses, never the deployment's address.
const rerankModule=require('../../server/rerank-settings.cjs');
const rerank=rerankModule.createClient();
assert.throws(()=>rerank.effectiveEnv(),e=>e.status===503);
assert.throws(()=>require('../../server/rag.cjs').configureRerank(()=>rerank.effectiveEnv()),e=>e.status===503);
rerankModule.install(rerank);
assert.throws(()=>require('../../server/llamacpp-manager.cjs').keepAlongside(),e=>e.status===503);
const workers=require('../../server/document-workers.cjs');workers.useMachines(kind=>machines.urlFor(kind));
assert.throws(()=>workers.resolve('ocr'),e=>e.status===503);
assert.throws(()=>workers.assigned('documents'),e=>e.status===503);
(async()=>{await assert.rejects(rerank.run(()=>assert.fail('ran without reranker settings')),e=>e.status===503);await assert.rejects(require('../../server/rust-auto-roles.cjs').autoRolesState({servedCatalogue:async()=>[],remoteRoles:()=>({}),machineModels:()=>machines.chatTarget('fast')}),e=>e.status===503);await assert.rejects(require('../../server/machine-tune.cjs').createMachineTune().start({service:'chatFast',confirm:true,actor:'synthetic-admin'}),e=>e.status===503);})().catch(e=>{console.error(e);process.exitCode=1;});
