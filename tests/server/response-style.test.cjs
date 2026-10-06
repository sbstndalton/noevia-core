const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../../src/response-style.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const ex={};vm.runInNewContext(code,{exports:ex});
const server=require('../../server/account-instructions.cjs');
const combos=[{style:'default',advanced:{length:'auto',tone:'auto',formatting:'auto',emoji:'auto'},language:''},{style:'concise',advanced:{length:'short',tone:'formal',formatting:'minimal',emoji:'none'},language:'Norwegian'},{style:'detailed',advanced:{length:'long',tone:'casual',formatting:'structured',emoji:'some'},language:''}];
test('the Settings preview is exactly what the server sends',()=>{
 for(const c of combos)assert.equal(JSON.stringify(ex.styleLines(c)),JSON.stringify(server.styleLines(c)),JSON.stringify(c));
 for(const key of Object.keys(ex.ADVANCED))assert.equal(ex.ADVANCED[key].options.map(o=>o[0]).join(),server.ADVANCED[key].join(),key);
});
test('old Default/Concise/Detailed records migrate to the same preset with every advanced control on auto',()=>{
 const n=ex.normaliseStyle({text:'x',style:'concise',updatedAt:1});
 assert.equal(n.style,'concise');assert.equal(Object.values(n.advanced).every(v=>v==='auto'),true);assert.equal(n.language,'');
 assert.equal(ex.normaliseStyle({style:'shouty',advanced:{tone:'loud'}}).style,'default');
 assert.equal(ex.normaliseStyle({advanced:{tone:'loud'}}).advanced.tone,'auto');
 assert.equal(ex.isDefaultStyle(ex.normaliseStyle(null)),true);
 assert.equal(ex.isDefaultStyle({...ex.normaliseStyle(null),language:'German'}),false);
});
