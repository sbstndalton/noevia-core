const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../../src/useAppearance.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
function harness(){
 let cursor=0,states=[],refs=[],effectDeps,cleanup,effect,listener,shown;
 const calls=[];
 const react={useRef:init=>{const i=cursor++;return refs[i]||(refs[i]={current:init});},useState:init=>{const i=cursor++;if(!(i in states))states[i]=init;return [states[i],next=>states[i]=typeof next==='function'?next(states[i]):next];},useEffect:(fn,deps)=>{if(!effectDeps||deps.some((x,i)=>x!==effectDeps[i])){effect=fn;effectDeps=deps;}}};
 const exports={};
 vm.runInNewContext(code,{exports,document:{documentElement:{dataset:{theme:'dark'}}},window:{addEventListener:(_,fn)=>listener=fn,removeEventListener:()=>{}},require:name=>name==='react'?react:name==='./api'?{apiFetch:(url,init)=>new Promise(resolve=>calls.push({url,init,resolve}))}:{savedPalette:()=> 'cool',resolveMode:v=>v==='system'?'dark':v,applyAppearance:value=>shown={...value},parseAppearance:value=>{if(!value||!value.theme||!value.light||!value.dark)throw Error('Invalid');return value;}}});
 const render=()=>{cursor=0;const result=exports.useAppearance();if(effect){cleanup?.();const run=effect;effect=null;cleanup=run();}return result;};
 const answer=(index,value,ok=true)=>calls[index].resolve({ok,json:async()=>value});
 return {render,calls,answer,changePalette:(mode,palette)=>listener({detail:{mode,palette}}),shown:()=>shown};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('late profile hydration preserves new choices and the other saved mode',async()=>{
 const h=harness();h.render();h.changePalette('dark','iris');
 h.answer(0,{theme:'light',light:'sage',dark:'warm'});await settle();
 assert.deepEqual(h.shown(),{theme:'light',light:'sage',dark:'iris'});
 assert.deepEqual(JSON.parse(h.calls[1].init.body),{theme:'light',light:'sage',dark:'iris'});
});
test('rapid changes save serially with the newest pair last',async()=>{
 const h=harness();h.render();h.answer(0,{theme:'dark',light:'sage',dark:'cool'});await settle();
 h.changePalette('dark','iris');h.changePalette('dark','neutral');
 assert.equal(h.calls.length,2);
 h.answer(1,{theme:'dark',light:'sage',dark:'iris'});await settle();
 assert.equal(h.calls.length,3);assert.equal(JSON.parse(h.calls[2].init.body).dark,'neutral');
});
test('retry after failed save preserves pending selection while reloading profile',async()=>{
 const h=harness();h.render();h.answer(0,{theme:'dark',light:'sage',dark:'cool'});await settle();
 h.changePalette('dark','iris');h.answer(1,{},false);await settle();
 const state=h.render();assert.equal(state.appearanceError,true);state.retryAppearance();h.render();
 h.answer(2,{theme:'dark',light:'sage',dark:'cool'});await settle();
 assert.equal(JSON.parse(h.calls[3].init.body).dark,'iris');
});

test('the server accepts a system appearance preference', () => {
  const { validateAppearance } = require('../../server/appearance.cjs');
  assert.deepEqual(validateAppearance({ theme: 'system', light: 'sage', dark: 'iris' }), { theme: 'system', light: 'sage', dark: 'iris' });
  assert.throws(() => validateAppearance({ theme: 'auto', light: 'sage', dark: 'iris' }));
});
