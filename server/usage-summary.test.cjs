const test=require('node:test'),assert=require('node:assert/strict');
const {mergeUsage,summarizeUsage}=require('./usage-summary.cjs');
const options={now:new Date(2026,8,13,12),retentionDays:30,dayKey:d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
const store={days:{'2026-09-13':{input:1000000,output:500000,replies:2,models:{known:{input:1000000,output:500000,replies:2}}},'2025-01-01':{input:99,models:{old:{input:99}}}}};
test('totals, per-model breakdown and streaks cover only the retained window',()=>{
 const result=summarizeUsage(store,options);
 assert.equal(result.allTime.input,1000000);
 // The 2025 day is outside the 30-day retention window, so `old` is absent.
 assert.equal(result.models.length,1);assert.equal(result.models[0].name,'known');
 assert.equal(result.last7.replies,2);assert.equal(result.activeDays,1);
 assert.equal(result.currentStreak,1);assert.equal(result.longestStreak,1);
});
test('usage reports tokens and replies, never money',()=>{
 // Cost estimation was removed: a self-hosted box running local GGUFs has no
 // provider bill, and the old panel's own disclaimer excluded hardware and
 // electricity — which is most of the actual cost. This asserts the shape
 // stays free of it rather than growing a half-right money figure again.
 const result=summarizeUsage(store,options);
 for(const key of ['costs','currency','pricing','rates'])assert.ok(!(key in result),`${key} is back in the usage summary`);
 assert.ok(!JSON.stringify(result).toLowerCase().includes('permillion'));
});
test('aggregation only carries numeric metrics and prevents prototype-shaped model keys',()=>{
 const dangerous=JSON.parse('{"days":{"2026-09-13":{"input":-20,"output":4,"replies":1,"prompt":"PRIVATE","models":{"__proto__":{"input":3,"output":4}}}}}');
 const merged=mergeUsage([store,dangerous]);assert.equal(merged.days['2026-09-13'].input,1000000);assert.equal(merged.days['2026-09-13'].output,500004);
 assert.equal({}.input,undefined);assert.ok(!JSON.stringify(merged).includes('PRIVATE'));
});
