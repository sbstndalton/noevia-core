const test=require('node:test'),assert=require('node:assert/strict');
const {describeMcpServers}=require('./mcp-status.cjs');
test('catalogue status counts unique missing tools against the owning server without exposing URLs or tokens',()=>{
 const servers=[{id:'a',url:'http://private.example',auth:'none',token:'not-for-clients'},{id:'b',auth:'none'}];
 const states=new Map([['a',{toolCount:2,discoveredAt:123,error:null}],['b',{toolCount:0,discoveredAt:124,error:'Unavailable'}]]);
 const tools=new Map([['one',{serverId:'a'}],['other-owner',{serverId:'b'}]]);
 const manifest=[{server:'a',tools:['one','missing','other-owner']},{server:'a',tools:['missing']}];
 const result=describeMcpServers(servers,states,tools,manifest);
 assert.equal(result[0].missingCurated,2);assert.equal(result[0].checkedAt,123);
 assert.equal(result[1].error,'Unavailable');assert.equal(result[1].discovered,0);
 assert.ok(!JSON.stringify(result).includes('private.example'));assert.ok(!JSON.stringify(result).includes('not-for-clients'));
});
