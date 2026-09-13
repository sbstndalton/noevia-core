const test = require('node:test'), assert = require('node:assert/strict');
const skills = require('./instruction-skills.cjs');
const file = (body = 'Draft a synthetic review.', meta = 'name: Review\ndescription: Review the notes\nversion: 1') => ({ name: 'review.md', content: `---\n${meta}\n---\n${body}` });
const fixture = () => ({ files: [file(), { name: 'notes.txt', content: 'Ordinary notes.' }], toolboxes: ['core'] });
const enable = p => skills.setSelection(p, {file:'review.md', enabled:true, hash:skills.hash(p.files[0].content)});
test('legacy and new skills need review; both enabled and disabled bodies stay out of sources', () => {
 const p=fixture(); skills.reconcile(p);
 assert.equal(skills.list(p)[0].status,'review'); assert.deepEqual(skills.enabled(p),[]);
 assert.deepEqual(skills.sources(p).map(f=>f.name),['notes.txt']); assert.match(skills.read(p,p.files[0]),/^ERROR/);
 enable(p); assert.equal(skills.enabled(p).length,1); assert.match(skills.read(p,p.files[0]),/Loaded instruction skill/);
 skills.setSelection(p,{file:'review.md',enabled:false}); assert.equal(skills.list(p)[0].status,'disabled');
 assert.match(skills.read(p,p.files[0]),/^ERROR/); assert.equal(skills.sources(p).length,1);
});
test('updates invalidate review and pinned exchanges; removing frontmatter cannot evade exclusion', () => {
 const p=fixture(); skills.reconcile(p); enable(p); const old=skills.hash(p.files[0].content), snapshot=structuredClone(p);
 p.files[0].content+='\nChanged instructions.';
 assert.equal(skills.list(p)[0].status,'updated'); assert.equal(skills.enabled(p).length,0);
 assert.throws(()=>skills.setSelection(p,{file:'review.md',enabled:true,hash:old}),/changed/);
 assert.match(skills.read(snapshot,snapshot.files[0],p),/^ERROR/);
 p.files[0].content='Removed frontmatter';skills.reconcile(p);assert.equal(skills.list(p)[0].status,'invalid'); assert.equal(skills.sources(p).length,1);
 p.files=p.files.slice(1);skills.reconcile(p);assert.deepEqual(Object.keys(p.instructionSkills),[]);
});
test('selection persists per project; missing tools are explained and never enabled', () => {
 const a=fixture(),b=fixture();a.files[0]=file('Use selected tools only.','name: Review\ndescription: Notes\nrequires: nextcloud-notes');skills.reconcile(a);enable(a);
 const saved=JSON.parse(JSON.stringify(a)); assert.equal(skills.enabled(saved).length,1);assert.equal(skills.enabled(b).length,0);
 assert.deepEqual(saved.toolboxes,['core']);assert.match(skills.read(saved,saved.files[0]),/not selected: nextcloud-notes/);
});
test('malformed, duplicate, oversized and executable metadata cannot enable or enter ordinary sources', () => {
 for(const meta of ['name: Review','name: A\nname: B\ndescription: Duplicate','name: A\ndescription: |\n  Multi','name: A\ndescription: B\nrun: sh','name: A\ndescription: '+'x'.repeat(501)]){
  const p={files:[file('Body',meta)]};skills.reconcile(p);assert.equal(skills.list(p)[0].valid,false);assert.equal(skills.sources(p).length,0);assert.throws(()=>enable(p));
 }
 assert.equal(skills.inspect(file('x'.repeat(32769))).valid,false);
 assert.equal(skills.inspect({name:'article.md',content:'---\ntitle: Article\n---\nOrdinary content'}),null);
});
test('catalogue overflow rejects enablement rather than silently omitting selected skills',()=>{
 const p={files:Array.from({length:20},(_,i)=>({...file('Body','name: '+'n'.repeat(160)+'\ndescription: '+'d'.repeat(500)),name:`skill-${i}.md`}))};skills.reconcile(p);let rejected=false;
 for(const f of p.files){try{skills.setSelection(p,{file:f.name,enabled:true,hash:skills.hash(f.content)});}catch(e){assert.match(e.message,/context limit/);rejected=true;break;}}
 assert.ok(rejected);assert.throws(()=>skills.setSelection(p,{file:'../other.md',enabled:true,hash:''}),/No such/);
});
test('excluded skill vectors never re-enter retrieval or fallback context',async()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const source=fs.readFileSync(require.resolve('./rag.cjs'),'utf8');
 const body=source.slice(source.indexOf('async function filesContext('),source.indexOf('\nmodule.exports'));
 const p=fixture();p.files.push({name:'long.txt',content:'ORDINARY-LONG '.repeat(300)});skills.reconcile(p);
 for(const available of [true,false]){
  const context={DIRECT_INJECT_MAX:2400,documentNotice:()=>'',ragAvailable:()=>available,searchProject:async()=>[{file:'review.md',body:'FORBIDDEN-SKILL-VECTOR'},{file:'removed.md',body:'REMOVED-SOURCE'}]};
  vm.createContext(context);vm.runInContext(body,context);
  const text=await context.filesContext('project',skills.sources(p),'query','tenant');
  assert.ok(!text.includes('FORBIDDEN'));assert.ok(!text.includes('REMOVED'));assert.ok(!text.includes('review.md'));assert.match(text,/Ordinary notes/);assert.match(text,/ORDINARY-LONG/);
 }
});
test('long skill reads paginate and never claim a partial body was fully loaded',()=>{
 const p=fixture();p.files[0]=file('PAGINATED-BODY '.repeat(700));skills.reconcile(p);enable(p);
 const first=skills.read(p,p.files[0],p,0,8000);assert.match(first,/Loaded part/);const offset=Number(/Continue with offset (\d+)/.exec(first)[1]);assert.ok(offset>0);assert.ok(first.length<=8000);
 assert.match(skills.read(p,p.files[0],p,offset,8000),/PAGINATED-BODY/);assert.match(skills.read(p,p.files[0],p,-1),/^ERROR/);
});
