"use strict";
// Synthetic reference corpus for the native reranker settings owner.
const { createRerankSettings, KEY } = require('./fixtures/rerank-settings-reference.cjs');
function oracle() {
  const installed = [{name:'synthetic-reranker',labels:['reranking']},{name:'missing-reranker',missingFile:true}];
  const cases = [
    ['deployment',null], ['invalid-null',null], ['invalid-enabled',{enabled:1}],
    ['unknown',{enabled:true,choice:'unknown'}], ['no-choice',{enabled:true,choice:null}],
    ['tei',{enabled:true,choice:'tei'}], ['llamacpp',{enabled:true,choice:'llamacpp:synthetic-reranker'}],
    ['unreadable',{enabled:true,choice:'llamacpp:synthetic-reranker'}],
    ['reset',null], ['delete',null],
  ];
  return cases.map(([name,input]) => {
    const store = new Map(); const audits=[]; let changes=0;
    const settings=createRerankSettings({store, env:{RERANK_BACKEND:'tei',RERANK_LLAMACPP_BASE_URL:'http://synthetic-engine',NOEVIA_FEATURE_RAG_RERANK:'false'},audit:(...args)=>audits.push(args),onChange:()=>changes++});
    let status=200,body;
    try { body=name==='deployment'?settings.get(installed):['reset','delete'].includes(name)?settings.reset('synthetic-admin',installed):settings.save(input,'synthetic-admin',name==='unreadable'?null:installed); }
    catch(e) {status=e.status||400;body={error:e.status?e.message:'Invalid reranker settings',...(e.messageId?{errorId:e.messageId}:{})};}
    return {name,input,status,body,stored:store.get(KEY)??null,audits,changes};
  });
}
module.exports={oracle};
if(require.main===module) process.stdout.write(JSON.stringify(oracle(),null,2)+'\n');
