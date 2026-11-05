'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {capture}=require('./fixtures/model-pull-oracle.cjs');
const cases=require('./fixtures/model-pull-node.json');
for(const c of cases)test(`pull policy oracle: ${c.name}`,async()=>assert.deepEqual(await capture(c),c.expected));
