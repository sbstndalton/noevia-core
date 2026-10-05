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

test('#366: `directory` marks a server added through the MCP directory; everything else defaults false',()=>{
 const servers=[{id:'internal',auth:'internal'},{id:'nextcloud',auth:'nextcloud'},{id:'added-one',auth:'directory',directory:true}];
 const states=new Map();
 const result=describeMcpServers(servers,states,new Map(),[]);
 assert.deepEqual(result.map(r=>r.directory),[false,false,true]);
});

test('#887: a directory server\'s title is reported (bounded) so the approval card can name it; others carry none',()=>{
 const servers=[{id:'dir-a',auth:'oauth',directory:true,title:'Notes '+'x'.repeat(200),url:'https://private.example'},{id:'nextcloud',auth:'nextcloud'}];
 const result=describeMcpServers(servers,new Map(),new Map(),[]);
 assert.equal(result[0].title.length,80);assert.ok(result[0].title.startsWith('Notes '));
 assert.equal('title' in result[1],false);
 assert.ok(!JSON.stringify(result).includes('private.example'));
});
