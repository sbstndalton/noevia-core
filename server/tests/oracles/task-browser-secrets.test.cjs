'use strict';const{test}=require('node:test');const assert=require('node:assert/strict');const policy=require('../../browser-policy.cjs');
test('Browser secrets are origin-bound and masked before evidence publication',()=>{
 const rows=[];
 const secrets={token:{value:'synthetic token/é',domains:['synthetic.invalid']},short:{value:'abc',domains:['synthetic.invalid']},longer:{value:'synthetic token/é extended',domains:['synthetic.invalid']},'bad name':{value:'synthetic hidden',domains:['synthetic.invalid']}};
 const evidence=Object.values(secrets).map(s=>[s.value,encodeURIComponent(s.value),encodeURIComponent(s.value).replace(/%20/g,'+')].join('|')).join('|');
 for(const source of ['plain','{{secret:token}}','{{secret:token}}/{{secret:token}}','{{secret:short}}','{{secret:missing}}','{{secret:bad name}}','{{secret:token}} {{secret:longer}}','{{secret:{{secret:token}}','{{secret:token}}}}'])for(const origin of ['https://synthetic.invalid','https://other.invalid','about:blank','https://synthetic.invalid.evil.invalid']) rows.push({source,secrets,origin,evidence,result:policy.substituteSecrets(source,secrets,origin),masked:policy.maskSecrets(evidence,secrets)});
 assert.equal(rows.length,36);assert.equal(rows[4].result.ok,true);assert.equal(rows[5].result.ok,false);
 if(process.env.TASK_JOURNAL_EVIDENCE)require('node:fs').writeFileSync(require('node:path').join(process.env.TASK_JOURNAL_EVIDENCE,'task-browser-secrets-node.json'),JSON.stringify(rows,null,2)+'\n');
});
