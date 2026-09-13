const test=require('node:test'),assert=require('node:assert/strict');
const {validateRates,mergeUsage,summarizeUsage}=require('./usage-summary.cjs');
const options={now:new Date(2026,8,13,12),retentionDays:30,dayKey:d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
const store={days:{'2026-09-13':{input:1000000,output:500000,replies:2,models:{known:{input:1000000,output:500000,replies:2}}},'2025-01-01':{input:99,models:{old:{input:99}}}}};
test('cost estimates use explicit rates and retained history consistently',()=>{
 const result=summarizeUsage(store,{...options,pricing:validateRates({currency:'USD',rates:[{model:'known',inputPerMillion:2,outputPerMillion:8}]})});
 assert.equal(result.costs.last7.amount,6);assert.equal(result.allTime.input,1000000);assert.equal(result.models.length,1);assert.equal(result.models[0].name,'known');
 assert.equal(result.last7.replies,2);assert.equal(result.activeDays,1);
});
test('missing prices and unattributed usage cannot look like zero-cost billing',()=>{
 const result=summarizeUsage(store,options);assert.equal(result.costs.last7.amount,null);assert.deepEqual(result.costs.last7.unpricedModels,['known']);
 const partial=structuredClone(store);partial.days['2026-09-13'].input+=50;
 assert.equal(summarizeUsage(partial,{...options,pricing:{currency:'USD',rates:[{model:'known',inputPerMillion:0,outputPerMillion:0}]}}).costs.last7.unattributedTokens,50);
});
test('aggregation only carries numeric metrics and prevents prototype-shaped model keys',()=>{
 const dangerous=JSON.parse('{"days":{"2026-09-13":{"input":-20,"output":4,"replies":1,"prompt":"PRIVATE","models":{"__proto__":{"input":3,"output":4}}}}}');
 const merged=mergeUsage([store,dangerous]);assert.equal(merged.days['2026-09-13'].input,1000000);assert.equal(merged.days['2026-09-13'].output,500004);
 assert.equal({}.input,undefined);assert.ok(!JSON.stringify(merged).includes('PRIVATE'));
});
test('rate validation rejects duplicates, invalid numbers and excessive lists',()=>{
 for(const value of [-1,Infinity,NaN,'3',100001])assert.throws(()=>validateRates({currency:'USD',rates:[{model:'a',inputPerMillion:value,outputPerMillion:0}]}));
 assert.throws(()=>validateRates({currency:'USD',rates:[{model:'a',inputPerMillion:0,outputPerMillion:0},{model:'a',inputPerMillion:1,outputPerMillion:1}]}));
 assert.throws(()=>validateRates({currency:'US',rates:[]}));assert.throws(()=>validateRates({currency:'USD',rates:Array(201).fill({})}));
});
