const test = require('node:test'), assert = require('node:assert/strict');
const skipWasm = !require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
// Guards a wrong test signature (options passed twice makes node:test take the second object as the body, so the body never runs and the
// test reports ok): when the module is there, every guarded body must have run.
let ran = 0;
const skills = require('./instruction-skills.cjs');
const file = (body = 'Draft a synthetic review.', meta = 'name: Review\ndescription: Review the notes\nversion: 1') => ({ name: 'review.md', content: `---\n${meta}\n---\n${body}` });
const fixture = () => ({ files: [file(), { name: 'notes.txt', content: 'Ordinary notes.' }], toolboxes: ['core'] });
// What the Rust front's PUT /instruction-skills stores for a selection (noevia-rs crates/server-projects
// instruction_skills.rs `set_selection`, whose refusals - a stale hash, a bundled script, the context limit, an
// unknown file - and whose manifest resolution are tested there, #2191 round 9). The selection is project data
// this module reads back, so these tests write it directly.
const select = (p, name, enabled, hash) => {
  const kept = p.instructionSkills?.[name]?.reviewedHash;
  p.instructionSkills = { ...p.instructionSkills, [name]: { enabled, reviewedHash: enabled ? hash : (kept || skills.hash(p.files.find(f => f.name === name).content)), reviewedAt: 1 } };
};
const enable = p => select(p, 'review.md', true, skills.hash(p.files[0].content));
test('legacy and new skills need review; both enabled and disabled bodies stay out of sources', () => {
 const p=fixture(); skills.reconcile(p);
 assert.equal(skills.list(p)[0].status,'review'); assert.deepEqual(skills.enabled(p),[]);
 assert.deepEqual(skills.sources(p).map(f=>f.name),['notes.txt']); assert.match(skills.read(p,p.files[0]),/^ERROR/);
 enable(p); assert.equal(skills.enabled(p).length,1); assert.match(skills.read(p,p.files[0]),/Loaded instruction skill/);
 select(p,'review.md',false); assert.equal(skills.list(p)[0].status,'disabled');
 assert.match(skills.read(p,p.files[0]),/^ERROR/); assert.equal(skills.sources(p).length,1);
});
test('updates invalidate review and pinned exchanges; removing frontmatter cannot evade exclusion', () => {
 const p=fixture(); skills.reconcile(p); enable(p); const snapshot=structuredClone(p);
 p.files[0].content+='\nChanged instructions.';
 assert.equal(skills.list(p)[0].status,'updated'); assert.equal(skills.enabled(p).length,0);
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
 for(const meta of ['name: Review','name: A\nname: B\ndescription: Duplicate','name: A\ndescription: |\n  Multi','name: A\ndescription: B\nrun: sh','name: A\ndescription: '+'x'.repeat(1025),'name: A\ndescription: B\nmetadata: x']){
  const p={files:[file('Body',meta)]};skills.reconcile(p);assert.equal(skills.list(p)[0].valid,false);assert.equal(skills.sources(p).length,0);enable(p);assert.equal(skills.enabled(p).length,0,'an invalid skill is never enabled');
 }
 assert.equal(skills.inspect(file('x'.repeat(32769))).valid,false);
 assert.equal(skills.inspect({name:'article.md',content:'---\ntitle: Article\n---\nOrdinary content'}),null);
});
test('excluded skill vectors never re-enter retrieval or fallback context',async()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const source=fs.readFileSync(require.resolve('./rag.cjs'),'utf8');
 const body=source.slice(source.indexOf('async function filesContext('),source.indexOf('\nmodule.exports'));
 const p=fixture();p.files.push({name:'long.txt',content:'ORDINARY-LONG '.repeat(300)});skills.reconcile(p);
 for(const available of [true,false]){
  const context={DIRECT_INJECT_MAX:2400,FILES_CONTEXT_MAX_CHARS:120000,LARGE_FILE_HEAD:24000,documentNotice:()=>'',frameUntrusted:require('./prompt-framing.cjs').frameUntrusted,...require('./quoted-name.cjs'),ragAvailable:()=>available,searchProject:async()=>[{file:'review.md',body:'FORBIDDEN-SKILL-VECTOR'},{file:'removed.md',body:'REMOVED-SOURCE'}]};
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
test('published skills with license/compatibility fields and a long description are valid', () => {
  const p={files:[file('Body','name: pdf\ndescription: '+'d'.repeat(900)+'\nlicense: Proprietary. LICENSE.txt has complete terms\ncompatibility: any')]};skills.reconcile(p);
  assert.equal(skills.list(p)[0].valid,true,skills.list(p)[0].error);
});
test('an ordinary note with a Name: line in the body (not the frontmatter) is not a skill candidate and reaches rag', () => {
 const note={name:'meeting.md',content:'---\ntitle: Meeting\n---\nName: Alice'};
 assert.equal(skills.inspect(note),null);
 const p={files:[note]};skills.reconcile(p);
 assert.deepEqual(Object.keys(p.instructionSkills),[]);
 assert.deepEqual(skills.sources(p).map(f=>f.name),['meeting.md']);
});
test('a genuine skill with name/description in frontmatter is still detected', () => {
 assert.equal(skills.inspect(file()).valid,true);
});
test('portable manifests have stable project-scoped IDs and metadata only (their content route is the Rust front\'s, #2191 round 9)', () => {
 const a={id:'owner-a',...fixture()}, b={id:'owner-b',...fixture()};
 skills.reconcile(a); skills.reconcile(b);
 const before=skills.manifests(a,['core'])[0];
 assert.equal(before.schemaVersion,1);assert.equal(before.status,'review');
 assert.equal(JSON.stringify(before).includes('Draft a synthetic review.'),false);
 assert.notEqual(before.id,skills.manifests(b,['core'])[0].id);
 assert.equal(before.version,skills.hash(a.files[0].content));
 enable(a);
 const ready=skills.manifests(a,['core'])[0];assert.equal(ready.id,before.id);assert.equal(ready.resolvable,true);
 select(a,'review.md',false);
 assert.equal(skills.manifests(a,['core'])[0].status,'disabled');
 enable(a);a.files[0].content+=' updated';
 assert.equal(skills.manifests(a,['core'])[0].status,'updated');
});
test('unsupported requirements block portable resolution without granting or selecting tools', () => {
 const p={id:'p',files:[file('Body','name: Review\ndescription: Notes\nrequires: unavailable-box')],toolboxes:['core']};
 skills.reconcile(p);enable(p);
 const manifest=skills.manifests(p,['core'])[0];
 assert.deepEqual(manifest.requirements.unsupportedToolboxes,['unavailable-box']);
 assert.deepEqual(manifest.requirements.unselectedToolboxes,[]);
 assert.equal(manifest.resolvable,false);
 assert.deepEqual(p.toolboxes,['core']);
 const known=skills.manifests(p,['core','unavailable-box'])[0];
 assert.deepEqual(known.requirements.unselectedToolboxes,['unavailable-box']);
 assert.equal(known.resolvable,true);
});
test('published provenance is shown only for the exact copied artifact', () => {
 const p={id:'p',files:[file()],toolboxes:['core']};
 const digest=skills.hash(p.files[0].content);
 p.files[0].skillOrigin={kind:'published',publisher:'Anthropic',repository:'https://github.com/anthropics/skills',sourceRef:'main',digest,retrievedAt:'2026-09-27T00:00:00.000Z'};
 skills.reconcile(p);
 assert.equal(skills.manifests(p,['core'])[0].origin.digest,digest);
 p.files[0].content+='\nLocal edit';
 assert.deepEqual(skills.manifests(p,['core'])[0].origin,{kind:'project-file'});
});
test('a formerly-recorded candidate note is released by reconcile once it no longer matches', () => {
 const note={name:'meeting.md',content:'---\nname: Meeting\n---\nBody text.'};
 const p={files:[note]};skills.reconcile(p);
 assert.deepEqual(Object.keys(p.instructionSkills),['meeting.md']);
 note.content='---\ntitle: Meeting\n---\nName: Alice';
 skills.reconcile(p);
 assert.deepEqual(Object.keys(p.instructionSkills),[]);
 assert.deepEqual(skills.sources(p).map(f=>f.name),['meeting.md']);
});

test('#1006 review: missing tools follow Tools Automatic, not the stored hand-picked list', { skip: skipWasm }, ()=>{
  ran++;
  const f=file('Body','name: Review\ndescription: Notes\nrequires: web');
  assert.deepEqual(skills.inspect(f,{toolboxes:['core','web']}).missingTools,[]);
  assert.deepEqual(skills.inspect(f,{toolsMode:'auto',toolboxes:['core','web']}).missingTools,['web'],'Automatic sends the default set');
  assert.deepEqual(skills.inspect(f,{}).missingTools,['web']);
});

test.after(() => { if (!skipWasm) assert.equal(ran, 1, 'a wasm-guarded test body did not run'); });
