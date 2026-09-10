const test = require('node:test');
const assert = require('node:assert/strict');
const { projectAppearance } = require('./project-appearance.cjs');
const icons = require('./project-icons.json');
test('legacy projects and unrelated patches do not reset identity', () => {
 assert.deepEqual(projectAppearance({name:'Existing project'}), {});
 assert.deepEqual({...{icon:'book',color:'#579fe5'},...projectAppearance({goal:'Updated'})},{icon:'book',color:'#579fe5'});
});
test('all curated icons and custom hex colors survive normalization', () => {
 for(const icon of Object.keys(icons)) assert.deepEqual(projectAppearance({icon,color:'#ABC123'}),{icon,color:'#abc123'});
 assert.deepEqual(projectAppearance({icon:'folder',color:'default'}),{icon:'folder',color:'default'});
});
test('reject arbitrary SVG, inherited names and CSS injection', () => {
 for(const icon of ['<svg onload=alert(1)>','constructor','__proto__','unknown',null,{}]) assert.throws(()=>projectAppearance({icon}),/supported project icon/);
 for(const color of ['red','#abc','url(https://example.com)','#ffffff;background:red',null,{}]) assert.throws(()=>projectAppearance({color}),/six-digit hex/);
});
test('identity persists across workspace reloads and stays private to its owner', t => {
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const {createWorkspaceStore}=require('./workspace.cjs');
 const {createSecretStore}=require('./secrets.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cowork-identity-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const provider={id:'default',label:'Default',baseUrl:'http://localhost',apiKey:''};
 const store=createWorkspaceStore(root,provider,createSecretStore(root));
 const owner='aaaaaaaa-1111-4111-8111-111111111111';
 const ws=store.get(owner);
 ws.projects.push({id:'project',name:'Test',...projectAppearance({icon:'terminal',color:'#579FE5'})});
 ws.saveProjects();
 const reloaded=createWorkspaceStore(root,provider,createSecretStore(root));
 assert.equal(reloaded.get(owner).projects[0].icon,'terminal');
 assert.equal(reloaded.get(owner).projects[0].color,'#579fe5');
 assert.equal(reloaded.get('bbbbbbbb-2222-4222-8222-222222222222').projects.length,0);
});
