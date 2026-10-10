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

test('tool calls and peak hour summarize only what was recorded',()=>{
 const withCounters={days:{'2026-09-13':{input:10,output:5,replies:3,models:{known:{input:10,output:5,replies:3}},
   tools:{read_project_file:4,nc_notes_search:1},hours:{9:1,14:2}},
  '2026-09-12':{input:1,output:1,replies:1,models:{},tools:{read_project_file:2},hours:{14:1}}}};
 const result=summarizeUsage(withCounters,options);
 assert.deepEqual(result.tools,[{name:'read_project_file',calls:6},{name:'nc_notes_search',calls:1}]);
 assert.deepEqual(result.peakHour,{hour:14,replies:3});
 assert.equal(result.hours.length,24);assert.equal(result.hours[14],3);assert.equal(result.hours[0],0);
});
test('a file written before tool and hour counters existed reads as empty, not broken',()=>{
 const result=summarizeUsage(store,options);
 assert.deepEqual(result.tools,[]);assert.equal(result.peakHour,null);
 assert.deepEqual(result.hours,Array.from({length:24},()=>0));
});
test('merged counters stay numeric and cannot carry prototype-shaped tool names',()=>{
 const dangerous=JSON.parse('{"days":{"2026-09-13":{"replies":1,"tools":{"__proto__":{"x":1},"nc_notes_create":-5},"hours":{"14":"many"}}}}');
 const merged=mergeUsage([{days:{'2026-09-13':{replies:1,tools:{nc_notes_create:2},hours:{14:1}}}},dangerous]);
 assert.equal(merged.days['2026-09-13'].tools.nc_notes_create,2);
 assert.equal(merged.days['2026-09-13'].hours[14],1);
 assert.equal({}.x,undefined);
});

test('aggregate model ties and fractional sums follow account order, not file completion (#1281)',async()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noevia-usage-order-'));
 const read=fs.promises.readFile;
 try{
  for(const [id,n]of [['a',Number.MAX_SAFE_INTEGER],['b',0.5],['c',0.5]]){
   fs.mkdirSync(path.join(dir,id));fs.writeFileSync(path.join(dir,id,'usage.json'),JSON.stringify({days:{'2026-09-13':{input:n,models:{[id]:{input:1}}}}}));
  }
  const {aggregateUsage}=require('./usage-summary.cjs');
  for(const slow of ['a','b']){
   fs.promises.readFile=async(...args)=>{if(path.basename(path.dirname(args[0]))===slow)await new Promise(resolve=>setTimeout(resolve,15));return read.apply(fs.promises,args);};
   const result=await aggregateUsage(['a','b','c'].map(id=>({id})),id=>path.join(dir,id),slow==='a'?100000:140000);
   assert.deepEqual(summarizeUsage(result.store,options).models.map(x=>x.name),['a','b','c']);
   assert.equal(result.unreadableAccounts,0);
  }
 }finally{fs.promises.readFile=read;fs.rmSync(dir,{recursive:true,force:true});}
});
