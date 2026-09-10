const test=require('node:test'),assert=require('node:assert/strict');
const {reportedTokenRate}=require('./engine-stats.cjs');
test('invalid and timer-dominated engine samples are unavailable, not zero or extreme rates',()=>{
 for(const g of [{},{tokens_per_second:NaN,output_tokens:10},{tokens_per_second:Infinity,output_tokens:10},{tokens_per_second:-1,output_tokens:10},{tokens_per_second:0,output_tokens:10},{tokens_per_second:1000000,output_tokens:1},{tokens_per_second:1000000,output_tokens:109},{tokens_per_second:100,output_tokens:20},{tokens_per_second:10,output_tokens:2.5}])assert.equal(reportedTokenRate(g),null);
});
test('sufficiently long finite samples retain the provider rate without an arbitrary speed cap',()=>{
 assert.equal(reportedTokenRate({tokens_per_second:13.18504153409047,output_tokens:109}),13.18504153409047);
 assert.equal(reportedTokenRate({tokens_per_second:10000,output_tokens:20000}),10000);
 assert.equal(reportedTokenRate({tokens_per_second:20,output_tokens:20}),20);
});
