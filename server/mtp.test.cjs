const test=require('node:test'),assert=require('node:assert/strict');
const {capability,loadOptions}=require('./mtp.cjs');
const model={id:'native',recipe:'llamacpp',labels:['mtp'],recipe_options:{ctx_size:32768,llamacpp_backend:'vulkan',llamacpp_args:'--cache-type-k q5_0 --tensor-split 1,1'}};
test('native labels select MTP, unsupported models and invalid values fail closed',()=>{
 assert.equal(capability(model).enabled,true);assert.equal(capability({...model,labels:[]}).supported,false);
 assert.throws(()=>loadOptions({...model,recipe:'other'},true),/does not report/);assert.throws(()=>loadOptions(model,'yes'),/Yes or No/);
});
test('Yes/No replace only speculative type and preserve context, GPU and cache settings',()=>{
 const on=loadOptions(model,true);assert.equal(on.ctx_size,32768);assert.match(on.llamacpp_args,/--tensor-split 1,1/);assert.match(on.llamacpp_args,/--spec-type draft-mtp$/);
 const off=loadOptions({...model,recipe_options:on},false);assert.equal(capability({...model,recipe_options:off}).enabled,false);
 assert.equal((off.llamacpp_args.match(/--spec-type/g)||[]).length,1);assert.match(off.llamacpp_args,/--spec-type none$/);assert.equal(model.recipe_options.llamacpp_args,'--cache-type-k q5_0 --tensor-split 1,1');
});
test('quoted argument values containing flag text are preserved verbatim',()=>{
 const args='--chat-template "literal --spec-type none text" --spec-type=none --tensor-split 1,1';
 const options=loadOptions({...model,recipe_options:{llamacpp_args:args}},true);
 assert.equal(options.llamacpp_args,'--chat-template "literal --spec-type none text"  --tensor-split 1,1 --spec-type draft-mtp');
});
