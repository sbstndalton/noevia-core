'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountRoutes, REFUSAL } = require('./account.cjs');
test('native retention methods refuse without reading a body or touching state', async () => {
 const route = createAccountRoutes({ json: (_r,status,body)=>({status,body}), readJson:()=>{throw Error('body read')} });
 for (const method of ['GET','PUT']) {
  let answer;
  const handler = createAccountRoutes({json:(_r,status,body)=>{answer={status,body}},readJson:()=>{throw Error('body read')}});
  assert.equal(await handler({method},{},{path:'/api/account/retention',authn:{user:{role:'member'}}}),true);
  assert.deepEqual(answer,{status:503,body:REFUSAL});
 }
 assert.equal(await route({method:'PUT'},{},{path:'/api/account/retention/',authn:{}}),false);
});
test('unsupported methods retain authentication and lowercase method response', async () => {
 for(const method of ['HEAD','OPTIONS','POST','DELETE'])for(const signed of [false,true]){
  let answer;
  const route=createAccountRoutes({json:(_r,status,body)=>{answer={status,body}}});
  assert.equal(await route({method},{},{path:'/api/account/retention',authn:signed?{user:{role:'member'}}:null}),true);
  assert.deepEqual(answer,signed?{status:405,body:{error:'method not allowed'}}:{status:401,body:{error:'Sign in first'}});
 }
});
