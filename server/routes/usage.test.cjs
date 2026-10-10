'use strict';
// The routes only decide who may ask for which scope; the numbers are tested in
// usage.test.cjs and usage-summary.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsageRoutes } = require('./usage.cjs');

function fixture({ role = 'member', aggregate = null, days = {} } = {}) {
  const sent = [];
  const json = (res, status, body) => { sent.push({ status, body }); return true; };
  const routes = createUsageRoutes({
    readUsage: () => ({ days }),
    usageDayKey: (at = new Date()) => at.toISOString().slice(0, 10),
    retentionDays: 30,
    workspace: () => ({ dir: '/tmp/nowhere' }),
    listUsers: () => (aggregate === 'throw' ? (() => { throw Error('too many'); })() : [{ id: 'a' }]),
    userDir: () => '/tmp/nowhere',
    json,
  });
  return { routes, sent, authn: { user: { id: 'u', role } } };
}

test('a member sees their own usage and is refused everyone else’s', async () => {
  const own = fixture({ days: { '2026-09-20': { input: 10, output: 5, replies: 1, models: {} } } });
  assert.equal(await own.routes({ method: 'GET' }, {}, { path: '/api/usage', authn: own.authn }), true);
  assert.equal(own.sent[0].status, 200);
  assert.equal(own.sent[0].body.allTime.input, 10);
  assert.ok(!('aggregate' in own.sent[0].body), 'a single account carries no aggregate block');

  const other = fixture();
  await other.routes({ method: 'GET' }, {}, { path: '/api/usage/aggregate', authn: other.authn });
  assert.equal(other.sent[0].status, 403);
});

test('an administrator gets the merged view, and a refusal when it cannot be read within limits', async () => {
  const admin = fixture({ role: 'admin' });
  await admin.routes({ method: 'GET' }, {}, { path: '/api/usage/aggregate', authn: admin.authn });
  assert.equal(admin.sent[0].status, 200);
  assert.equal(admin.sent[0].body.aggregate.accounts, 1);

  const broken = fixture({ role: 'admin', aggregate: 'throw' });
  await broken.routes({ method: 'GET' }, {}, { path: '/api/usage/aggregate', authn: broken.authn });
  assert.equal(broken.sent[0].status, 503);
  assert.match(broken.sent[0].body.error, /within its limits/);
});

test('anything that is not a usage GET is left alone or refused by method', async () => {
  const f = fixture();
  assert.equal(await f.routes({ method: 'GET' }, {}, { path: '/api/projects', authn: f.authn }), false);
  await f.routes({ method: 'POST' }, {}, { path: '/api/usage', authn: f.authn });
  assert.equal(f.sent[0].status, 405);
});

test('confirmed Rust usage ownership refuses every Node reporting method without reading',async()=>{
 const {enabledFrom}=require('./usage.cjs');
 const env={NOEVIA_FRONT:'rust',NOEVIA_RUST_AUTH:'1',NOEVIA_RUST_AUTH_CONFIRMED:'1',NOEVIA_RUST_USAGE:'1',NOEVIA_RUST_USAGE_CONFIRMED:'1'};
 assert.equal(enabledFrom(env),true);
 for(const key of Object.keys(env))assert.equal(enabledFrom({...env,[key]:'0'}),false,key);
 const routes=createUsageRoutes({env,json:(res,status,body)=>{res.status=status;res.body=body;},readUsage:()=>{throw Error('Node reporting ran');}});
 for(const path of ['/api/usage','/api/usage/aggregate'])for(const method of ['GET','HEAD','POST','DELETE']){
  const res={};assert.equal(await routes({method},res,{path,authn:{user:{role:'admin'}}}),true);assert.equal(res.status,503);
 }
});
