'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {formatSkillIndex}=require('./skill-index.cjs');
test('skill metadata supplies the exact loadable filename independently of its display name',()=>{
 const file='Weekly notes "review".md';const line=formatSkillIndex([{file,name:'Project review',description:'Summarize decisions',version:'1',content:'PRIVATE FULL BODY'}]);
 assert.equal(JSON.parse(line).file,file);assert.equal(JSON.parse(line).name,'Project review');assert.ok(!line.includes('PRIVATE FULL BODY'));
});
test('skill catalogue bounds metadata and count without changing included filenames',()=>{
 const skills=Array.from({length:100},(_,i)=>({file:`skill-${i}.md`,name:'n'.repeat(10000),description:'d'.repeat(10000),version:'v'.repeat(1000)}));
 const result=formatSkillIndex(skills),lines=result.split('\n');assert.ok(result.length<6300);assert.match(lines.at(-1),/omitted/);
 for(const line of lines.slice(0,-1)){const entry=JSON.parse(line);assert.ok(skills.some(s=>s.file===entry.file));assert.equal(entry.name.length,160);assert.equal(entry.description.length,500);assert.equal(entry.version.length,80);}
});
test('unrepresentable filenames are omitted and control characters cannot forge metadata rows',()=>{
 const result=formatSkillIndex([{file:'x'.repeat(501),name:'bad'},{file:'valid.md',name:'First\nSecond',description:'line\r\nline'}]);
 const lines=result.split('\n');assert.equal(lines.length,2);assert.equal(JSON.parse(lines[0]).name,'First\nSecond');assert.match(lines[1],/1 additional/);
});
